# Specification: Cognitive Work System State Machine & Epistemic Guardrails

## 1. Mathematical Grounding
The project state at any discrete point in time $t$ is expressed as:
$$S_t = (K, U, A, D, C, P)$$

Where:
- $K \subseteq \text{Knowledge}$ (Validated observations, synthesis, and facts)
- $U \subseteq \text{Unknowns}$ (Explicit knowledge gaps and unanswered questions)
- $A \subseteq \text{Assumptions}$ (Premises subject to verification)
- $D \subseteq \text{Decisions}$ (Human-made directional choices with rationale)
- $C \subseteq \text{Constraints}$ (Invariants, boundaries, limitations)
- $P \in \text{Progress}$ (Current phase, objective, and operational health)

State transitions occur deterministically via work events $W_t$:
$$S_{t+1} = T(S_t, W_t)$$

## 2. Epistemic Isolation Principle
To prevent AI hallucination or cognitive drift from contaminating the project:
1. **AI Output is strictly INTERPRETATION or HYPOTHESIS until confirmed by the HUMAN.**
2. **An ASSUMPTION can never become KNOWLEDGE without empirical PROOF or validation.**
3. **A DECISION must explicitly indicate `decidedBy: 'HUMAN'`. The system cannot autonomously finalize trade-offs.**

## 3. Anti-Rationalization Table (Hard Circuit Breakers)

| Agent Claim / Rationalization | Prohibited Behavior | Hard Circuit Breaker / Remedy |
| :--- | :--- | :--- |
| *"This assumption is obvious, we don't need to test it."* | Skipping Phase 4 (Proof) or treating $A$ as $K$. | Block transition to `IMPLEMENTATION` if fatal/high risk assumptions remain `UNTESTED`. |
| *"I've decided to implement architecture X."* | AI silently taking decision ownership. | Reject `RECORD_DECISION` unless confirmed by human operator (`decidedBy: 'HUMAN'`). |
| *"We can skip unit tests since the code is straightforward."* | Bypassing automated test verification. | Reject task completion until test contract passes deterministically. |
| *"Let's immediately start coding the whole backend."* | Vibe-coding without problem exploration. | Force progressive disclosure: check that `SYNTHESIS` and `CONCEPT` artifacts exist. |

## 4. Phase Transitions Rules
- `EXPLORATION` $\rightarrow$ `UNDERSTANDING`: Triggered when initial raw brain-dump is complete and key unknowns are tagged.
- `UNDERSTANDING` $\rightarrow$ `SYNTHESIS`: Requires Socratic clarification of core problem statement.
- `SYNTHESIS` $\rightarrow$ `PROOF`: Requires explicit identification of high-risk assumptions ($A$).
- `PROOF` $\rightarrow$ `CONCEPT`: Requires empirical or sandbox validation of high-risk hypotheses.
- `CONCEPT` $\rightarrow$ `PLANNING`: Requires human sign-off on Idea Concept and boundaries.
- `PLANNING` $\rightarrow$ `IMPLEMENTATION`: Requires modular task decomposition with test contracts.
