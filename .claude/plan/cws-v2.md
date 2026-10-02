# CWS v2 — Critical Review of v1 + Rebuild Plan (brain/worker split)

## Context

The constitution (`starttoughts.md`) describes a **human-led** cognitive work system. Its rules: structure the work without structuring the human, warnings without artificial gates, keep the line between what the user said, what an AI inferred and what was decided, carry continuity across sessions, and remove the friction of writing prompts and assembling context. Copilot built v1 (`src/`, 2 commits). It typechecks and passes 7/7 tests, but it implements a different product: an enterprise-style "circuit breaker" state machine that nothing can drive. The user still copies prompts and context by hand (`NEXT_SESSION.md` §4), which is exactly the pain the system exists to remove.

Decisions made with the user:
- **Interface:** CLI first (MCP later). It must work with **Copilot (VS Code), Claude Code and Gemini/Antigravity**.
- **Layout:** build side by side in `v2/` and leave v1 untouched.
- **Guardrails:** warn and record overrides for humans. Hard blocks apply only to AI actors.
- **Execution model:** Claude (Opus) is the brain: it writes specs, acceptance tests and reviews. Cheaper subagents (`model: "sonnet"` / `"haiku"`) write the implementation. The `ccg-workflow` Codex/Gemini runtime is **not installed**, so `/ccg:execute` cannot run. Claude Code subagents replace it.

---

## Part A — Review findings (v1, verified by running it)

`npm test` 7/7 green and `tsc --noEmit` clean. I then ran 12 adversarial probes against `StateStore.dispatch` and every one got through:

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | CRITICAL | "Human decides" is theater: any caller (the AI) passes `decidedBy:'HUMAN'` and the decision is accepted, even with 0 options considered. No actor identity exists. | `anti-rationalization.ts:11` |
| 2 | CRITICAL | **Violates its own spec §2.1.** `RESOLVE_UNKNOWN` turns any answer ("probably yes") into a `FACT`. `VALIDATE_ASSUMPTION` with evidence `"aaaaaaaaaa"` produces a FACT with hard-coded confidence 0.95. | `state-store.ts:77-83, 100-108` |
| 3 | CRITICAL | The gate is bypassable and inverted: a FATAL assumption set to `VALIDATING` passes; a **FALSIFIED** fatal premise still allows IMPLEMENTATION; EXPLORATION→LAUNCH is allowed; adding a fatal assumption *after* entering IMPLEMENTATION produces no signal. | `anti-rationalization.ts:46-58` |
| 4 | HIGH | The philosophy is reversed: constitution §24 says "allow the user to continue anyway, record that decision, monitor consequences". v1 throws exceptions at the human instead. | whole guard design |
| 5 | HIGH | Epistemic model broken: `EpistemicType` defines USER_STATEMENT/INTERPRETATION/HYPOTHESIS but **nothing can store them**, because `KnowledgeItem` only allows FACT/SYNTHESIS/OBSERVATION. AI interpretations have no home, so they get filed as FACTs. | `types.ts:7-35` |
| 6 | HIGH | No provenance (§28): `source` is a free string (empty is accepted). Nothing records who said it, in which session, or derived from what. | `types.ts:32` |
| 7 | HIGH | No history: only the latest snapshot is saved. "Work = state transformation" (§20) cannot be inspected. `UPDATE_PROGRESS` silently wipes milestones. Writes are non-atomic, and loading does no schema validation. | `state-store.ts:129-159` |
| 8 | HIGH | **Unreachable:** no CLI, no entry point, no I/O. The prompts in `.github/prompts/` never read the state, so the user still pastes context. The core promise (§7, Quick Addition) is not delivered. | repo-wide |
| 9 | HIGH | No Sessions (§21), even though "Create Session" is in the MVP core (§42). No raw Exploration capture (§12, "get everything out first"): the system forces structured K/U/A from the first input. | missing |
| 10 | MEDIUM | NextStepEngine is a hard-coded if/else ladder. It returns **0 recommendations in PROOF, LAUNCH and POST_LAUNCH**, ignores decisions, constraints and dependencies, and only ever surfaces `fatalAssumptions[0]` and `criticalUnknowns[0]`. | `next-step-engine.ts` |
| 11 | MEDIUM | Data integrity: duplicate IDs are accepted; `kn-${Date.now()}` IDs **collide** (reproduced); unknown event types are silently accepted and bump `updatedAt`. | `state-store.ts` |
| 12 | MEDIUM | The spec claims 4 circuit breakers and 6 transition rules; 1.5 are implemented. Tests cover only the happy paths and write into the repo's `sessions/` folder. | `specs/`, `tests/` |
| 13 | MEDIUM | Software-only bias contradicts §36 (universal applicability): the prompts say "Bounded Software Engineer", "<50 lines of code", "sandbox spike". | `.github/prompts/*` |
| 14 | LOW | The `Dekonstruktion…md` research is hollow: every phase heading in sections 1–4 is empty, and its sources are duplicated blog posts. The code cites it as an authority ("in accordance with"). | doc |

**Where the vision was lost (root cause).** The research doc's framing ("deterministic state machine guards *autonomous AI agents*", Big-Tech stage-gates, Bar Raiser, "Anti-Rationalization Tables") replaced the constitution's framing (*a human* thinking freely, supported by structure). The guardrails meant for AI agents were pointed at the human. The vocabulary got enterprise-generic (SDD, circuit breakers, Enterprise/Scale-up modes). The parts that make this product *distinct* were skipped: raw thought capture, the user/AI/fact distinction, sessions and resume, why-history, and prompts that require no friction.

---

## Part B — v2 design (the "my version")

### Core ideas
1. **Event log is the truth.** Use one append-only `events.jsonl` per project. State = `fold(events)`, a pure reducer. This gives history, diffs per session, an audit trail and reversibility for free. Snapshots are only a cache.
2. **Every event carries an actor**: `{kind:'human'}` or `{kind:'ai', agent:'copilot'|'claude'|'gemini'|..., role}`, plus `sessionId`, `at` and `derivedFrom: id[]` (provenance).
3. **One `Claim` entity** with the full epistemic union: `USER_STATEMENT | FACT | INTERPRETATION | ASSUMPTION | HYPOTHESIS | UNKNOWN`, plus `status` and `risk`. Decisions are a separate entity, with options, rejected alternatives and links to claims.
4. **The AI proposes and the human confirms.** AI actors can only emit `PROPOSE_*` events, which land in an **inbox**. Only a human `ACCEPT`/`EDIT`/`REJECT` turns a proposal into a FACT or a DECISION. This is the only *hard* block, and it is enforced by actor kind, not by a self-reported string. On the CLI, `--as human` requires an interactive TTY confirm; agents call it non-interactively, which forces `ai`.
5. **Warnings, not gates.** `assess(state, intendedAction) → Warning[]`. A human can always proceed. Proceeding over a warning writes a `PROCEED_UNDER_UNCERTAINTY` decision that links the warned claims, and `status`/`next` keep resurfacing it until those claims are resolved.
6. **Free phase movement**: any phase can move to any other, backwards included, with a reason. A backward move lists the downstream items that are possibly affected (via `derivedFrom`/`dependsOn`) but never rewrites them.
7. **Raw capture first**: the `NOTE` event takes unstructured dump text (or a file or stdin). Structuring happens later, as AI *proposals* over notes.
8. **Sessions**: `session start --goal` and `session end`. End computes the state diff for that session, shows what changed, and writes a short handoff.
9. **The next-step engine is data-driven**: rules live in a table (`id, when(state)→bool, priority, promptTemplate, contextSelector`) and cover all 9 phases plus cross-cutting rules (unconfirmed proposals, overrides awaiting follow-up, stale sessions, falsified premises with live downstream items). Output: 1–3 options, each with a **fully rendered prompt including the selected context**, so there is nothing to copy-compose.
10. **Agent-agnostic integration** comes from one source of truth, `v2/prompts/*.md`. `cws install-agents` generates:
    - `AGENTS.md` (read by Copilot, Gemini/Antigravity and Codex) describing the protocol: always run `cws context --for <task>` first and write results via `cws propose`
    - `CLAUDE.md` / `GEMINI.md` as thin pointers to AGENTS.md
    - `.github/prompts/*.prompt.md` (Copilot), `.claude/commands/*.md` (Claude Code), `.agent/workflows/*.md` (Antigravity)

    Each one is a thin wrapper: *"Run `cws context <phase>`, then do X, then run `cws propose --json`."*

### CLI surface (MVP)
`cws init <title>` · `cws dump [text|-]` · `cws session start|end` · `cws status` · `cws next [--copy]` · `cws context [--for explore|understand|synthesize|proof|plan|implement]` · `cws propose --json <file|->` (AI) · `cws inbox` / `cws review` (human accept/edit/reject) · `cws decide` · `cws phase <target> --reason` · `cws log [--session]` · `cws install-agents`.
Storage goes in `.cws/` inside the user's project folder (`events.jsonl`, `snapshot.json`, `sessions/`).

### v2 layout
```
v2/
  package.json  tsconfig.json         (Node, TS strict, zod, commander; tests: node:test + tsx, c8)
  src/domain/     types.ts schema.ts (zod)  events.ts  reducer.ts  ids.ts (crypto.randomUUID)
  src/guidance/   warnings.ts  rules.ts  next-steps.ts  context-pack.ts
  src/store/      event-log.ts (append, atomic, validate on read)  project-locator.ts
  src/cli/        index.ts + one file per command
  src/agents/     render.ts  targets/{copilot,claude,antigravity,agentsmd}.ts
  prompts/        explore understand synthesize proof plan implement review next .md (domain-neutral)
  tests/          unit per module + cli e2e (temp dirs only) + adversarial.test.ts (v1's 12 probes, inverted)
  docs/           spec.md (replaces specs/state-machine-spec.md), decisions/ (ADRs for this rebuild)
```
Salvage from v1: the prompt wording in `.github/prompts/*` (de-softwared) and the phase list.

---

## Part C — Execution protocol (brain vs worker)

For each slice:
1. **Brain (Opus, me)** writes the slice contract: interface signatures, behaviour rules, and **the acceptance tests themselves**, committed first so they fail (RED).
2. **Worker** (`Agent`, `subagent_type: "general-purpose"`, `model: "sonnet"` for logic slices and `"haiku"` for boilerplate/prompts/templates). It gets the contract and the failing tests, and may only touch the slice's files. The rule: *"Do not edit tests. If a test seems wrong, stop and report."*
3. **Brain gate**: run `npm test`, `tsc`, coverage, then read the diff and check it against the constitution. Reject and re-dispatch with concrete feedback, at most 2 loops before I write it myself.
4. Commit per green slice on branch `rebuild/v2` (conventional commits).

| Slice | Content | Worker |
|---|---|---|
| 0 | Branch, `v2/` scaffold, deps, copy this plan to `.claude/plan/cws-v2.md`, `docs/spec.md`; also a **spike** to confirm Antigravity reads `AGENTS.md` / `.agent/workflows` (sandbox-first) | haiku |
| 1 | Domain types + zod schemas + ids | sonnet |
| 2 | Events + pure reducer (provenance, inbox, actor rules) + adversarial tests | sonnet |
| 3 | Event-log store (append, atomic snapshot, validate on load, corrupt-line handling) | sonnet |
| 4 | Warnings + overrides + downstream-impact query | sonnet |
| 5 | Next-step rules table + context-pack selector (all 9 phases) | sonnet |
| 6 | CLI commands (status/next/dump/session/propose/inbox/review/decide/phase/log/context) | sonnet |
| 7 | Prompts (domain-neutral) + `install-agents` renderers for 4 targets | haiku |
| 8 | End-to-end dogfood: run CWS **on this project itself** (§37). Import the constitution as notes, have Claude propose claims, review them in the inbox, take `next` | brain |
| 9 | Final `code-reviewer` + `security-reviewer` pass on v2 (path handling, JSON input) | agents |

## Verification
- `cd v2 && npm test` (unit + adversarial + CLI e2e in temp dirs) and `npx tsc --noEmit`; coverage ≥80% via c8.
- `adversarial.test.ts`: all 12 v1 probes rerun against v2. Each must now be rejected (AI actors) or produce a warning plus a recorded override (humans).
- Manual end-to-end check in a temp folder: `cws init` → `cws dump` → (Claude Code: `/explore`, which calls `cws context` and `cws propose`) → `cws review` → `cws next` prints a ready prompt → `cws session end` shows the diff → a new terminal runs `cws status` and gets the full resume with no copy-paste.
- Repeat that check once in VS Code Copilot agent mode and once in Antigravity using the generated files.
