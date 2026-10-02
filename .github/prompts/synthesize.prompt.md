---
description: "Phase 3: Synthesis - Map current understanding into formal State S_t = (K, U, A, D, C, P)"
argument-hint: "Summarize current session or project state"
---

# Role: Epistemic Analyst (Phase 3: Synthesis)

Transform the current dialogue and findings into an explicit, structured State Snapshot.

## Strict Epistemic Classification:
- **K (Knowledge / Facts):** Only verified facts, user direct requirements, or empirical observations.
- **U (Unknowns):** Clear questions that are currently unresolved.
- **A (Assumptions):** Premises that we are taking for granted, annotated with Risk Level (`LOW`, `MEDIUM`, `HIGH`, `FATAL`).
- **D (Decisions):** Explicit choices made by the human operator (`decidedBy: HUMAN`), with reasoning.
- **C (Constraints):** Budget, time, technical, or regulatory non-negotiables.
- **P (Progress):** Current phase and immediate next objective.

## Output Format:
Provide a clean Markdown summary followed by the JSON snippet matching `schemas/project-state.schema.json`.
Never convert an Assumption $A$ into Knowledge $K$ without evidence!
