# Consolidation Review

Date: 2026-10-02. Scope: canonical entrypoint consolidation, independent
correctness/security audits, regression fixes, and public release preparation.

## Completed

- Fixed a verification-routing defect: root build/test/typecheck previously
  checked only v1, leaving the canonical application unchecked by default.
- Root verification now targets v2; root CLI launches v2 without changing the
  selected project directory. Explicit `legacy:*` scripts preserve v1 checks.
- Three routing regressions failed before the script change and passed after it.
- Added a root guide distinguishing canonical contracts from historical ones;
  corrected the stale canonical test count in the v2 guide.
- Repaired live-writer lock takeover, guarded-delete argument and physical-path
  checks, handoff path traversal/retry, and installer symlink destinations.
- Updated nine obsolete prompt recording sections; context now carries
  proposals, evidence, session summaries, and explicit untrusted-data boundaries.
- Added type/status validation, atomic risk/phase/proposal transactions, stable
  guidance selection, full confirmation text, and sanitized terminal output.
- Recovery ownership is atomic; abandoned markers fail closed with actionable
  manual guidance rather than being automatically deleted by contenders.
- Added Windows/Ubuntu CI, runtime-state exclusions, and the declared MIT license.
- Preserved prior work, historical APIs, source, data, and commit history.
  No dependency change, source relocation, or automatic model/data merge was done.

## Verification Evidence

| Check | Baseline | Consolidated result |
| --- | --- | --- |
| Root tests | 7 historical tests passed | 173 canonical + 3 routing tests passed |
| Direct v2 tests | 139 passed before new regressions | 173 passed after repairs |
| Root typecheck/build | Historical compilation passed | Canonical compilation passed |
| Direct v2 typecheck/build | Passed | Canonical root scripts invoke these commands |
| Explicit legacy tests/typecheck/build | Previously implicit root defaults | 7 tests passed; compilation passed |
| Root coverage | No root command | 98.17% lines, 98.31% functions, 89.52% branches; gate passed |
| Root CLI argument forwarding | No root command | `npm run cws -- --help` passed |
| Root CLI working directory | No root command | `safe-run --check -- rm -rf dist` resolved to repository `dist`, not `v2/dist`; no deletion executed |
| Built CLI smoke | Build passed | `node v2/dist/cli/main.js --help` passed |

Coverage is for modules exercised by the canonical tests, not proof of every
unexecuted production path. Runtime TTY/challenge and clipboard integration
remain outside this smoke test. No baseline test or compilation failure was
observed; new regressions intentionally failed before implementation. The final
suite initially exposed a stale provenance-display assertion; it now checks
structured AI/human attribution and passes. Frozen installs pass for both packages.

## Good

- One default verification path now covers the event-sourced CLI rather than
  reporting only the historical MVP's results.
- Canonical tests cover domain rules, CLI behavior, event-log integrity,
  guidance, agent installation, and the existing command guard.
- Existing historical behavior remains accessible without being presented as
  the current application's contract.
- Independent final review found no confirmed HIGH/CRITICAL issue or test blocker.
- The public-release scan found no credential-pattern matches in 81 candidate
  files, 98 local Git blobs, or 16 commit objects. This is not a guarantee against
  every secret format. Existing Git authorship metadata is retained.

## Bad and Open

- This is routing consolidation, not physical unification: two package installs,
  two build outputs, and separate lockfiles remain. A destructive move would
  risk historical imports and existing project data; it was not justified here.
- Root package metadata still exposes the historical library `main`. Consumers
  must use `legacy:build` for it or the v2 CLI package for current behavior.
- No v1-to-v2 data migration exists. Define and test a migration only after a
  real need and an explicit compatibility contract are established.
- Human challenges and hash chaining are friction/integrity checks, not an
  authorization boundary against an agent with filesystem or shell access.
  See [known limits](v2/README.md) and [the decisions](v2/docs/decisions/0001-rebuild-v2.md).
- Real-terminal review, clipboard, installed-client slash commands, abrupt real
  process death, and Ubuntu execution still need platform-level validation.
  GitHub CI is configured but is not claimed to have executed locally.
- Abandoned recovery markers require quiescent manual cleanup. Hard-link
  support is required; PID reuse can conservatively block recovery. Do not
  remove locks based solely on age or while writers may restart.
- The command guard is advisory, not a sandbox. Arbitrary executables and
  concurrent filesystem changes cannot be fully contained by pathname checks.
- Context serialization reduces structural ambiguity but does not guarantee
  prompt-injection resistance or authorize decisions from stored text.
- Session/confirmation proposal intents and v1 data migration remain future work.
- All 22 external source fetches were blocked by network policy. Research is
  explicitly unverified in [RESEARCH.md](RESEARCH.md). Explicit cheaper-model
  selection was unavailable; named-agent availability also varied, so final
  independent review used the available fallback workers.

## Handoff

Use [README.md](README.md) as the repository entrypoint and the v2 spec for new
work. Re-run the root commands above after integrating audit findings. Keep
historical model changes explicit and do not silently migrate records or delete
legacy files. The original [NEXT_SESSION.md](NEXT_SESSION.md) content is retained
as historical planning material with a current entrypoint note.
