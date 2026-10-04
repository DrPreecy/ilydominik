import { ruleApproveArgs, ruleGetArgs, ruleRejectArgs } from '../../../integrations/openshell/args.ts';
import { actorOf, CliExit, confirmDecision, fail, openLog, requireHuman, say, type Env } from '../../human.ts';
import { EXIT } from '../../io.ts';
import { ruleDecisionPayload } from './payloads.ts';
import { openshellFor, report, runOpenshell, sandboxContext } from './shared.ts';

export async function rules(env: Env, opts: { name?: string; status?: string; approve?: string; reject?: string; reason?: string }): Promise<void> {
  if (opts.approve !== undefined && opts.reject !== undefined) {
    fail(env, 'error: use either --approve or --reject, not both. Nothing was changed.');
  }
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx);

  if (opts.approve !== undefined || opts.reject !== undefined) {
    requireHuman(env, opts.approve === undefined ? 'sandbox rules --reject' : 'sandbox rules --approve');
    const chunkId = opts.approve ?? opts.reject ?? '';
    const approving = opts.approve !== undefined;
    say(env, approving ? `Approving network rule ${chunkId}.` : `Rejecting network rule ${chunkId}.`);
    await confirmDecision(env);
    const args = approving ? ruleApproveArgs(ctx.name, chunkId) : ruleRejectArgs(ctx.name, chunkId, opts.reason);
    const result = await runOpenshell(launch, ctx, args, 120_000);
    report(env, approving ? 'rule approve' : 'rule reject', result);
    if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
    const log = await openLog(env);
    await log.append({ type: 'DECISION_RECORDED', actor: actorOf({}), payload: ruleDecisionPayload(chunkId, approving, opts.reason) });
    return;
  }

  const result = await runOpenshell(launch, ctx, ruleGetArgs(ctx.name, opts.status ?? 'pending'), 120_000);
  report(env, 'rule get', result);
  const output = result.ok ? result.stdout.trim() : '';
  say(
    env,
    ...(result.ok ? [output === '' ? `No ${opts.status ?? 'pending'} network rules for ${ctx.name}.` : output, ''] : []),
    'Approve one:  cws sandbox rules --approve <chunk-id>',
    'Reject one:   cws sandbox rules --reject <chunk-id> --reason "scope this to ..."',
    'OpenShell keeps its own gate; cws records your decision in the log.',
  );
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}
