# ADR-008: Adopt Cloudflare Agents SDK (`agents` + `@cloudflare/ai-chat`)

**Date:** 2026-05-08  
**Status:** Accepted  
**Supersedes:** ADR-002 (partially), ADR-003, ADR-005

## Context

ADR-002 planned a custom `POST /api/chat` SSE endpoint with a hand-rolled agentic loop. ADR-003 decided on server-side tool execution. ADR-005 chose localStorage for chat persistence.

Cloudflare's Agents SDK (`agents` + `@cloudflare/ai-chat`) provides all three of those capabilities as a managed abstraction, backed by Durable Objects:

- **`AIChatAgent`** — subclass this to get: WebSocket transport, automatic message persistence in DO/SQLite, resumable streaming, and a built-in agentic tool-use loop via the Vercel AI SDK's `streamText`.
- **Agent Memory** — persistent context blocks (read-only identity, writable scratchpad, searchable knowledge, loadable skills) injected into the system prompt. Backed by DO/SQLite + Vectorize.
- **`routeAgentRequest`** — handles routing from the Worker `fetch` handler to the correct DO instance.

## Decision

Adopt the Cloudflare Agents SDK as the backend foundation for the chat agent.

**Packages to add:**
```
agents
@cloudflare/ai-chat
ai
workers-ai-provider
```

**Worker structure:**
```typescript
import { routeAgentRequest } from "agents";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export class CvAgent extends AIChatAgent<Env> {
  async onChatMessage(onFinish, options) {
    const result = streamText({
      model: createWorkersAI({ binding: this.env.AI })(env.MODEL_NAME),
      system: CV_AGENT_SYSTEM_PROMPT,
      messages: this.messages,   // persisted by AIChatAgent
      tools: cvAgentTools(this.env, this.sql),
      maxSteps: 10,
    });
    return result.toUIMessageStreamResponse();
  }
}

export default {
  fetch(req, env, ctx) {
    // Route /agents/* to Durable Objects; everything else to existing Worker logic
    if (new URL(req.url).pathname.startsWith("/agents/")) {
      return routeAgentRequest(req, env, ctx);
    }
    return handleLegacyRoutes(req, env, ctx);
  }
};
```

**`wrangler.toml` additions required:**
```toml
[[durable_objects.bindings]]
name = "CvAgent"
class_name = "CvAgent"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["CvAgent"]
```

**Agent Memory usage:**
- **Read-only context** — agent persona, tool usage instructions, guideline URLs
- **Writable scratchpad** — current JD text, detected company name, chosen CV language, active tailoring plan (so the agent remembers them across message turns without the client resending)
- **Searchable context** — KB file contents indexed for semantic retrieval (long-term: replaces loading the entire KB into every prompt)

## Storage after adoption

| Data | Backend | Owner |
|------|---------|-------|
| Chat message history | DO/SQLite (via `AIChatAgent`) | Agents SDK |
| Agent scratchpad (JD, plan, etc.) | DO/SQLite (via Agent Memory writable) | Agents SDK |
| Knowledge base files | D1 (`cv_knowledge_files`) | Existing code |
| Token budget | D1 (`cv_daily_tokens`) | Existing code |
| Workspace identity | D1 (`cv_workspaces`) | Existing code |

D1 remains for KB and token budget. DO/SQLite covers per-session state that was previously either in localStorage or re-sent on every request.

## Transport: WebSocket replaces SSE

`AIChatAgent` uses WebSocket for bi-directional communication. The frontend connects via `useAgentChat` (React hook) or a vanilla WebSocket wrapper. This replaces the SSE fetch loop planned in ADR-002.

For the custom event types (`tool_start`, `tool_end`, `choices`, `preview`), the agent can:
1. Emit them as special text tokens the client parses out (simple but fragile), or
2. Use `this.broadcast()` to send structured JSON messages alongside the streaming text.

**Decision:** use `this.broadcast()` for structured events; the WebSocket message handler on the client distinguishes between stream chunks and structured events by the `type` field.

## Consequences

**Positive:**
- Chat history is server-side — no localStorage cap, no data loss on clear.
- Resumable streaming — reconnecting mid-generation works out of the box.
- The agentic loop (tool call → execute → continue) is managed by `streamText` with `maxSteps`, not hand-rolled.
- Agent Memory gives semantic KB retrieval path (no need to dump entire KB into every prompt once KB grows large).

**Negative / Risks:**
- Requires adding a Durable Object binding: new migration, local dev setup change.
- 30-second CPU limit per Durable Object activation (wall-clock unlimited). The agentic loop with multiple AI sub-calls could hit this. Mitigation: the `maxSteps` loop in `streamText` pauses between tool calls (each is a new activation for DO scheduling); need to verify in practice.
- WebSocket in vanilla JS frontend requires a small WS wrapper (no React). Worth the trade-off.
- Agent Memory (Vectorize) requires a Vectorize index binding — add only if KB outgrows prompt-stuffing (defer to later).
