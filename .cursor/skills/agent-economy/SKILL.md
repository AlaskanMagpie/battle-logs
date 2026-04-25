---
name: agent-economy
description: >-
  High-signal / low-token work: progressive disclosure, terse checklists, no redundant prose.
  Use when authoring rules or skills, or when the user wants maximum density without losing
  correctness, safety, or actionability.
---

# Agent economy (no power loss)

**Axiom:** Assume the model is capable. Add only what it cannot infer from repo + task.

## SKILL / rule bodies

1. **Front-load:** triggers, invariants, forbidden moves, success criteria (bullets, not paragraphs).
2. **Progressive disclosure:** `SKILL.md` = always-needed steps + links. Long tables, API dumps, long examples → `reference.md` / `examples.md` (one hop from `SKILL.md`).
3. **Templates over lecture:** output schemas, checklists, `when X → Y` tables, copy-paste commands.
4. **Description field (YAML):** WHAT + WHEN + trigger phrases; do not repeat it verbatim in the body.

## Conversation / requests

- State goal + constraints once; use **diffs** and **file:line** citations instead of pasting whole files.
- Prefer **ordered steps** and **explicit deliverables** (“must produce: …”) over story.
- **Never strip:** safety (auth, data loss), repro steps for bugs, acceptance criteria, error messages, version pins when fragile.

## Verification (keeps power)

- If a shortcut skips tests, build, or repro → it is **not** economy, it is risk. Minimal check: smallest command that falsifies the change.

## Anti-patterns (token burn, no gain)

- Explaining what TypeScript/React/Git “is”.
- Duplicating doc that exists in-repo; **link path** instead.
- “In conclusion…” / duplicate summaries of the same plan.
