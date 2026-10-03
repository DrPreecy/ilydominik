# ADR 0002 - Consolidate CWS into one root package

- Status: accepted (2026-10-02)
- Context: The repository had a root package that delegated to a nested canonical package. That preserved history, but it made every task pay a navigation and verification tax.
- Decision: `cws` is the single root package. Active code lives in `src`, tests in `tests`, prompts in `prompts`, and product docs in `docs`. Historical v1 material lives under `archive/v1` only.
- Consequences:
  - CI installs dependencies once at the root.
  - Nested package manifests and lockfiles are forbidden unless a future ADR approves a real workspace split.
  - Agents must run `npm run verify:repo` before reporting structural work as done.
