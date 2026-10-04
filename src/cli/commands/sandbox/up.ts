import { createArgs, connectArgs } from '../../../integrations/openshell/args.ts';
import { CliExit, confirmDecision, fail, requireHuman, say, type Env } from '../../human.ts';
import { EXIT } from '../../io.ts';
import { createPaths, openshellFor, report, runOpenshell, sandboxContext, syncPolicy } from './shared.ts';

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Providers hand credentials to code in the sandbox, so attaching one is a human decision. */
async function confirmProviders(env: Env, providers: readonly string[]): Promise<void> {
  const bad = providers.find((provider) => !PROVIDER_NAME.test(provider));
  if (bad !== undefined) fail(env, `error: not a provider name: ${bad}`);
  requireHuman(env, 'sandbox up --provider');
  say(env, `Attaching provider credentials to the sandbox: ${providers.join(', ')}.`, 'Code inside the sandbox can use them.');
  await confirmDecision(env);
}

export async function up(env: Env, opts: { name?: string; provider?: string[] }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx, true);
  const providers = opts.provider ?? [];
  const paths = createPaths(env, ctx, launch);
  const rules = await syncPolicy(env, ctx);
  if (providers.length > 0) await confirmProviders(env, providers);
  const result = await runOpenshell(
    launch,
    ctx,
    createArgs({ name: ctx.name, ...paths, providers, approvalMode: 'manual' }),
    600_000,
  );
  report(env, `sandbox ${ctx.name} up`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
  say(
    env,
    `Sandbox ready with ${rules.length} approved network rule(s).`,
    `Open a shell in it: ${['openshell', ...connectArgs(ctx.name)].join(' ')}`,
    'Network requests from inside arrive as pending rules: `cws sandbox rules`.',
  );
}
