---
name: repo-structure-guardian
description: Use when creating, moving, deleting, or reviewing files in this repo, adding dependencies, changing build/test config, or finishing a task; enforces CWS file placement and repo hygiene.
---

# Repo Structure Guardian

Keep the CWS repository easy to navigate and keep the single-package shape intact.

## When To Use

- Before creating, moving, or deleting files.
- When adding imports or dependencies.
- When changing `package.json`, `tsconfig*.json`, CI, VS Code tasks, or scripts.
- Before reporting a task complete.

## Workflow

1. Identify the intended file home using root `AGENTS.md`.
2. Put production code in `src`, tests in `tests`, prompts in `prompts`, maintained docs in `docs`, and automation in the appropriate tool folder.
3. Keep historical material under `archive/v1` only when it is explicitly reference material.
4. Do not create nested package manifests, lockfiles, or a replacement split package without an ADR.
5. If an import uses a third-party package, confirm it is declared in root `package.json`.
6. Before handoff, run:

```bash
npm run verify:repo
```

If the scan fails, fix the structure first or clearly report the blocker.
