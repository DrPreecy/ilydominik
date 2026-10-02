# CWS Specification

Replaces the archived v1 snapshot model in `archive/v1/specs/state-machine-spec.md`. Source of intent: `starttoughts.md` (the constitution). Where this spec and the constitution disagree, the constitution wins and this spec is wrong. The idea-to-launch workflow, drawn as blocks, is in [`workflow.md`](workflow.md).

## 1. Model

- **Truth = an append-only event log** (`.cws/events.jsonl`). State is `fold(events)` with a pure reducer (`src/domain/reducer.ts`). This is the constitution's `S_{t+1} = T(S_t, W_t)`, made real. Every past state can be replayed, and every change has an author and a time.
- **Entities**: Note (raw, verbatim thought), Claim (epistemic item), Evidence, Decision, Proposal, Session, PhaseChange.
- **Claim types**: USER_STATEMENT, FACT, INTERPRETATION, ASSUMPTION, HYPOTHESIS, UNKNOWN. A DECISION is its own entity.
- **Claim status**: OPEN -> TESTING -> SUPPORTED | FALSIFIED; UNKNOWN -> ANSWERED; anything -> RETIRED (kept for history).
- **Provenance**: every item stores its actor (`human` or `ai:<agent>`), phase, session, time and `derivedFrom` links.

## 2. Authority

| Action | Human | AI |
|---|---|---|
| raw note, evidence, INTERPRETATION / ASSUMPTION / HYPOTHESIS / UNKNOWN claims | yes | yes (stored as unconfirmed) |
| FACT, USER_STATEMENT | yes | only via proposal |
| status change, confirm claim, decision, phase change, session start/end | yes | only via proposal |
| accept / reject proposals | yes | never |

The reducer enforces this by actor *kind*, not by a self-declared label. This preserves the key v1 lesson: a string such as `decidedBy: "HUMAN"` is not authority.

**Honest limit:** on a local machine, an agent with shell access can append to the log by hand or impersonate a human in a terminal. CWS makes forging *deliberate*, not impossible:

- authoritative human commands (decide, accept, confirm, mark, retire, phase, review, and human FACT/USER_STATEMENT claims) need an interactive challenge code
- non-interactive calls without `--agent` are refused
- the log is hash-chained, so `cws verify` and `cws status` detect **edits to or reordering of existing events**

They do **not** detect a correctly chained event appended at the end, a truncated log, or a fully re-hashed rewrite; that needs a secret key (an HMAC with the key stored outside the agent's reach), which is deferred.

## 3. Warnings, Not Gates

`assess(state)` produces warnings: UNTESTED_RISK, FALSIFIED_PREMISE, OPEN_CRITICAL_UNKNOWN, SUPPORTED_WITHOUT_EVIDENCE, OVERRIDE_UNRESOLVED, PENDING_PROPOSALS, UNCONFIRMED_AI_CLAIMS, PHASE_SKIP. Humans are never blocked. A risky forward phase move asks the human to say why (`--accept-risk "<why>"`). That records a `PROCEED_UNDER_UNCERTAINTY` decision linking the risks, which is then monitored (OVERRIDE_UNRESOLVED) until those risks are resolved.

## 4. Phases

Nine phases. Any phase can move to any other. A backward move lists the items created in later phases as *possibly affected* and changes none of them; the human decides how far to revisit.

## 5. Guidance

`nextSteps(state)` evaluates a data table of rules (`src/guidance/rules.ts`) and returns up to 3 options, always including the phase default. Each option maps to a purpose prompt (`prompts/<purpose>.md`). `cws prompt N` renders that prompt plus a context pack (`src/guidance/context-pack.ts`) built from state, so nothing has to be pasted by hand.

## 6. Agent Integration

`cws install-agents` writes one protocol (`AGENTS.md`) and thin per-tool wrappers:

- Copilot: `.github/prompts/cws-*.prompt.md`
- Claude Code: `.claude/commands/cws-*.md`
- Gemini/Antigravity: `.agent/workflows/cws-*.md`

Every wrapper says the same thing: run `cws context <purpose>` and record results only through the listed `--agent` commands.

## 7. Out Of Scope For This MVP

MCP server, multi-project workspace view, hierarchical work structure (workstream/objective/task) as entities, dependency graph beyond `derivedFrom`/`links`, UI. All of these remain possible on top of the event log.

## 8. Integrations

CWS runs outside tools; it does not bundle them. Every call passes an argument list to a named executable, never a shell, with a timeout and an output cap, and the answer is validated before it is used (`src/integrations/exec.ts`).

- **`cws doctor`** reports the host kind, whether a project exists, the integration settings, the resolved sandbox mode, and every tool with version and path. Missing tools are not errors.
- **`cws review-code`** asks Open Code Review (delegation mode, no model key) which files a review must cover and which rule applies to each. Coverage is the contract: every listed file ends reviewed or skipped with a reason.
- **`cws findings ingest`** turns tool output (SARIF 2.1.0, `ocr review --format json`, or CWS's own JSON) into `HYPOTHESIS` claims: severity maps to risk, the fingerprint in the claim text prevents duplicates, and secrets are redacted first. Findings are never facts — the human confirms, fixes or marks them false, and that verdict is what measures how much a tool is worth trusting.
- **`cws sandbox`** wraps NVIDIA OpenShell when it is installed. The approved network rules live in `.cws/sandbox/rules.json` and the policy that OpenShell reads is derived from them (`.cws/sandbox/policy.yaml`), so the file a human approves and the file the sandbox enforces cannot drift apart:
  - `cws sandbox policy --rule <spec>` is the human decision; it refuses wildcard hosts, query strings, method-less paths and plain-TCP bypasses, then records a `DECISION_RECORDED` carrying the rules.
  - `cws sandbox run -- <command>` recreates a sandbox with that policy for each run, uploads the project at `/sandbox`, runs one command and passes its exit code back; `--claim <id>` attaches the run as evidence.
  - `cws sandbox rules` lists what OpenShell held back; `--approve`/`--reject` need an interactive challenge code and record the decision with the chunk id.
  - Any failed tool run exits non-zero, so a broken sandbox is never mistaken for a working one.
- **Settings** live in `.cws/integrations.json` (sandbox mode, WSL distribution, remote gateway, tool paths). It is read-only for agents; a broken file falls back to the defaults and says so.

## 9. Out Of Scope For Integrations

A sandbox runtime is optional: without OpenShell, `safe-run` remains the guard and CWS works unchanged. Windows batch shims (`.cmd`/`.bat`) are refused rather than run through `cmd.exe`, so tools installed that way are used through WSL. MCP and remote execution stay out until the local flow is proven. Inside a kept sandbox CWS only runs one command per sandbox: a second command would need SSH (`openshell sandbox ssh-config`), which is deferred, and OpenShell's boundary prover is not wired up yet — the policy is checked by CWS's own validators, not proven by OpenShell.
