# Machine-readable output (`--json`)

Read commands can print one JSON document instead of text, so scripts and agents do not have to parse prose.

| Command | Fields (besides `schemaVersion`) |
| --- | --- |
| `cws status --json` | `title`, `phase`, `session` (`{id, goal}` or `null`), `counts` (`notes`, `claims`, `decisions`, `pendingProposals`), `integrity` (`{ok: true}` or `{ok: false, brokenAtSeq}`), `warnings[]` (`severity`, `code`, `message`, `refs`), `next` (`{purpose, title, reason, refs}` or `null`) |
| `cws next --json` | `steps[]` (`n`, `purpose`, `title`, `reason`, `refs`); `n` is the number `cws prompt <n>` takes |
| `cws inbox --json` | `proposals[]` (`id`, `kind`, `summary`, `by`, `rationale` or `null`), `unconfirmedClaims[]` (`id`, `type`, `risk`, `text`, `by`) |
| `cws findings list --json` | `findings[]` (`id`, `severity`, `path`, `status`, `text`) |
| `cws log --json` | `events[]` (`seq`, `id`, `at`, `actor`, `type`, `summary`); `--limit` and `--session` still apply |

## Contract

- `schemaVersion` is `1`. A field is only removed or changed in meaning with a new version; new fields may appear.
- Success: exactly one JSON document on stdout, nothing on stderr, exit code `0`.
- Failure: nothing on stdout, a one-line `error: ...` on stderr, exit code `1` (for example: no project here).
- Exit codes are the same as for the text output: `0` ok, `1` error, `2` a human action is needed, `3` the event log failed its integrity check (`cws verify`).
- `status --json` reports a failed integrity check inside the document (`integrity.ok: false`) and still exits `0`; run `cws verify` for the exit code `3`.
- Text control characters in stored text are escaped, so the document is safe to print in a terminal.
