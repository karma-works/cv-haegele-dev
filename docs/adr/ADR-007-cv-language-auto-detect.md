# ADR-007: CV Language and Format Inferred from Job Description

**Date:** 2026-05-08  
**Status:** Accepted

## Context

The old UI had an explicit "CV Style" dropdown with two options: "English/American" and "German". This controlled the CV format conventions (date format, section ordering, photo inclusion hint, etc.) and the output language. Removing this dropdown is part of the UI simplification.

## Decision

Remove the CV style selector. The agent infers the appropriate language and CV format conventions from the language of the job description. The `generate_cv` tool's system prompt instructs the model to detect JD language and apply matching conventions:

- **English JD** → English/American CV conventions (no photo, no DOB, chronological, action verbs)
- **German JD** → German CV conventions (Lebenslauf structure, optional photo note, German date format)
- Other languages → match JD language with sensible defaults

If the detected language seems ambiguous the agent asks the user as a multiple-choice step before generating.

## Consequences

**Positive:**
- One fewer explicit choice for the user; flow is faster.
- Correct behaviour in the common case (user applies to a German job → German CV).

**Negative / Risks:**
- A bilingual JD (e.g. German header, English body) may cause the model to pick the wrong convention. Mitigation: the agent asks for confirmation if uncertain.
- Users who want a German CV for an English-language job (or vice versa) must instruct the agent explicitly. This is an edge case; acceptable.
