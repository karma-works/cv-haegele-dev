# ADR-003: Server-Side Tool Execution (Agentic Loop in Worker)

**Date:** 2026-05-08  
**Status:** Accepted

## Context

When an LLM decides to call a tool, someone must execute it and feed the result back. Two main options exist:

1. **Client-side orchestration** — Server returns a tool-call instruction; client executes the tool (by calling a sub-endpoint) and sends the result back in a follow-up request.
2. **Server-side orchestration** — Server executes the tool internally within the same request, loops the result back to the model, and only returns to the client when the model produces a final text response (or a choices/preview event).

## Decision

Use **server-side orchestration**. The `/api/chat` handler runs the full agentic loop: call model → if tool call, execute → append result → call model again → repeat until done. The SSE stream emits `tool_start` and `tool_end` events as they happen so the client can show live tool status without waiting for the loop to finish.

**Tool execution order within a single request:**
```
POST /api/chat
  → AI model call (with tool definitions)
  → tool call: fetch_jd
    → emit: tool_start
    → execute: fetch URL, extract text
    → emit: tool_end
    → append tool result to messages
  → AI model call (continued conversation)
  → final text response
    → emit: token (streaming)
    → emit: choices (if applicable)
  → emit: done
```

## Consequences

**Positive:**
- Client stays simple: one request, one SSE stream. No round-trips for tool calls.
- Tool results are never exposed to the client as raw data (only summaries), which avoids leaking intermediate payloads.
- Easier to enforce token budget across the full loop.

**Negative / Risks:**
- Long agentic loops risk hitting Cloudflare Worker's wall-clock time limit. The `generate_cv` tool in particular issues a long AI sub-call. Mitigation: stream aggressively; if needed, split generation tools into a separate streaming sub-call invoked by the client after the loop signals readiness.
- Debugging is harder since the full loop happens opaquely inside one request. `tool_start`/`tool_end` events provide visibility.
