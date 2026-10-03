# ADR 0001 - Rebuild instead of patching v1

- Status: accepted (2026-10-02)
- Context: A review of v1 (`archive/v1/cws-v2-plan.md`, Part A) found 14 issues, 3 of them critical. Every one of the 12 adversarial probes got through. The root cause was conceptual, not local: v1 aimed deterministic circuit breakers at the human, which contradicts the constitution. It also had no CLI or I/O, no sessions, no raw capture, and no history.
- Options: (a) patch v1; (b) rewrite in place; (c) rebuild alongside v1 long enough to prove the replacement.
- Decision: rebuild around an event-sourced CLI, then consolidate it into the root package once it became canonical.
- Consequences:
  - Event sourcing replaces snapshot persistence.
  - Hard blocks remain only for AI actors.
  - CLI first, MCP later.
  - v1 is archived under `archive/v1` and excluded from active build, test, and package surfaces.
