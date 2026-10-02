# CWS: Cognitive Work System

You think. CWS keeps the structure: your raw thoughts, what you said vs. what an AI guessed, open questions, risky assumptions, decisions and why, and what to do next. It also hands any AI assistant (Copilot, Claude Code, Codex, Gemini/Antigravity) a ready-made prompt with the right context, so you never paste context by hand.

Intent: [starttoughts.md](starttoughts.md). Spec: [docs/spec.md](docs/spec.md). Workflow (as blocks): [docs/workflow.md](docs/workflow.md).

## Install

```bash
pnpm install
npm run build
npm link
```

### In the cloud (GitHub Codespaces)

No local Docker or strong PC needed. On GitHub, choose **Code → Codespaces → Create codespace**. The setup in [.devcontainer](.devcontainer) installs CWS (`cws` is on the PATH), Docker, and the Claude Code, Codex, Gemini and Copilot command-line tools, so every agent works the same way.

- **Sign in once per new Codespace.** No API keys: CWS expects you to use the subscriptions you already have. `gh auth login` for Copilot, then `claude`, `codex login` and `gemini` for the others. A Codespace keeps its sign-in until it is deleted, so a fresh one needs a fresh sign-in.
- Run `cws doctor` to see what this machine has: host kind, project memory, and every tool with its version.
- Stop the Codespace when you are done; unused Codespaces are deleted after 30 days.
- Your memory lives in `.cws/`, which is not in git. `cws session end` saves a backup to `.cws/backups/` there; download it (right-click → Download).

| You want to | Run |
| --- | --- |
| save everything to one file | `cws export --to my-project.json.gz` |
| restore it in a new Codespace | `cws import my-project.json.gz` |

Import only adds newer events. If both sides changed, it stops; `--replace` overwrites local memory after you confirm.

## Start a Project

```bash
cws init "My idea"
cws install-agents
cws session start "what I want to get out of today"
cws dump "whatever is in my head, messy is fine"
```

## Daily Loop

| You want to | Run |
| --- | --- |
| see what this workspace has | `cws doctor` |
| see where you are | `cws status` |
| know what to do next | `cws next` |
| get the ready prompt for option N | `cws prompt 1 --copy` |
| see what a code review must cover | `cws review-code --from main --to HEAD` |
| record review findings | `cws findings ingest results.sarif` |
| see open findings | `cws findings list` |
| allow a sandbox to reach one host | `cws sandbox policy --rule api.github.com:443` |
| run one command isolated | `cws sandbox run -- <command>` |
| answer a blocked network request | `cws sandbox rules --approve <chunk-id>` |
| check what the AI suggested | `cws review` |
| decide something | `cws decide --title ... --options a,b --selected a --rationale ...` |
| move phase | `cws phase understanding --reason "..."` |
| stop for today | `cws session end --summary "..."` |

## Code Review

Code review is split so the deterministic part is a tool's job and the judgement stays with your agent:

1. `cws review-code` runs [Open Code Review](https://github.com/alibaba/open-code-review) in delegation mode. That needs no model key: it only lists which files would be reviewed and which rule applies to each file, and every file must end as reviewed or as an explained skip.
2. Your agent reviews the files with its own model and records what it finds: `cws findings ingest --agent <name> --format cws -` (JSON on stdin), or point it at tool output such as `--format sarif` for Semgrep, CodeQL or `ocr review --format sarif`.
3. Every finding becomes an AI hypothesis in the log with a severity-derived risk and a fingerprint, so re-running a tool adds nothing twice. You confirm, fix or mark it false with `cws review` — and that verdict is what later tells CWS how much to trust a tool.

Secrets are redacted before anything is stored, and OCR is installed separately (`npm i -g @alibaba-group/open-code-review`). Without it, `cws doctor` says so and the rest of CWS still works.

## Sandbox (optional)

`safe-run` guards a command; it does not isolate it. When [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) is installed, CWS can put agent work in a sandbox whose network access is a file you approve:

1. `cws sandbox policy --rule api.github.com:443` writes `.cws/sandbox/policy.yaml` and records the decision. Nothing else is reachable — no wildcards, no query strings, no plain-TCP bypass. This is a human command.
2. `cws sandbox run -- <command>` creates a sandbox with that policy, uploads the project, runs one command and reports its exit code. Add `--claim <id>` to attach the run as evidence.
3. A request the sandbox is not allowed to make becomes a pending rule. `cws sandbox rules` lists them; `cws sandbox rules --approve <chunk-id>` (with a confirmation code) or `--reject <chunk-id> --reason "..."` answers one, and your answer is recorded as a decision.

Without OpenShell, `cws sandbox status` says so and everything else keeps working. The sandbox is the one place CWS relies on an outside tool for the guarantee; it never fakes that guarantee itself.

## Rules

- **AI suggests, you decide.** Agents run commands with `--agent <name>`. They can record interpretations, assumptions, open questions, and evidence, all marked as unconfirmed AI. Facts, your statements, decisions, status changes, and phase changes only happen when you accept them.
- **Warnings, not walls.** CWS never blocks you. When you go ahead despite open risks, it asks why, records that as a decision, and reminds you until the risk is resolved.
- **Nothing is lost.** Everything is an append-only log in `.cws/events.jsonl`. `cws log` shows history; `cws verify` detects edits to past entries.

## Known Limits

- An AI with shell access could forge entries. CWS makes that deliberate and visible with challenge codes and a hash-chained log, not impossible.
- Human commands need a real terminal. Piping text into `cws dump -` as a human is refused; type it or pass it as an argument.
- There is no MCP server yet; agents use the CLI in their terminal.
- `safe-run` is an advisory native-executable guard, not a sandbox.

## Develop

From the repository root:

```bash
npm run format:check
npm run typecheck
npm run build
npm test
npm run coverage
npm run verify:repo
```

`npm run verify` runs the full local gate. Historical v1 material is archived in [archive/v1](archive/v1) and is not part of the active package, tests, or build.
