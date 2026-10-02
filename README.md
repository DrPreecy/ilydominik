# Cognitive Work System

The canonical application is the event-sourced CLI in [v2/README.md](v2/README.md).
Root commands now run and verify that implementation. This is entrypoint
consolidation, not a merge of the two state models or an automatic data migration.

## Setup and Run

Install both packages from this directory (their dependency sets remain separate):

```bash
pnpm install --frozen-lockfile
pnpm --dir v2 install --frozen-lockfile
npm run build
npm run cws -- --help
```

`npm run cws -- <arguments>` runs canonical source in this repository's working
directory. It deliberately does not use `npm --prefix v2` to launch the CLI:
that would select `v2/` as the project directory.

For use in another project, install the built CLI globally from its package:

```bash
cd v2
npm link
cd /path/to/your/project
cws init "My idea"
cws status
```

The built entrypoint is `v2/dist/cli/main.js`; root `npm run build` produces it.
See the [CLI guide](v2/README.md) for sessions, prompts, review, and known limits.

## Verification

```bash
npm test
npm run typecheck
npm run build
npm run coverage
```

`npm test` runs v2's suite and the root routing regressions. Coverage measures
the canonical suite, with minimums of 80% lines/functions and 75% branches.
See [REVIEW.md](REVIEW.md) for measured results and remaining work.

GitHub Actions runs these checks on Windows and Ubuntu using Node 24. External
research attempts and the unverified source queue are in [RESEARCH.md](RESEARCH.md).

## Historical Compatibility

Root [src/index.ts](src/index.ts), [tests/state-machine.test.ts](tests/state-machine.test.ts),
[specs/state-machine-spec.md](specs/state-machine-spec.md), and
[schemas/project-state.schema.json](schemas/project-state.schema.json) describe
the historical v1 snapshot model, not the canonical CLI contract.

```bash
npm run legacy:test
npm run legacy:typecheck
npm run legacy:build
```

The existing root package `main` remains `dist/index.js` for historical imports;
only `legacy:build` produces that artifact now. Canonical build output is under
`v2/dist/`. These are intentionally different APIs. Keeping the historical API
and data avoids silently breaking consumers or rewriting user records. No legacy
source, session data, or prior worktree changes were deleted or migrated.

The current specification is [v2/docs/spec.md](v2/docs/spec.md); the rationale
for replacing v1 is [the rebuild decision](v2/docs/decisions/0001-rebuild-v2.md).
