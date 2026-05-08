# ADR-001: Chat-First Architecture

**Date:** 2026-05-08  
**Status:** Accepted

## Context

The current UI presents five separate panels — knowledge base, job description, gap analysis, CV generation, and cover letter — each requiring explicit manual interaction. Users must understand the intended workflow themselves. There is no guidance, no error prevention, and no way to deviate from the fixed order. The result is a cumbersome, confusing experience.

## Decision

Replace all panels (except KB management) with a single chat window. An AI agent drives the conversation, offers multiple-choice options as clickable button chips, and calls tools autonomously based on context. The knowledge base section moves to a collapsible sidebar so it is accessible but out of the primary flow.

**UI structure:**
- **Collapsible left sidebar** — KB file list, browse-to-upload, storage meter, delete-all. No profile import field (moved to agent).
- **Main chat area** — full-height scrollable conversation between user and agent.
- **Floating preview pane** — opens when CV or cover letter is ready; shows rendered Markdown with a download button.

The agent greets the user on load. If the KB is empty it prompts for uploads first; otherwise it moves directly to asking for the job description.

## Consequences

**Positive:**
- Users are guided through the process without needing to understand the tool.
- Agent can adapt order and skip steps based on what the user needs.
- Fewer UI elements to maintain; all business logic lives in the agent's system prompt and tools.

**Negative / Risks:**
- Discoverability of features depends on the agent surfacing them; power users cannot skip to a step directly.
- Agent errors or misunderstandings manifest as conversational failures, which can be harder to recover from than a button press.
- The preview pane adds frontend complexity for rendering streamed Markdown.
