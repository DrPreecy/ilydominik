import type { Command } from 'commander';
import { PURPOSES } from '../../domain/types.ts';
import { nextSteps } from '../../guidance/next-steps.ts';
import { renderPrompt } from '../../guidance/render.ts';
import { parsePurpose } from '../stages.ts';
import { fail, openLog, parseCount, say, sayJson, splitList, type Env } from '../human.ts';

async function next(env: Env, opts: { limit?: string; json?: boolean }): Promise<void> {
  const log = await openLog(env);
  const limit = opts.limit === undefined ? 3 : parseCount(env, opts.limit, '--limit');
  const steps = nextSteps(log.state, limit);
  if (opts.json === true) {
    return sayJson(env, { steps: steps.map((s, i) => ({ n: i + 1, purpose: s.purpose, title: s.title, reason: s.reason, refs: s.refs })) });
  }
  const lines = steps.map((s, i) => {
    const refs = s.refs.length > 0 ? ` (refs: ${s.refs.join(', ')})` : '';
    return `${i + 1}. [${s.purpose}] ${s.title} — ${s.reason}${refs}`;
  });
  say(env, ...lines, 'Get the prompt for one:  cws prompt <N> [--copy]');
}

async function prompt(env: Env, nArg: string | undefined, opts: { copy?: boolean }): Promise<void> {
  const log = await openLog(env);
  const n = nArg === undefined ? 1 : parseCount(env, nArg, 'N');
  const step = nextSteps(log.state, Math.max(n, 3))[n - 1];
  if (!step) fail(env, `error: there is no next step number ${n} (see \`cws next\`)`);
  const text = await renderPrompt(log.state, step.purpose, step.refs);
  say(env, text);
  if (opts.copy) say(env, (await env.io.copy(text)) ? 'copied to clipboard' : 'clipboard unavailable');
}

async function context(env: Env, purpose: string, opts: { focus?: string }): Promise<void> {
  const resolved = parsePurpose(purpose);
  if (resolved === undefined) {
    fail(env, `error: unknown purpose "${purpose}" (choose from ${PURPOSES.join(', ')}; stage names like Build work too)`);
  }
  const log = await openLog(env);
  say(env, await renderPrompt(log.state, resolved, splitList(opts.focus)));
}

export function registerGuidance(program: Command, env: Env): void {
  program
    .command('next')
    .description('what to do next, as numbered options')
    .option('--limit <n>', 'how many options')
    .option('--json', 'machine-readable output (see docs/cli-json.md)')
    .action((o: { limit?: string; json?: boolean }) => next(env, o));
  program
    .command('prompt [n]')
    .description('print the ready-to-use prompt for next step n')
    .option('--copy', 'also copy it to the clipboard')
    .action((n: string | undefined, o: { copy?: boolean }) => prompt(env, n, o));
  program
    .command('context <purpose>')
    .description('print the prompt and project context for a purpose (for AI agents)')
    .option('--focus <ids>', 'comma list of ids to focus on')
    .action((p: string, o: { focus?: string }) => context(env, p, o));
}
