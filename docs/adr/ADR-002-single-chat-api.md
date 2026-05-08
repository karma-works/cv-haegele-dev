# ADR-002: Single `/api/chat` Endpoint

**Date:** 2026-05-08  
**Status:** Accepted

## Context

The current backend exposes eight separate HTTP endpoints, one per workflow step (`/api/analyze-gaps`, `/api/tailoring-plan`, `/api/refine-plan`, `/api/generate-cv`, `/api/generate-cover-letter`, `/api/company-fetch`, `/api/import-profile`, `/api/clarifications`). The frontend orchestrates calls to these endpoints manually. This tight coupling between frontend state and backend route order makes it difficult to change the flow.

## Decision

Replace all step-specific AI endpoints with a single `POST /api/chat` endpoint. The client sends the full conversation `messages[]` array with every request. The server runs an agentic loop: calls the AI model with tool definitions, executes any tool calls, feeds results back, and loops until the model produces a final text response. The response is streamed to the client as Server-Sent Events.

**Retained endpoints (unchanged):**
- `GET /api/knowledge` — list KB files
- `POST /api/knowledge` — upload KB files
- `DELETE /api/knowledge/{fileId}` — delete a KB file
- `POST /api/delete-all` — nuke workspace
- `GET /api/status` — token budget
- `GET /api/health` — health check
- `POST /download` — trigger browser download

**Removed endpoints:**
- `/api/analyze-gaps`
- `/api/tailoring-plan`
- `/api/refine-plan`
- `/api/generate-cv`
- `/api/generate-cover-letter`
- `/api/company-fetch`
- `/api/import-profile`
- `/api/clarifications`

## Consequences

**Positive:**
- Client is dumb: send messages, render events. No frontend orchestration logic.
- Adding or reordering steps only requires changing the system prompt and tool definitions, not new routes.
- Single SSE stream covers tool events, text tokens, choices, and preview content — consistent protocol.

**Negative / Risks:**
- Cloudflare Worker wall-clock time limit (~30s on Paid plan) could be hit if the agentic loop runs multiple expensive AI calls in sequence. Mitigation: stream tool events eagerly; profile long-running tools; consider splitting `generate_cv` and `generate_cover_letter` into server-streaming operations that yield early.
- The full conversation history is sent on every request. For long sessions this payload grows. Mitigation: localStorage has a 5 MB cap per domain; prune oldest tool result content if needed.
- No endpoint-level caching; any caching must happen inside tool executors.
