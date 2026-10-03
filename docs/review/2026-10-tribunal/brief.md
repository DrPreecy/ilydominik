# Tribunal brief — adversarial review of CWS (Oct 2026)

Three independent review departments (Claude, Gemini, Copilot) take this repository apart.
This file is the shared contract. Read it fully before you start.

## Rules of evidence
1. **No witness, no finding.** Every finding carries an executable counterexample: an exact command, input, or test
   code that shows the defect. Set `witnessRan: true` only if you actually ran it and saw the result.
2. **Truth is execution, not votes.** Disputes are settled by running the witness on a clean checkout.
3. **Reproduced by someone else.** A finding becomes `reproduced` only when a department other than its author runs the witness.
4. **Fixed ≠ verified.** `verified` = witness test red before, green after, plus the invariant's property test passes.
5. **Blind first.** Round 1 is independent. Do not look for other departments' reports.
6. **Be hostile, be exact.** We want the defects that survive a normal review: things that *look* like they work but don't,
   checks that exist but can be bypassed, tests that pass while the code is wrong. Style nits are out of scope unless they hide a bug.
   No praise, no summaries of what is good.

Output format: `docs/review/2026-10-tribunal/fxp.schema.json` (FXP). Risk R = likelihood × impact (each 1–5).

## Components
domain · store · safety · findings · guidance · cli-ux · integrations-exec · sandbox-openshell · agents-prompts ·
ai-gemini · cloud-auth · cloud-sync · firestore-rules · core-export · ci-tooling · docs · git-history

## Invariants the system must obey
| # | Invariant |
|---|---|
| I1 | Hash chain: ∀i>0: e_i.prevHash = H(e_{i−1}); verify(L) fails iff any byte of an event changed |
| I2 | Authority: ∀e ∈ HUMAN_ONLY_EVENTS: accepted(e) ⇒ actor(e) = human (every event type × actor kind × state) |
| I3 | Claim lifecycle: every status change lies in the allowed relation T ⊆ Status² from `docs/spec.md` |
| I4 | Fold is deterministic and a homomorphism: fold(L₁‖L₂) = reduce*(fold(L₁), L₂) |
| I5 | seq strictly +1, ids unique, `at` valid |
| I6 | Mutual exclusion of writers: N processes × M appends ⇒ \|L\| = N·M and verify(L) |
| I7 | Crash consistency: a kill at any byte offset leaves a log that opens to a verified prefix |
| I8 | Import is idempotent and never silently drops local events |
| I9 | Redaction: no real-world secret format survives `maskSecrets`/`redactSecrets` in any stored or prompted text |
| I10 | Guard soundness: `safe-run` never allows a command whose effect is destructive in a class it claims to cover |
| I11 | Prompt injection: user/AI-written text inside a context pack or prompt cannot raise the authority the prompt grants |
| I12 | Containment: no CLI input resolves a write/delete outside the project (symlink, junction, `..`, UNC, 8.3, `~`) |
| I13 | Firestore rules: allow(r) ⇒ r.auth.uid owns the path, and the dashboard is read-only (ADR 0003) |
| I14 | Spec ⇔ code: every MUST in `docs/spec.md` has a test; every CLI flag has an observable effect |
| I15 | Sync: the local log stays the truth; pull only appends verified, fold-valid events; a hostile remote cannot rewrite/delete local events |
| I16 | Credentials: tokens/API keys never land in the repo, `.cws/`, logs, prompts, or child-process env; stored user-only |

## Attack ideas (not exhaustive — find more)
- Guard bypasses: shell separators (`&`, newline, backtick, `$(`, `^`), `~`/`$HOME`/`%USERPROFILE%`, git subcommands that execute
  or delete (`submodule foreach`, `bisect run`, `rebase -x`, `--upload-pack`, `-c core.hooksPath`, `gc --prune=now`), interpreters, renamed binaries.
  External corpora: GTFOBins, LOLBAS.
- Forged logs whose hash chain is valid but whose content lies (actor.kind, resultId, timestamps, unknown keys).
- Backup/import: path traversal, gzip bombs, symlink/junction races (TOCTOU), oversized inputs, CRLF/BOM, mixed encodings.
- Secrets: every gitleaks rule family; camelCase keys; quoted values with spaces; short passwords; truncated PEM blocks.
- Prompt injection via `cws dump` text, claim titles, findings messages, Gemini output, Firestore documents.
- Cloud: token storage location/permissions, Firestore rule abuse (other uid, writes from the dashboard), pull from a hostile remote,
  offline/partial failures, clock skew, duplicate events, ordering.
- Gemini: consent forgery, quota bypass, unredacted output, partial writes, cost/DoS.
- CLI: flags that are accepted but ignored, exit codes, silent data loss, Windows-specific behaviour.
- Tests: tests that would still pass if the code were wrong (mutation-style thinking), timing/OS flakiness.
- CI/supply chain: lockfile drift, dependency weight (firebase/firebase-tools), unpinned actions, devcontainer scripts.
