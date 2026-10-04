import { logsArgs } from '../../../integrations/openshell/args.ts';
import { CliExit, type Env } from '../../human.ts';
import { EXIT } from '../../io.ts';
import { openshellFor, report, runOpenshell, sandboxContext } from './shared.ts';

export async function logs(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx);
  const result = await runOpenshell(launch, ctx, logsArgs(ctx.name, false), 120_000);
  report(env, `sandbox logs ${ctx.name}`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}
