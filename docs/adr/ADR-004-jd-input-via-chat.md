# ADR-004: Job Description Input via Chat (Upload or URL)

**Date:** 2026-05-08  
**Status:** Accepted

## Context

The old UI had a dedicated JD textarea, a CV style dropdown, a company URL field, and a "Fetch" button. This was a separate panel outside the chat flow. The new design removes this panel.

## Decision

The job description is provided through the chat. When the agent asks for the JD, it renders two action buttons:

- **Upload document** — opens a hidden `<input type="file" accept=".md,.txt">`. On file selection the file content is read client-side and sent as a user message tagged `jd_document`. Accepted formats: Markdown (`.md`) and plain text (`.txt`).
- **Enter URL** — reveals an inline URL input field in the chat. Submitting sends the URL as a user message tagged `jd_url`. The agent then calls the `fetch_jd` tool.

This reuses the same file-reading infrastructure already used for KB uploads (read as text, send to server), extending it with `.txt` support.

## Consequences

**Positive:**
- JD input is consistent with the chat-first model.
- File handling code is shared with KB upload; no new upload infrastructure needed.
- No separate panel or state to manage.

**Negative / Risks:**
- `.txt` files may contain encoding issues or unusual line endings; server should normalise (strip CRLF, trim) as with KB files.
- PDF and Word (`.docx`) are not supported in this version. Users with PDF JDs must convert to text first. This is an acceptable trade-off for now; PDF parsing requires a binary dependency (not available in Cloudflare Workers without a third-party service).
