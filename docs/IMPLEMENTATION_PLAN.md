# Implementation Plan: Chat-First Agent Refactor

**Date:** 2026-05-08  
**Status:** Approved

## Problem

The current UI is a multi-panel, manual step-by-step workflow: KB upload → JD entry → gap analysis → tailoring plan → CV generation → cover letter. Each step requires explicit user action and understanding of the flow. The result is a cumbersome experience that exposes implementation details rather than guiding the user.

## Goal

Replace the current UI with a single chat window where an AI agent guides the user through the entire CV tailoring process. The agent drives the flow dynamically, uses tools internally, and surfaces multiple-choice options as clickable buttons. The knowledge base moves to a collapsible sidebar.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │  KB Sidebar  │  │         Chat Window              │ │
│  │ (collapsible)│  │  ┌────────────────────────────┐  │ │
│  │              │  │  │  Agent message             │  │ │
│  │ [browse btn] │  │  │  [Button A] [Button B]     │  │ │
│  │ file list    │  │  ├────────────────────────────┤  │ │
│  │ storage meter│  │  │  Tool: generate_cv ──────  │  │ │
│  │ [delete all] │  │  ├────────────────────────────┤  │ │
│  │              │  │  │  Agent message (streaming) │  │ │
│  └──────────────┘  │  └────────────────────────────┘  │ │
│                    │  ┌──[text input]──────[Send]────┐ │ │
│                    │  └─────────────────────────────┘ │ │
│                    └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         │ WebSocket /agents/cv-agent/{workspaceId}
         │ POST /api/knowledge (file upload, unchanged)
         ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Worker (fetch handler)                       │
│  routeAgentRequest → CvAgent (Durable Object)           │
│  /api/knowledge, /api/status, /api/health (unchanged)   │
└─────────────────────────────────────────────────────────┘
         │                    │                  │
         ▼                    ▼                  ▼
  CvAgent (DO)          CvWorkflow           Cloudflare D1
  AIChatAgent base    Cloudflare Workflow    - KB files
  - chat history        - create_tailoring   - token budget
  - agent scratchpad      _plan              - workspaces
  - light tools inline  - generate_cv        - pending
  - triggers Workflow   - generate_cover       workflows
  - WS broadcast          _letter
  ← callback from WF   5 min CPU per step
         │
         ▼
    Workers AI (model inference)
```

### Long-running AI: current vs new

**Before (current code):** plain SSE `ReadableStream`. No CPU time strategy. Relies on the operation finishing within the Worker wall-clock window.

**WebSocket hibernation:** keeps a WebSocket alive while a DO sleeps between messages, but does *not* extend the CPU budget for a single activation. It does not solve the long-generation problem.

**Cloudflare Workflows (new):** each Workflow step gets up to 5 minutes of CPU. The three heavy generation steps (`create_tailoring_plan`, `generate_cv`, `generate_cover_letter`) run as Workflow steps. The DO triggers the Workflow, returns immediately (activation ends), and receives a callback when done. See ADR-010.

## Storage Strategy

| Data | Backend | Notes |
|------|---------|-------|
| Chat message history | **DO/SQLite** via `AIChatAgent` | Persisted server-side; survives refresh |
| Agent scratchpad (JD text, plan, AI guideline, CV language) | **DO/SQLite** via Agent Memory writable context | Injected into system prompt each turn |
| Knowledge base files | **D1** (`cv_knowledge_files`) | Unchanged from current |
| Token budget | **D1** (`cv_daily_tokens`) | Unchanged |
| Workspace identity | **D1** (`cv_workspaces`) | Unchanged |
| (Future) Semantic KB retrieval | **Vectorize** + DO | Deferred; only needed if KB grows large |

---

## Removed Features

| Feature | Reason |
|---------|--------|
| CV style selector (German/English) | Agent infers language from JD (ADR-007) |
| Company URL fetch button | Subsumed into agent `search_company` tool |
| Gap analysis button | Agent calls `analyze_gaps` tool dynamically |
| Tailoring plan section | Inline in chat flow |
| CV generation section | Agent calls `generate_cv` tool |
| Cover letter section | Agent calls `generate_cover_letter` tool |
| Profile import field in sidebar | Via agent chat only (ADR-006) |
| Separate API endpoints for each step | Replaced by `/api/chat` (ADR-002) |
| Old screenshot in docs | Outdated; delete during Phase 0 |

---

## Agent Tools

The AI model has access to the following tools, called dynamically via `streamText` with `maxSteps`:

| Tool | Description |
|------|-------------|
| `fetch_jd` | Fetches and extracts text from a job description URL |
| `analyze_gaps` | Compares KB content with JD; returns questions for the user |
| `create_tailoring_plan` | Generates a Markdown tailoring plan (emphasize/reduce/omit) |
| `generate_cv` | Generates final Markdown CV; infers language from JD |
| `generate_cover_letter` | Generates Markdown cover letter with tone guidance |
| `search_company` | Auto-searches company from JD or fetches URL; also searches for AI usage guidelines (ADR-009) |
| `import_profile` | Imports GitHub / LinkedIn / Xing / X profile into KB |

### Company AI Guideline Flow (ADR-009)

`search_company` runs two fetches in parallel:
1. General company/careers page
2. Company AI candidate policy (search terms: "AI candidate guidance", "artificial intelligence hiring policy")

If no company policy is found → inject Anthropic's default: https://www.anthropic.com/candidate-ai-guidance

The found/default guideline text is stored in Agent Memory (writable scratchpad) and prepended to the system prompt for all subsequent generation steps.

---

## WebSocket Message Protocol

The client connects via WebSocket to `/agents/cv-agent/{workspaceId}`. Transport is managed by `AIChatAgent` / `agents` SDK. Structured events are sent via `this.broadcast()` alongside the AI SDK's streaming text chunks:

```jsonc
// Structured events (JSON, via broadcast)
{"type": "tool_start",  "tool": "fetch_jd",  "args": {"url": "..."}}
{"type": "tool_end",    "tool": "fetch_jd",  "summary": "Fetched 3 400 chars from acme.com"}
{"type": "choices",     "options": ["Analyse gaps", "Search company info", "Skip"]}
{"type": "preview",     "content_type": "cv",  "content": "# John Doe\n..."}
{"type": "guideline",   "source": "company" | "default",  "summary": "..."}
{"type": "budget",      "remaining": 480000,  "total": 500000}
{"type": "error",       "message": "Token budget exceeded"}

// Text streaming (AI SDK UIMessageStream, interleaved)
// The client's useAgentChat / WS handler distinguishes by message shape
```

User messages are sent as plain text over the WebSocket. The client does NOT maintain a messages array — the server (DO) owns the history.

---

## Implementation Phases

### Phase 0 — Cleanup & Prep

- [ ] Delete `docs/cv-tailoring-workspace-screenshot.png`
- [ ] Remove old API route handlers from `src/worker.ts`:
  - `handleAnalyzeGaps`
  - `handleTailoringPlan`
  - `handleRefinePlan`
  - `handleGenerateCv`
  - `handleGenerateCoverLetter`
  - `handleCompanyFetch`
  - `handleImportProfile`
  - `handleClarifications`
- [ ] Remove dead route registrations (`/api/analyze-gaps`, `/api/tailoring-plan`, etc.)
- [ ] Remove CV style state from any shared helpers

**Outcome:** Cleaner worker.ts; old behaviour gone; existing KB endpoints untouched.

---

### Phase 1 — Backend: Agents SDK + `CvAgent` + `CvWorkflow`

- [ ] Install packages: `agents`, `@cloudflare/ai-chat`, `ai`, `workers-ai-provider`
- [ ] Add bindings to `wrangler.toml`:
  ```toml
  [[durable_objects.bindings]]
  name = "CvAgent"
  class_name = "CvAgent"

  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["CvAgent"]

  [[workflows]]
  name     = "cv-workflow"
  binding  = "CV_WORKFLOW"
  class_name = "CvWorkflow"

  [workflows.limits]
  cpu_ms = 300_000   # 5 minutes per step
  steps  = 50
  ```
- [ ] Create `src/agent.ts` — `CvAgent extends AIChatAgent<Env>`:
  - `onChatMessage(onFinish)` — calls `streamText` with **light tools only** + `maxSteps: 5`
  - Adds a `start_generation` tool that triggers `CvWorkflow` (instead of running AI generation inline)
  - `broadcast()` structured events alongside AI text stream
  - `fetch("/workflow-done", ...)` handler — receives Workflow callback, broadcasts `preview` event
  - Load KB from D1 each turn; inject into system prompt
  - Track token usage; check/update D1 budget table
- [ ] Create `src/workflow.ts` — `CvWorkflow extends WorkflowEntrypoint`:
  - Step 1: `load-context` — load KB from D1 (< 30s, light)
  - Step 2: `ai-generate` — run the heavy AI call (up to 4 min; retries: 2)
  - Step 3: `update-budget` — write token usage to D1
  - Step 4: `notify-agent` — POST callback to DO `/workflow-done`
- [ ] Define **light** tool schemas and executors in `src/tools.ts`:
  - `fetch_jd(url)` — fetch + strip HTML
  - `analyze_gaps(jd)` — AI sub-call with KB context
  - `search_company(companyName?, url?)` — parallel fetches + AI guideline search; stores in scratchpad; `broadcast guideline`
  - `import_profile(url)` — scraping logic, writes to D1 KB
  - `start_generation(tool, params)` — creates `CvWorkflow`, broadcasts `tool_start`, returns `{ workflowId }`
- [ ] Update Worker `fetch` handler: route `/agents/*` via `routeAgentRequest`; keep KB/status/health routes
- [ ] Agent system prompt (base, prepended with guideline when available):
  ```
  You are a professional CV tailoring assistant. Guide the user dynamically.
  Capabilities: fetch JDs, analyse skill gaps, create tailoring plans, generate
  CVs and cover letters, research companies and their AI hiring policies.
  Infer CV language from JD language. Offer choices as "choices" broadcast events.
  Adhere to the active AI guideline stored in your context.
  For generate_cv / generate_cover_letter / create_tailoring_plan: call start_generation.
  ```
- [ ] Agent Memory scratchpad keys: `jd_text`, `jd_source`, `company_name`, `company_summary`, `ai_guideline`, `cv_language`, `tailoring_plan`, `pending_workflow_id`

---

### Phase 2 — Frontend: Collapsible KB Sidebar

- [ ] Move KB section into a collapsible `<aside>` (left panel, default open)
- [ ] Add toggle button (`<<` / `>>`) to collapse/expand
- [ ] Remove "Upload Files" button — `<input type="file">` is triggered directly by a "Browse" link/button that opens the picker immediately
- [ ] Remove "Import public profile" URL field and button
- [ ] Keep: file list with delete buttons, storage meter, "Delete all data" button
- [ ] Accepted file types: `.md` only (KB stays Markdown-only)

---

### Phase 3 — Frontend: Chat Window

- [ ] Render chat message list (scrollable, newest at bottom)
- [ ] Three message bubble types:
  - **User** — right-aligned, solid background
  - **Agent** — left-aligned, with optional streaming cursor
  - **Tool** — full-width system bar: `⚙ fetch_jd → Fetched 3 400 chars from acme.com`
- [ ] Multiple-choice rendering: after an agent message, render `<button>` chips for each option; clicking sends the option text as a user message and disables all chips
- [ ] JD input flow:
  - Agent message says "Please provide the job description"
  - Renders two special buttons: `[Upload document]` `[Enter URL]`
  - "Upload document" opens a hidden `<input type="file" accept=".md,.txt">`; on selection the file is read and its text is sent as a user message with a `jd_document` marker
  - "Enter URL" reveals an inline input field + "Fetch" mini-button in the chat; submitting sends the URL as a user message with a `jd_url` marker
- [ ] Text input area: free-form input with Send button (Enter to send)
- [ ] "Start over" button (top-right): sends `{ type: "reset" }` over WebSocket → agent clears its DO state and sends a fresh greeting
- [ ] Chat persistence: server-side in DO/SQLite via `AIChatAgent` — no localStorage needed for history
- [ ] On page load: open WebSocket; if DO has history the agent replays it; otherwise sends greeting
- [ ] Token budget display: small badge in header (unchanged)

---

### Phase 4 — Frontend: Preview Pane

- [ ] When `preview` event received, open a slide-in drawer or modal (right side or full-width)
- [ ] Render Markdown content using Toast UI Editor in viewer mode (already loaded from CDN)
- [ ] Download button: calls existing `/download` POST endpoint with content + suggested filename
- [ ] Close/dismiss button
- [ ] Support two preview types: `cv` and `cover_letter`

---

### Phase 5 — Integration & Polish

- [ ] End-to-end test: upload KB → provide JD URL → agent flow → download CV
- [ ] Error display: agent receives errors from tools, surfaces them as agent messages
- [ ] Empty KB state: agent warns user if KB is empty when they try to generate
- [ ] Mobile: single-column layout, sidebar becomes a drawer
- [ ] Update `README.md` to reflect new UX
- [ ] Delete outdated docs (screenshot)
- [ ] Run `npm run typecheck` and smoke test

---

## Files Changed

| File | Change |
|------|--------|
| `src/worker.ts` | Remove old step handlers; add `routeAgentRequest` routing; keep KB/status/health routes; rework embedded HTML/CSS/JS |
| `src/agent.ts` | New — `CvAgent extends AIChatAgent`, `onChatMessage`, `/workflow-done` callback handler |
| `src/workflow.ts` | New — `CvWorkflow extends WorkflowEntrypoint`, 4-step generation pipeline |
| `src/tools.ts` | New — light tool schemas + executors + `start_generation` tool |
| `src/types.d.ts` | Add `Env` DO + Workflow bindings; add `ToolEvent`, `WorkflowParams` types; remove old types |
| `src/db/schema.sql` | No changes (DO owns chat; D1 still owns KB + budget) |
| `wrangler.toml` | Add DO binding + migration for `CvAgent`; add `[[workflows]]` for `CvWorkflow` |
| `package.json` | Add `agents`, `@cloudflare/ai-chat`, `ai`, `workers-ai-provider` |
| `README.md` | Update feature list and screenshots |
| `docs/cv-tailoring-workspace-screenshot.png` | Delete |
| `docs/adr/` | ADR-001 through ADR-010 |

---

## Deferred Capabilities

**Cloudflare AI Search (semantic KB retrieval)**
Currently the full KB is prompt-stuffed into every system prompt. At the 1MB cap with a large-context model this is fine. AI Search (formerly AutoRAG) — managed semantic + BM25 hybrid search on top of Vectorize — becomes worthwhile when:
- The KB cap is raised beyond what fits in a prompt (~100k tokens)
- Users report irrelevant KB content surfacing in generated CVs
- Persistent cached company profiles across sessions are wanted

When added: keep D1 as source of truth; sync to an AI Search namespace on upload/delete; the `analyze_gaps` and `create_tailoring_plan` Workflow steps switch from "load all KB" to `env.SEARCH_KB.search({ query: jdText, limit: 10 })`. The company research web-crawling feature of AI Search is not useful for on-demand session fetching (6-hour crawl cycle) — that path stays as direct `fetch()`.

---

## Open Questions

- **`workers-ai-provider` + `ai` SDK tool-use loop:** Verify that the Kimi-K2.6 model supports the multi-step tool-use format expected by `streamText`. May need to swap to Anthropic or OpenAI-compatible provider if Kimi's tool-call format is incompatible.
- **DO eviction before Workflow callback:** If the DO is evicted while a Workflow is in-flight, the callback POST to `/workflow-done` wakes a fresh DO instance. The fresh instance must know which WebSocket clients to broadcast to. Mitigation: store `pending_workflow_id` in D1 so the fresh instance can reconstruct state on reconnect.
- **Preview pane:** modal vs. slide-in drawer — decided during Phase 4 based on screen space.
