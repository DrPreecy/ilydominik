# CWS Repo Instructions

## Canonical Structure

- `src/` - active TypeScript source for the `cws` CLI.
- `tests/` - active automated tests.
- `prompts/` - source prompt templates loaded by the CLI.
- `docs/` - current product spec, ADRs, and maintained project docs.
- `scripts/` - local maintenance and verification scripts.
- `.agents/skills/` - repo-scoped Codex skills.
- `.github/` - CI and editor/agent integration files.
- `.devcontainer/` - GitHub Codespaces / dev container setup shared by every agent.
- `archive/v1/` - historical v1 material only; never import from it or include it in active checks.

## File Placement Rules

- Choose the file's home before creating it. Do not create scratch files in the repo root.
- New production code goes under `src/`; matching tests go under `tests/`.
- New durable process or architecture notes go under `docs/`.
- New automation belongs under `scripts/`, `.github/`, `.vscode/`, `.devcontainer/`, or `.agents/skills/` according to the surface it serves.
- Do not add nested `package.json` or lockfiles unless an ADR explicitly creates a workspace split.
- All external package imports must be declared in the root `package.json`.

## Finalization

After code, docs, config, dependency, or file-structure changes, run:

```bash
npm run verify:repo
```

For implementation work, also run the narrowest relevant tests, and prefer `npm run verify` before handoff.
