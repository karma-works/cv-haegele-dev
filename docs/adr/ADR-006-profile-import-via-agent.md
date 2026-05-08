# ADR-006: Profile Import Triggered via Agent Chat

**Date:** 2026-05-08  
**Status:** Accepted

## Context

The current UI has a dedicated "Import public profile" field in the KB panel that accepts GitHub, LinkedIn, Xing, and X/Twitter profile URLs. Removing this field simplifies the sidebar but the underlying `import_profile` functionality is still useful.

## Decision

Remove the profile import UI field from the KB sidebar entirely. The `import_profile` functionality is retained as an agent tool. The user triggers it by telling the agent (e.g. "import my GitHub profile, it's at github.com/..."). The agent calls the `import_profile` tool, stores the result in the KB, and confirms in the chat.

The agent's greeting or KB-empty state message hints at this capability: _"You can also share your GitHub, LinkedIn, or Xing profile URL and I'll import it."_

## Consequences

**Positive:**
- Sidebar is simpler (no URL input field, no "Import" button, no source-type hint).
- The agent can prompt for the profile URL at the right moment (e.g. when the KB is thin).

**Negative / Risks:**
- Feature discoverability drops — users who don't read the greeting may not know profile import is possible. Mitigation: agent explicitly mentions it when KB is empty or sparse.
- Users who relied on the import field as a known shortcut now need to type a natural-language request. This is a minor friction increase for returning users.
