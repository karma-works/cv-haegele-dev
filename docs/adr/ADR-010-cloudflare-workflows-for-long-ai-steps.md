# ADR-010: Cloudflare Workflows for Long-Running AI Generation Steps

**Date:** 2026-05-08  
**Status:** Accepted  
**Amends:** ADR-003, ADR-008

## Context

### Current approach (pre-refactor)
The existing code uses plain SSE (`text/event-stream`) with a `ReadableStream` piping AI token chunks. There is no WebSocket, no hibernation, and no strategy for CPU time limits — it relies on the operation completing within the Worker's wall-clock window.

### Problem with AIChatAgent alone
ADR-008 adopted `AIChatAgent` (Durable Objects). A DO activation is limited to **30 seconds of CPU time** per incoming WebSocket message. The `streamText` agentic loop for a full run — fetch JD → analyse gaps → tailoring plan → generate CV — involves multiple sequential AI calls. CV generation alone on a large knowledge base can take 20–60 seconds of CPU. This will hit the wall.

WebSocket **hibernation** (the DO hibernation API) would keep the WebSocket alive while the DO sleeps between messages, but it does not extend the CPU budget for a single activation. It is irrelevant to this problem.

### What Cloudflare Workflows provides
- **5 minutes CPU per step** (Paid plan, configurable in `wrangler.toml`)
- **Automatic step-level memoisation and retry** — if the Worker is evicted mid-generation, the Workflow resumes from the last completed step
- **Unbounded wall-clock time** — a Workflow can sleep for days between steps at zero cost
- **`step.waitForEvent()`** — enables human-in-the-loop or external-trigger patterns
- **Native integration with Agents SDK** — `AIChatAgent` can trigger Workflows via binding; Workflows can call back to DOs via RPC

## Decision

Use Cloudflare Workflows for the three long-running AI generation steps. Lightweight operations remain inline inside the `AIChatAgent`.

### Split of responsibilities

| Operation | Execution location | Rationale |
|-----------|-------------------|-----------|
| `fetch_jd` | Inline in DO | HTTP fetch + HTML strip, < 2s |
| `import_profile` | Inline in DO | HTTP fetch + markdown, < 3s |
| `search_company` + guideline fetch | Inline in DO | Parallel fetches + short AI summary, < 5s |
| `analyze_gaps` | Inline in DO | Single structured AI call, < 5s |
| `create_tailoring_plan` | **Workflow** | Long AI Markdown generation, 10–60s |
| `generate_cv` | **Workflow** | Longest AI call; large output; must not be cut off |
| `generate_cover_letter` | **Workflow** | Long AI call |

### Architecture

```
Client (WebSocket)
     │ sends "generate CV"
     ▼
CvAgent (DO / AIChatAgent)
     │ 1. creates Workflow instance
     │ 2. stores workflowId in DO scratchpad
     │ 3. broadcasts { type:"tool_start", tool:"generate_cv", workflowId }
     │ 4. onChatMessage returns → DO activation ends (no CPU burn while waiting)
     ▼
CvWorkflow (Cloudflare Workflow)
     │ step 1: load KB from D1 + scratchpad context
     │ step 2: AI generate CV (up to 5 min CPU)
     │ step 3: POST callback to DO /workflow-done
     ▼
CvAgent (DO) — new activation via HTTP callback
     │ broadcasts { type:"preview", content_type:"cv", content:"..." }
     ▼
Client — opens preview pane
```

### `CvWorkflow` step structure

```typescript
export class CvWorkflow extends WorkflowEntrypoint<Env, CvWorkflowParams> {
  async run(event: WorkflowEvent<CvWorkflowParams>, step: WorkflowStep) {
    const { tool, workspaceId, doId, jdText, tailoringPlan, tone } = event.payload;

    const context = await step.do("load-context", async () => {
      // Load KB from D1; return only the text content needed for generation
      return loadKbForWorkspace(this.env.DB, workspaceId);
    });

    const result = await step.do("ai-generate", {
      retries: 2,
      timeout: "4 minutes",
    }, async () => {
      if (tool === "generate_cv") return generateCv(this.env.AI, context, jdText, tailoringPlan);
      if (tool === "generate_cover_letter") return generateCoverLetter(this.env.AI, context, jdText, tone);
      if (tool === "create_tailoring_plan") return createTailoringPlan(this.env.AI, context, jdText);
    });

    // Callback to the DO
    await step.do("notify-agent", { retries: 3 }, async () => {
      const stub = this.env.CVAGENT.get(this.env.CVAGENT.idFromString(doId));
      await stub.fetch("/workflow-done", {
        method: "POST",
        body: JSON.stringify({ tool, result }),
      });
    });
  }
}
```

### `wrangler.toml` additions

```toml
[[workflows]]
name     = "cv-workflow"
binding  = "CV_WORKFLOW"
class_name = "CvWorkflow"

[workflows.limits]
cpu_ms = 300_000   # 5 minutes per step
steps  = 50
```

### Token budget accounting

The Workflow calls the AI directly using `this.env.AI`. After generation, it updates the D1 token budget table in a `step.do("update-budget", ...)` step. Because step results are memoised, the budget is only charged once even if the `notify-agent` step needs to retry.

## Consequences

**Positive:**
- Eliminates the 30s CPU limit as a correctness risk for CV/letter generation.
- Automatic retry means a transient AI model error doesn't lose the user's session.
- `CvAgent` stays lean — it handles UI/WebSocket state; `CvWorkflow` handles heavy computation.
- Sleeping/waiting instances are free; no cost while the AI is generating.

**Negative / Risks:**
- Additional complexity: two execution environments (DO + Workflow) instead of one.
- The DO-to-Workflow-to-DO callback introduces a second HTTP round-trip before the client sees the result. Latency is acceptable since generation takes tens of seconds anyway.
- Workflow state has a 30-day retention (Paid). The CV content inside Workflow step results persists for 30 days — acceptable given D1 KB already has 30-day retention.
- If the DO is evicted before the Workflow callback arrives, the callback needs to wake a new DO instance. This works because DO IDs are stable (derived from workspace ID), but the new DO instance must be able to reconstruct the WebSocket context. Mitigation: store `workflowId` → `tool` mapping in D1 so a fresh DO can identify pending Workflows on reconnect.
