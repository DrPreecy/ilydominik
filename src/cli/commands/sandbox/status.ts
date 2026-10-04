import path from 'node:path';
import { say, type Env } from '../../human.ts';
import { readRules, rulesProblem, sandboxContext, sandboxSetup } from './shared.ts';

export async function status(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const setup = await sandboxSetup(ctx);
  const rules = await readRules(ctx.rulesFile).then(
    (list) => `${list.length} approved network rule${list.length === 1 ? '' : 's'}`,
    (error: unknown) => rulesProblem(ctx, error),
  );
  const openshell = setup.openshell === null ? null : [setup.openshell.file, ...setup.openshell.prefix].join(' ');
  say(
    env,
    `Sandbox: ${ctx.name}`,
    `Mode: ${setup.mode}${setup.loaded.config.sandbox.mode === 'auto' ? ' (auto)' : ''}`,
    `Policy: ${path.relative(ctx.root, ctx.policyFile)} — ${rules}`,
    `openshell: ${openshell ?? 'not found'}`,
    ...(setup.loaded.problem === undefined ? [] : [`Settings problem: ${setup.loaded.problem}`]),
    ...(setup.loaded.ignored === undefined ? [] : [`Ignored: ${setup.loaded.ignored}`]),
    '',
    openshell === null
      ? 'Without OpenShell, `cws safe-run` is the guard and agent work is not isolated.'
      : 'Next: `cws sandbox policy --rule <host:port>` to allow access, then `cws sandbox up`.',
  );
}
