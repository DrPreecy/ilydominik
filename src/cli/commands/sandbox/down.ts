import { deleteArgs } from '../../../integrations/openshell/args.ts';
import { CliExit, type Env } from '../../human.ts';
import { EXIT } from '../../io.ts';
import { openshellFor, report, runOpenshell, sandboxContext } from './shared.ts';

export async function down(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx);
  const result = await runOpenshell(launch, ctx, deleteArgs(ctx.name), 120_000);
  report(env, `sandbox ${ctx.name} down`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}
