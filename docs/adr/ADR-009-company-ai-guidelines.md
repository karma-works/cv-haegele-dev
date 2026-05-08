# ADR-009: Company AI Usage Guidelines in Agent Flow

**Date:** 2026-05-08  
**Status:** Accepted

## Context

Many companies publish guidance on whether and how candidates may use AI tools during their application process. Ignoring these guidelines — even if unintentionally — can disqualify a candidate or create a bad impression. The agent should proactively look for and follow the target company's AI usage policy as part of its company research step.

Anthropic publishes a reference guideline: https://www.anthropic.com/candidate-ai-guidance  
This is the default when no company-specific policy is found.

## Decision

Extend the `search_company` tool to also search for the company's AI usage / candidate guidance policy. Add a dedicated `fetch_ai_guidelines` sub-step within the tool:

1. The tool searches the company's careers site and any public policy pages for terms like "AI", "artificial intelligence", "candidate guidance", "automation policy".
2. If a guideline page is found, its content is fetched and summarised.
3. If no company-specific guideline is found, the agent uses Anthropic's candidate AI guidance as the default reference (https://www.anthropic.com/candidate-ai-guidance).
4. The guideline summary is stored in the agent's writable scratchpad (Agent Memory) and injected into the system prompt for all subsequent generation steps (CV, cover letter).

**System prompt instruction (injected after guideline is loaded):**
```
The following AI usage guideline applies to this application:
<ai_guideline>
{{guideline_text}}
</ai_guideline>
When generating the CV and cover letter, adhere strictly to this guideline.
If the guideline prohibits AI-generated content, inform the user before generating.
If it requires disclosure, include a disclosure note.
```

**Agent flow addition:**
After the company research step, the agent surfaces the guideline to the user with a summary:
> "I found Acme Corp's AI candidate policy. They allow AI for research and drafting but ask that final submissions are substantially your own work. I'll keep this in mind. Want to continue?"

If using the Anthropic default:
> "I couldn't find a specific AI policy for Acme Corp. I'll follow Anthropic's candidate AI guidance as a sensible default: use AI to assist drafting and research, but keep the content authentic to your experience."

**The user can override** the guideline by typing or providing a different URL; the agent will fetch and load it.

## Consequences

**Positive:**
- Reduces risk of inadvertently violating a company's recruitment policy.
- Demonstrates to the user that the tool is ethically aware.
- The Anthropic default sets a clear, reasonable baseline even without a company-specific policy.

**Negative / Risks:**
- Company AI policies may be embedded in large PDFs or behind auth walls — fetching them may fail silently. Mitigation: agent reports "I couldn't find a policy" and falls back to default rather than crashing.
- Policy language can be ambiguous; the AI's interpretation may not match what the company intends. Mitigation: agent surfaces the raw policy snippet to the user rather than just following it invisibly.
- Fetching an extra page during company research adds latency. Mitigation: run guideline fetch and main company research in parallel within the `search_company` tool.
