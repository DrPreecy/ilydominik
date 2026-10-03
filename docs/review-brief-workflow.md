# Review & Merge Brief: CWS Workflow Work (2026-10-02)

This work is uncommitted, and it is mixed into the working tree with the user's own repo restructure.

## Changed by this work

- `docs/workflow.md` (new): the idea→launch workflow drawn as blocks. Linked from `README.md` and `docs/spec.md`.
- `prompts/*.md`: all 10 prompts gain "Step 0 · Frame" and a brain/worker tier. Explore, concept, plan, implement and learn also gain workflow sections. These files use CRLF line endings.
- `src/agents/templates.ts`: protocol items 7–9:
  - agents run the commands themselves;
  - agents tell the human to type `cws`;
  - frame the work first;
  - work as a brain/worker pair.
- Session brief:
  - `cws session start` gains `--done` and `--not`. The handoff gets a "## Brief" section.
  - Files: `src/domain/types.ts`, `src/domain/schema.ts`, `src/domain/reducer.ts`, `src/cli/commands/session.ts`.
  - The new fields are optional, so old logs still replay.
- Guided menu: `src/cli/commands/menu.ts` (new), wired up in `src/cli/app.ts`. Running `cws` with no arguments opens the menu in a terminal and prints help everywhere else.
- `src/cli/main.ts`: `ask()` returns `''` on Ctrl+D.
- Tests: `tests/cli.test.ts`, `tests/reducer.test.ts`, `tests/guidance.test.ts`, `tests/install-agents.test.ts`.
- `docs/review-brief-workflow.md`: this file. Delete it after the merge if it is no longer needed.

## Not part of this work

Everything else in the working tree belongs to the user's restructure: `v2/` flattened into the root, `archive/v1`, and the deleted docs.

## Checks

- `npm run verify` passes: 194 tests, about 98% line coverage.
- One earlier run showed a single failure that did not happen again. Watch for a flaky test.

## Known gaps

- There is no automated test for the Ctrl+D handling.
- The rule that no stage may be skipped is not enforced yet; it is marked ◌ in `docs/workflow.md`.
