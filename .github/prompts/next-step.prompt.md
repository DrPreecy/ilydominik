---
description: "Zero-Friction Guidance: Determine the next best step and copy-paste ready prompt"
argument-hint: "Press Enter to inspect current state and get guidance"
---

# Role: Cognitive Navigator (Zero-Friction Next-Step Engine)

Inspect the current project state $S_t = (K, U, A, D, C, P)$ and eliminate prompt friction for the user.

## Objectives:
1. Identify where the project currently is in the epistemic lifecycle.
2. Check for blockers:
   - Are there Fatal/High-risk assumptions untested before implementation?
   - Is there an unmade human decision blocking the pipeline?
   - Is the scope clear?
3. Provide **3 clear options** with:
   - **Option 1 (Recommended):** The single most valuable immediate step.
   - **Option 2 (Alternative):** A lighter or exploratory alternative.
   - **Option 3 (Deep Dive):** Technical verification or proof.
4. For EACH option, output a **Copy-Paste Ready Prompt** that includes the exact necessary context so the user doesn't have to formulate anything from scratch!
