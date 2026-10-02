# CWS v2 — Specification

Replaces `specs/state-machine-spec.md` (v1). Source of intent: `starttoughts.md` (the constitution). Where this spec and the constitution disagree, the constitution wins and this spec is wrong.

## 1. Model

- **Truth = an append-only event log** (`.cws/events.jsonl`). State is `fold(events)` with a pure reducer (`src/domain/reducer.ts`). This is the constitution's `S_{t+1} = T(S_t, W_t)` (§20, §41), made real. Every past state can be replayed, and every change has an author and a time.
- **Entities**: Note (raw, verbatim thought), Claim (epistemic item), Evidence, Decision, Proposal, Session, PhaseChange.
- **Claim types** (§14): USER_STATEMENT, FACT, INTERPRETATION, ASSUMPTION, HYPOTHESIS, UNKNOWN. A DECISION is its own entity.
- **Claim status**: OPEN → TESTING → SUPPORTED | FALSIFIED; UNKNOWN → ANSWERED; anything → RETIRED (kept for history).
- **Provenance** (§28): every item stores its actor (`human` or `ai:<agent>`), phase, session, time and `derivedFrom` links.

## 2. Authority (§6: "AI may recommend … the human decides")

| Action | Human | AI |
|---|---|---|
| raw note, evidence, INTERPRETATION / ASSUMPTION / HYPOTHESIS / UNKNOWN claims | yes | yes (stored as unconfirmed) |
| FACT, USER_STATEMENT | yes | only via proposal |
| status change, confirm claim, decision, phase change, session start/end | yes | only via proposal |
| accept / reject proposals | yes | never |

The reducer enforces this by actor *kind*, not by a self-declared label (v1 bug #1).

**Honest limit:** on a local machine, an agent with shell access can append to the log by hand or impersonate a human in a terminal. v2 makes forging *deliberate and detectable*, not impossible:
- human decision-level commands need an interactive challenge code
- non-interactive calls without `--agent` are refused
- the log is hash-chained, so `cws verify` and `cws status` report edits

Someone who rewrites every later hash is not detectable without a secret key; that is out of scope for the MVP.

## 3. Warnings, not gates (§24)

`assess(state)` produces warnings: UNTESTED_RISK, FALSIFIED_PREMISE, OPEN_CRITICAL_UNKNOWN, SUPPORTED_WITHOUT_EVIDENCE, OVERRIDE_UNRESOLVED, PENDING_PROPOSALS, UNCONFIRMED_AI_CLAIMS, PHASE_SKIP. Humans are never blocked. A risky forward phase move asks the human to say *why* (`--accept-risk "<why>"`). That records a `PROCEED_UNDER_UNCERTAINTY` decision linking the risks, which is then monitored (OVERRIDE_UNRESOLVED) until those risks are resolved. This covers §24 steps 1–6.

## 4. Phases (§9, §35)

Nine phases. Any phase can move to any other. A backward move lists the items created in later phases as *possibly affected* and changes none of them; the human decides how far to revisit.

## 5. Guidance (§23)

`nextSteps(state)` evaluates a data table of rules (`src/guidance/rules.ts`) and returns up to 3 options, always including the phase default. Each option maps to a purpose prompt (`prompts/<purpose>.md`). `cws prompt N` renders that prompt plus a context pack (`src/guidance/context-pack.ts`) built from state, so nothing has to be pasted by hand (Quick Addition in the constitution).

## 6. Agent integration

`cws install-agents` writes one protocol (AGENTS.md) and thin per-tool wrappers:
- Copilot: `.github/prompts/cws-*.prompt.md`
- Claude Code: `.claude/commands/cws-*.md`
- Gemini/Antigravity: `.agent/workflows/cws-*.md`

Every wrapper says the same thing: run `cws context <purpose>` and record results only through the listed `--agent` commands.

## 7. Out of scope for this MVP (§42)

MCP server, multi-project workspace view, hierarchical work structure (workstream/objective/task) as entities, dependency graph beyond `derivedFrom`/`links`, UI. All of these remain possible on top of the event log.
