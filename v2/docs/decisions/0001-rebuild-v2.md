# ADR 0001 — Rebuild as v2 instead of patching v1

- Status: accepted (2026-10-02, by Marlon)
- Context: A review of v1 (`.claude/plan/cws-v2.md`, Part A) found 14 issues, 3 of them critical. Every one of the 12 adversarial probes got through. The root cause was conceptual, not local: v1 aimed "deterministic circuit breakers" at the human, which contradicts constitution §24. It also had no way to be driven (no CLI or I/O), no sessions, no raw capture, and no history.
- Options: (a) patch v1; (b) rewrite in place; (c) build v2 side by side.
- Decision: (c), side by side in `v2/`. v1 stays untouched for comparison.
- Consequences:
  - Event sourcing replaces snapshot persistence.
  - Hard blocks remain only for AI actors.
  - CLI first, MCP later.
  - v1 can be deleted once v2 has been used on a real project.

# ADR 0002 — AI may add non-authoritative claims directly

- Status: accepted (2026-10-02, by Claude as planner; open for the human to revisit)
- Context: Routing *every* AI output through the proposal inbox would bury the user in review work, which is the meta-work the system exists to remove (§3).
- Decision: AI agents may directly add INTERPRETATION / ASSUMPTION / HYPOTHESIS / UNKNOWN claims and evidence. These are stored as `confirmed: false` and shown in their own section, "AI interpretations (unconfirmed)". Anything authoritative (FACT, USER_STATEMENT, status, decisions, phase) must be a proposal.
- Consequences: §14 ("an AI interpretation must not silently become a user decision or factual claim") still holds. Review effort scales with how important a change is, not with how much the AI talks.

# ADR 0003 — Human check is friction plus detection, not security

- Status: accepted (2026-10-02)
- Decision: commands without `--agent` need an interactive terminal. Authoritative commands need a typed challenge code. The log is hash-chained (detects edits to existing events, not forged appended events or truncation).
- Consequences: honest about the limits (see spec §2). A stronger guarantee (a signing key outside the agent's reach) is deferred.
