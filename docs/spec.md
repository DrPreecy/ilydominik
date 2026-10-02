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
- **`cws findings ingest`** turns tool output (SARIF 2.1.0, `ocr review --format json`, or CWS's own JSON, at most 10 MB) into `HYPOTHESIS` claims:
  - Findings are always recorded as AI: as `--agent <name>`, or, when a human runs it without `--agent`, as the tool itself. Outside a terminal `--agent` is required.
  - Severity maps to risk. A fingerprint (tool, rule, place) at the start of the claim text prevents duplicates; only claims that ingest wrote count, and `claim add`/`propose` refuse that prefix.
  - Each run records at most `--limit` new findings and says how many remain; a re-run records only what is not recorded yet.
  - SARIF paths inside the project are stored repo-relative; paths outside it are shown as external.
  - Secrets (keys, tokens, Bearer/Authorization headers, short `password=` values) are redacted before storing, and again in every context pack.
  - Findings are never facts — the human marks them supported or falsified (or retires them) in `cws review`, and that verdict is what measures how much a tool is worth trusting.
- **`cws sandbox`** wraps NVIDIA OpenShell when it is installed. The approved network rules live in `.cws/sandbox/rules.json`, checked against a strict schema, and `.cws/sandbox/policy.yaml` is regenerated from them before every `up` and `run`, so a hand-edited policy file is never what the sandbox enforces:
  - `cws sandbox policy --rule <spec>` is the human decision and needs an interactive challenge code. It refuses wildcard hosts, query strings, method-less paths, plain-TCP bypasses, and loopback, link-local and metadata hosts, then records a `DECISION_RECORDED` carrying the rules.
  - `cws sandbox run -- <command>` makes three OpenShell calls, the sequence OpenShell's own end-to-end tests use: `sandbox create --detach --upload .:/sandbox` (OpenShell refuses `--upload` together with a command), `sandbox exec -n <name> --workdir /sandbox -- <command>`, then `sandbox delete` unless `--keep` is given. The command's exit code is passed back; `--claim <id>` attaches a command that ran as evidence. If the sandbox cannot be created, nothing runs and nothing is attached.
  - `cws sandbox up --provider <name>` attaches credentials and so also needs the challenge code.
  - `cws sandbox rules` lists what OpenShell held back; `--approve`/`--reject` need an interactive challenge code and record the decision with the chunk id.
  - Mode `off` refuses `up` and `run`; mode `wsl` runs `openshell` through `wsl.exe` with translated paths.
  - Any failed tool run exits non-zero (a timed-out tool is killed with its whole process tree), so a broken sandbox is never mistaken for a working one.
- **Settings** live in `.cws/integrations.json` (sandbox mode, WSL distribution, remote gateway). Tool paths in that file are ignored, because a cloned repository must not choose which programs `cws doctor` runs; override a tool with the `CWS_TOOL_OCR`, `CWS_TOOL_OPENSHELL` or `CWS_TOOL_PROVER` environment variable instead. A broken file falls back to the defaults and says so.

## 9. Out Of Scope For Integrations

A sandbox runtime is optional: without OpenShell, `safe-run` remains the guard and CWS works unchanged. Windows batch shims (`.cmd`/`.bat`) are refused rather than run through `cmd.exe`, so tools installed that way are used through WSL. MCP and remote execution stay out until the local flow is proven. `cws sandbox run` always creates its own sandbox; a further command in a kept sandbox is `openshell sandbox exec` directly. OpenShell's boundary prover is not wired up yet — the policy is checked by CWS's own validators, not proven by OpenShell.

The project is uploaded as `.` with openshell running in the project directory, because OpenShell splits `LOCAL:DEST` at the first colon and a drive letter would break it (`parse_upload_spec` in the OpenShell CLI); in `wsl` mode `wsl.exe` carries that directory over. The OpenShell argument lists were checked against the OpenShell CLI source and its end-to-end harness, not against a live gateway. The Open Code Review calls were run against the real `ocr` 1.12.11 binary. A host name that resolves to a private address (DNS rebinding) cannot be recognised from the name alone; only the human approval stands in its way.
