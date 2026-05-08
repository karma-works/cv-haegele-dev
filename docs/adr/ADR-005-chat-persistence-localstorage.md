# ADR-005: Chat History Persisted in localStorage

**Date:** 2026-05-08  
**Status:** Accepted

## Context

The agent conversation must survive a page refresh so users don't lose their progress mid-flow. Options considered:

1. **localStorage** — Store the `messages[]` array client-side. Backend remains stateless w.r.t. chat.
2. **D1 database** — Store messages server-side in a new `cv_chat_messages` table, linked to the workspace ID.

## Decision

Use **localStorage**, keyed by workspace ID: `cv_chat_{workspaceId}`.

- On page load: read localStorage → if messages exist, render history; else agent sends greeting.
- On every message send/receive: write updated messages array to localStorage.
- "Start over" button: clears the localStorage key and reloads the greeting.
- The full messages array is sent to `/api/chat` on every request; the backend is stateless.

## Consequences

**Positive:**
- Zero schema changes — no new D1 table required.
- Works offline / in low-connectivity.
- Instant restore on refresh (no network round-trip to load history).

**Negative / Risks:**
- localStorage cap is ~5 MB per domain. A long session with large tool results (JD text, CV content) could approach this. Mitigation: when storing messages, compress `tool_result` content to a summary rather than full text; the server already has the full content from the KB.
- History is lost if the user clears browser storage. This is acceptable; the KB persists in D1 regardless.
- History is device-local; not synced across devices. Acceptable for this tool's single-user model.
