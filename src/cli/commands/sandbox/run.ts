import path from 'node:path';
import type { RunResult } from '../../../integrations/exec.ts';
import { createArgs, deleteArgs, execArgs } from '../../../integrations/openshell/args.ts';
import { actorOf, CliExit, fail, openLog, requireAgentForRole, requireClaim, requireHumanUnlessAgent, say, warn, type ActorOpts, type Env } from '../../human.ts';
import { EXIT } from '../../io.ts';
import { runEvidencePayload } from './payloads.ts';
import { createPaths, openshellFor, report, runOpenshell, sandboxContext, syncPolicy, type Launch, type SandboxContext } from './shared.ts';

/** Delete a run's sandbox; a failed delete is reported but never hides the command's own result. */
async function removeSandbox(env: Env, launch: Launch, ctx: SandboxContext): Promise<void> {
  const removed = await runOpenshell(launch, ctx, deleteArgs(ctx.name), 120_000);
  if (!removed.ok) {
    warn(env, `warning: could not delete sandbox ${ctx.name}; remove it with \`cws sandbox down --name ${ctx.name}\`.`);
  }
}

export async function run(env: Env, command: string[], opts: ActorOpts & { name?: string; claim?: string; keep?: boolean }): Promise<void> {
  if (command.length === 0) fail(env, 'error: nothing to run — use `cws sandbox run -- <command...>`');
  requireAgentForRole(env, opts);
  // Check the claim before anything runs: a typo must not cost a sandbox and a command execution.
  if (opts.claim !== undefined) {
    requireHumanUnlessAgent(env, 'sandbox run --claim', opts);
    requireClaim(env, (await openLog(env)).state, opts.claim);
  }
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx, true);
  const paths = createPaths(env, ctx, launch);
  await syncPolicy(env, ctx);

  const created = await runOpenshell(launch, ctx, createArgs({ name: ctx.name, ...paths, approvalMode: 'manual' }), 600_000);
  if (!created.ok) {
    report(env, `sandbox ${ctx.name} create`, created);
    throw new CliExit(created.code ?? EXIT.ERROR);
  }
  let result: RunResult;
  try {
    result = await runOpenshell(launch, ctx, execArgs(ctx.name, command), 900_000);
  } finally {
    if (opts.keep !== true) await removeSandbox(env, launch, ctx);
  }
  report(env, `sandbox run: ${command.join(' ')}`, result);

  if (opts.claim !== undefined) {
    const log = await openLog(env);
    requireClaim(env, log.state, opts.claim);
    await log.append({
      type: 'EVIDENCE_ADDED',
      actor: actorOf(opts),
      payload: runEvidencePayload(opts.claim, command, result, path.relative(ctx.root, ctx.policyFile)),
    });
    say(env, `Evidence attached to claim ${opts.claim}.`);
  }

  // The sandbox is reported, not hidden: a failing command is the caller's exit code.
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}
