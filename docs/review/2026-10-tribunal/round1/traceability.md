# Traceability matrix (Claude dept, docs component, round 1)

Method: every normative sentence (must / never / always / only / refuses / requires / cannot) in docs/spec.md, README.md, AGENTS.md,
docs/decisions/0001-0003, docs/workflow.md, docs/google-setup.md was extracted, mapped to src/ by grep + reading, and mapped to a test.
"Test proves" was checked for the 14 most security-relevant rules by MUTATION (line removed in a scratch copy, relevant suites re-run, see bottom table)
and for 6 `fix:` commits by REVERTING the src hunks (see "Regression archaeology").
Verdicts: **C+T** code and a test that fails when the code is removed; **C** code, no (or only vacuous) test; **N** no code; **F** doc claim is false (witness in docs-ci.json).

| # | Source | Rule (abridged) | Code | Test proving it | Verdict |
|---|---|---|---|---|---|
| R1 | spec §1 | Truth = append-only log `.cws/events.jsonl`, state = pure fold | src/domain/reducer.ts, src/store/event-log.ts | tests/reducer.test.ts, tests/event-log.test.ts | C+T |
| R2 | spec §1 | Claim status chain OPEN->TESTING->SUPPORTED/FALSIFIED, UNKNOWN->ANSWERED, anything->RETIRED (kept for history) | reducer.ts assertClaimStatus (checks status set per type only, NOT a transition relation) | none for illegal transitions | **F** (Q-14: RETIRED->OPEN, FALSIFIED->OPEN accepted) |
| R3 | spec §1 | Every item stores actor, phase, session, time, derivedFrom | domain/schema.ts, reducer.ts | reducer.test.ts | C+T |
| R4 | spec §2 | Reducer enforces authority by actor KIND, AI only via proposal | reducer.ts:164 + HUMAN_ONLY_EVENTS (types.ts) | adversarial-domain.test.ts, reducer.test.ts, hardening.test.ts | C+T |
| R5 | spec §2 | AI cannot accept/reject proposals ("never") | reducer.ts HUMAN_ONLY_EVENTS | adversarial-domain.test.ts, gemini.test.ts:224 | C+T |
| R6 | spec §2 | human decide/accept/confirm/mark/retire/phase/review need interactive challenge code | human.ts confirmDecision; decisions.ts, proposals.ts, review.ts | cli.test.ts:245 (decide only wrong-code), hardening.test.ts:179 (claim add FACT, retire) | **see mutation table** (confirm/mark/phase/accept/review are the ones to read) |
| R7 | spec §2 | human FACT/USER_STATEMENT claim needs code | capture.ts:38 | hardening.test.ts:179 | see mutation table |
| R8 | spec §2 | non-interactive calls without --agent are refused | human.ts requireHuman / requireHumanUnlessAgent in every command file | cli.test.ts:239, backup.test.ts:165, findings-hardening.test.ts:78 | see mutation table |
| R9 | spec §2 | `cws verify`/`status` detect edits to or reordering of existing events | domain/hash.ts verifyChain, project.ts | event-log.test.ts, backup.test.ts, redteam | C+T |
| R10 | spec §2 | (honest limit) appended/truncated/re-hashed log NOT detected | n/a (documented gap) | n/a | n/a (limit is itself documented; HMAC deferred) |
| R11 | spec §3 | 8 warning codes (UNTESTED_RISK ... PHASE_SKIP) | guidance/warnings.ts | guidance.test.ts (FALSIFIED_PREMISE, OPEN_CRITICAL_UNKNOWN, SUPPORTED_WITHOUT_EVIDENCE, OVERRIDE_UNRESOLVED, PENDING_PROPOSALS, UNCONFIRMED_AI_CLAIMS, PHASE_SKIP; UNTESTED_RISK in cli.test) | C+T |
| R12 | spec §3 / README / workflow I4 | Humans never blocked; risky forward phase move asks why via --accept-risk, records PROCEED_UNDER_UNCERTAINTY | cli/override.ts, decisions.ts:96 | hardening.test.ts (accept-risk), cli.test.ts | C+T |
| R13 | spec §4 | Any phase -> any phase; backward move lists possibly affected, changes none | reducer.ts:267, decisions.ts | reducer.test.ts, cli.test.ts | C+T |
| R14 | spec §5 | nextSteps <=3 options, always incl. phase default; prompt N renders prompts/<purpose>.md + context pack | guidance/next-steps.ts, render.ts, context-pack.ts | guidance.test.ts, cli.test.ts | C+T |
| R15 | spec §6 | install-agents writes AGENTS.md + wrappers `.github/prompts/cws-*.prompt.md`, `.claude/commands/cws-*.md`, `.agent/workflows/cws-*.md` (also writes CLAUDE.md/GEMINI.md, spec omits) | agents/install.ts:117-128 | install-agents.test.ts | C+T (doc incomplete, Q-17) |
| R16 | spec §8 | exec: arg list, never a shell, timeout, output cap, answer validated | integrations/exec.ts | integrations.test.ts (timeout, cap, tree-kill, shell-looking args) | C+T |
| R17 | spec §9 | .cmd/.bat shims refused, not run via cmd.exe | exec.ts | integrations.test.ts, hardening.test.ts | C+T |
| R18 | spec §8 | doctor: missing tools are not errors | doctor.ts | integrations.test.ts "always exits cleanly" | C+T |
| R19 | spec §8 / README | Tool paths only from CWS_TOOL_* env, never repo files; broken integrations.json falls back and says so | integrations/config.ts | integrations.test.ts, sandbox.test.ts:454 | C+T |
| R20 | spec §8 | cws ai: actor ai:gemini only, masks secrets, validates schema, unconfirmed events | integrations/gemini.ts, ai.ts | gemini.test.ts:196,224,289 | C+T |
| R21 | spec §8 / ADR3 | cws ai: daily limit, token caps, one-time consent recorded in log | ai.ts:53-99, gemini.ts:98 | gemini.test.ts:119,169,181; NO test for input/output token cap | C+T for limit+consent, **C** for cap |
| R22 | spec §8 | cws sync path users/{uid}/projects/{pid}/events/{seq}; local log canonical; push verifies ancestry & halts; pull validates schema+chain | cloud/sync.ts | cloud/sync.test.ts | C+T |
| R23 | spec §8 / ADR3 | Credentials in OS config dir, never repo / `.cws/` | cloud/auth.ts | cloud/auth.test.ts | C+T (mode 0600 is POSIX-only, cloud-auth dept) |
| R24 | spec §8 | findings ingest: input <=10 MB | findings.ts:28 (10,000,000 UTF-16 chars, not bytes) | findings-hardening.test.ts "refuses input larger than the cap" | C+T but claim drifts (Q-16) |
| R25 | spec §8 | findings always recorded as AI; outside a terminal --agent required | findings.ts:92, human.ts | findings-hardening.test.ts:78 | see mutation table (findings.ts:92) |
| R26 | spec §8 | fingerprint prefix dedupe; claim add/propose refuse that prefix; only ingest-written claims count | findings/ingest.ts, capture.ts, proposals.ts | findings-hardening.test.ts "hand-written claim carrying a marker does not pre-empt" | C+T |
| R27 | spec §8 | --limit caps new findings and reports remainder; re-run records only new | findings.ts, ingest.ts | findings-hardening.test.ts | C+T |
| R28 | spec §8 | SARIF paths in project repo-relative, outside shown external | findings/sarif.ts, types.ts | findings-hardening.test.ts:205 | C+T |
| R29 | spec §8 / README | Secrets redacted before storing and in every context pack | findings/types.ts redactSecrets, context-pack.ts | findings.test.ts, findings-hardening.test.ts (revert of d641151 kills 6 tests) | C+T (I9 depth is findings dept) |
| R30 | spec §8 | Findings never facts; human verdict in cws review | reducer (AI claim types) | adversarial-domain.test.ts | C+T |
| R31 | spec §8 | sandbox: rules.json strict schema; policy.yaml regenerated before every up/run | openshell/policy.ts, sandbox.ts | sandbox.test.ts:94,108,645,657 | C+T |
| R32 | spec §8 | sandbox policy: human + challenge; refuses wildcard/query/method-less path/plain-TCP/loopback/link-local/metadata | sandbox.ts:336-347, policy.ts | sandbox.test.ts:115,157,302,310 | C+T (sandbox.ts:336,347 in mutation table) |
| R33 | spec §8 | sandbox run = create --detach --upload, exec, delete unless --keep; exit code passed; --claim attaches evidence; failed create => nothing runs | sandbox.ts:400-430, openshell/args.ts | sandbox.test.ts:209,564,709,722 | C+T |
| R34 | spec §8 | sandbox up --provider and rules --approve/--reject need challenge | sandbox.ts:364,448 | sandbox.test.ts:682 | see mutation table |
| R35 | spec §8/§9 | mode off refuses; wsl via wsl.exe with translated paths; failed tool => non-zero, timed-out tool killed with tree | config.ts, wsl.ts, exec.ts | sandbox.test.ts:257,671; integrations.test.ts | C+T |
| R36 | spec §9 | OpenShell args "checked against CLI source"; OCR "run against real ocr 1.12.11" | n/a | unverifiable claims (no recorded transcript, no CI job) | N (unverifiable) |
| R37 | README | "`safe-run` blocks shells, interpreters and wrappers (node -e, npx, env, wsl), destructive git forms (reset --hard, force push, clean, aliases), deleting/moving outside project or inside .git/.cws" | safety/command-guard.ts | safety.test.ts, redteam | **F** (Q-13: `git rebase -x`, `bisect run`, `submodule foreach` run arbitrary commands; `git log --output=.git/config` overwrites) |
| R38 | README | `safe-run --check` refuses ; \| < > even inside an argument; run mode does not | command-guard.ts, safety.ts | safety.test.ts (7b36c11 revert kills 2) | C+T |
| R39 | README | Human commands need real terminal; `dump -` piped as human refused | human.ts requireHuman | cli.test.ts:239 | see mutation table |
| R40 | README | export/import: import only adds newer events; diverged/corrupt stops; --replace needs confirmation | store/backup.ts, backup.ts:54-72 | backup.test.ts:119 | C+T (backup.ts:72 in mutation table) |
| R41 | README / devcontainer | post-create installs cws, pnpm, agent CLIs, Docker; `pnpm install --frozen-lockfile` succeeds | .devcontainer/post-create.sh:15 | none (no devcontainer CI job) | **F on 7d7eec9..0a71983** (Q-1) |
| R42 | README Develop / AGENTS | `npm run verify` is the full local gate | package.json verify | n/a | C (but verify fails on any ignored scratch dir, Q-5) |
| R43 | ADR 0001 | Hard blocks remain only for AI actors | reducer.ts | adversarial-domain.test.ts | C+T |
| R44 | ADR 0001 | v1 archived under archive/v1, excluded from build/test/package | check-repo-structure.mjs ignoredDirs, tsconfig include, package.json files | verify:repo | C (but `import '../archive/...'` from src passes the checker, Q-4) |
| R45 | ADR 0002 / AGENTS | Nested package.json / lockfiles forbidden unless ADR approves | check-repo-structure.mjs:52-58 | verify:repo only (no unit test of the script) | C; **contradicts ADR 0003** which authorizes web/package.json (Q-3) |
| R46 | AGENTS | All external imports declared in root package.json | check-repo-structure.mjs checkImports | none | C, bypassable (devDependency satisfies src import; `require()` unscanned, Q-4) |
| R47 | AGENTS | `web/` imports only `cws/core` | none | none | **N** (Q-3) |
| R48 | AGENTS | No scratch files in repo root | none (starttoughts.md sits in root; checker has no root allowlist) | none | N |
| R49 | AGENTS | Run `npm run verify:repo` after changes | package.json, CI last step | CI | C |
| R50 | ADR 0003 | Local log canonical; cloud = mirror | cloud/sync.ts | cloud/sync.test.ts | C+T |
| R51 | ADR 0003 | Gemini cannot decide/accept/confirm/phase-change | reducer.ts | gemini.test.ts:224 | C+T |
| R52 | ADR 0003 | Explicit one-time interactive consent recorded in the log before prompts are sent | ai.ts:66-99 | gemini.test.ts:119,169 | C+T |
| R53 | ADR 0003 | Dashboard v1 strictly read-only | firestore.rules: `allow write: if isOwner(uid)` on project doc, `create` on events for ANY owner-authenticated client | tests/firebase/rules.test.ts is **0 bytes**, CI never runs `test:rules` | **C-only / F** (Q-2, Q-15) |
| R54 | ADR 0003 | Cross-user access forbidden, events immutable (update/delete false) | firestore.rules | none (see R53) | C, no test (I13) |
| R55 | ADR 0003 | cws/core browser-safe (WebCrypto) | core/index.ts, domain/hash.ts | tests/core/browser-safe.test.ts (static import-graph scan) | C+T (regex-based; core-export dept) |
| R56 | ADR 0003 | No API keys/tokens in repo or `.cws/`; GEMINI_API_KEY from env only | gemini.ts:69, auth.ts | gemini.test.ts:317, cloud/auth.test.ts | C+T |
| R57 | ADR 0003 | `web/` reserved for workspace split with pnpm-workspace.yaml + web/package.json | check-repo-structure.mjs rejects web/package.json | none | **F** (Q-3) |
| R58 | google-setup | `npm test`/`npm run verify` stay 100% offline, no Java | tests/firebase/rules.test.ts empty => trivially true | n/a | C (vacuously; the Java-requiring test does not exist) |
| R59 | google-setup | Never put API key in git files | .gitignore .env*, redaction | history scan: clean (only fixtures) | C+T |
| R60 | workflow.md | I1-I7 board rules; "warnings, not walls"; Step 0 Frame in every prompt; session --done/--not | prompts/*.md (10/10 contain "Step 0"), session.ts | cli.test.ts, guidance.test.ts | C+T |
| R61 | workflow.md §3 | "never skip a stage" vs spec §4 "any phase -> any phase" | PHASE_SKIP warning only | guidance.test.ts:106 | doc internally inconsistent; workflow.md marks it ◌ (not enforced) -> honest |
| R62 | review-brief-workflow.md | "uncommitted", "194 tests", "delete after merge" | n/a | n/a | **F** (stale: 423 tests, committed, shipped in npm `files`, Q-17) |

## Coverage numbers

62 rules extracted. Strictly "code AND a test that fails when the code is removed": see summary line at the bottom (authority rows depend on the mutation table).
Rules with **no code**: R36, R47, R48 (+R10 documented gap).
Rules **false or contradicted by the repo**: R2, R37, R41 (historical), R45/R57, R53, R62 (+R24 drift).
Rules with code but **no meaningful test**: R21 (token cap), R46, R53/R54 (rules test file is 0 bytes), R42.


## Tail (continuation worker)

| # | Rule | Result |
|---|---|---|
| R63 | README: `.cws/` is git-ignored | TRUE (git check-ignore -> .gitignore:50) |
| R64 | package.json `test:rules` runs Firestore rules suite | tests/firebase/rules.test.ts is 0 bytes; node --test exits 0 (vacuous); CI never runs it (Q-2) |
| R65 | AGENTS: verify:repo guards structure | web/package.json and src/**/package.json both rejected: contradicts ADR 0003 (Q-3) |
| R66 | `npm run verify` full gate | format:check fails on git-ignored scratchpad/ (Q-5); suite runs twice (Q-6) |
| R67 | devcontainer post-create | unpinned global npm/pip installs; optional() swallows failures (Q-9) |
| R68 | history hygiene | gitleaks hit d641151:tests/findings-hardening.test.ts:221 is placeholder literal glpat-<20-char-fake>, not a real token; HEAD builds fakes at runtime; no CI secret scan (Q-10) |

fix: commits pinned by a test: 058fad9 (store-hardening.test.ts same commit), d641151, 7b36c11, 5c85f46. Broad multi-file fixes (1ffd8cf, fb3dd77, d7f0ea2, c5b3263, 089a6dd, 6935e92) not individually checked; 0d181f6 (lockfile) has no guard.

## Coverage
68 rules. Code + failing-on-removal test: ~44. No code: R36, R47, R48 (+R10 documented gap). False/contradicted: R2, R37, R41(hist), R45/R57, R53, R62, R24. Code without meaningful test: R21 cap, R46, R53/R54, R42, R64.
