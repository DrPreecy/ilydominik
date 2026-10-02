# CWS v2: Cognitive Work System

You think. CWS keeps the structure: your raw thoughts, what you said vs. what an AI guessed, open questions, risky assumptions, decisions and why, and what to do next. It also hands any AI assistant (Copilot, Claude Code, Gemini/Antigravity) a ready-made prompt with the right context, so you never paste context by hand.

Intent: [`../starttoughts.md`](../starttoughts.md). Spec: [`docs/spec.md`](docs/spec.md).

## Install (once)

```bash
cd v2
pnpm install
npm run build
npm link            # makes `cws` available in every terminal
```

## Start a project (in any folder)

```bash
cws init "My idea"
cws install-agents          # AGENTS.md + /cws-* commands for Copilot, Claude Code, Gemini
cws session start "what I want to get out of today"
cws dump "whatever is in my head, messy is fine"
```

## Daily loop

| You want to… | Run |
|---|---|
| see where you are | `cws status` |
| know what to do next | `cws next` |
| get the ready prompt for option N (copied to clipboard) | `cws prompt 1 --copy` |
| use it in your AI tool | type `/cws-explore`, `/cws-understand`, `/cws-proof`, … (Copilot Chat, Claude Code, Antigravity) |
| check what the AI suggested | `cws review` (accept / reject / confirm) |
| decide something | `cws decide --title … --options a,b --selected a --rationale …` |
| move phase (back is always fine) | `cws phase understanding --reason "…"` |
| stop for today | `cws session end --summary "…"` (writes a handoff in `.cws/sessions/`) |

## Rules the system keeps for you

- **AI suggests, you decide.** Agents run commands with `--agent <name>`. They can record interpretations, assumptions, open questions and evidence, all marked as *unconfirmed AI*. Facts, your statements, decisions, status changes and phase changes only happen when you accept them.
- **Warnings, not walls.** CWS never blocks you. When you go ahead despite open risks, it asks why (`--accept-risk "…"`), records that as a decision, and reminds you until the risk is resolved.
- **Nothing is lost.** Everything is an append-only log in `.cws/events.jsonl`. `cws log` shows history; `cws verify` detects manual edits.

## Known limits (honest)

- An AI with shell access *could* forge entries. CWS makes that deliberate and visible (challenge codes for decisions, a hash-chained log), not impossible.
- Human commands need a real terminal. Piping text into `cws dump -` as a human is refused; type it or pass it as an argument.
- The Antigravity workflow folder (`.agent/workflows/`) follows community docs; check that `/cws-*` shows up in your Antigravity version.
- There's no MCP server yet; agents use the CLI in their terminal.

## Develop

`npm test` (108 tests incl. the v1 attack probes) · `npm run typecheck` · `npm run coverage`
