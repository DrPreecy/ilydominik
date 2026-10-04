import type { Command } from 'commander';
import type { ActorOpts, Env } from '../../human.ts';
import { down } from './down.ts';
import { logs } from './logs.ts';
import { policy } from './policy.ts';
import { rules } from './rules.ts';
import { run } from './run.ts';
import { status } from './status.ts';
import { up } from './up.ts';

export { accessDecisionPayload, ruleDecisionPayload, runEvidencePayload } from './payloads.ts';
export { hostPathFor, reportLines, sandboxContext, uploadSpec, type SandboxContext } from './shared.ts';

export function registerSandbox(program: Command, env: Env): void {
  const sandbox = program.command('sandbox').description('run agent work inside an OpenShell sandbox (optional)');
  const nameOption = (command: Command): Command => command.option('--name <name>', 'sandbox name (default: cws-<folder>)');

  nameOption(sandbox.command('status')).description('where the sandbox stands: mode, policy, openshell').action((o: { name?: string }) => status(env, o));
  nameOption(sandbox.command('policy'))
    .description('show or extend the network rules the sandbox is allowed to use (human, asks for confirmation)')
    .option('--rule <spec...>', 'host:port, or binary@host:port/METHOD:/path')
    .option('--show', 'print the policy cws will use')
    .action((o: { rule?: string[]; name?: string; show?: boolean }) => policy(env, o));
  nameOption(sandbox.command('up'))
    .description('create the sandbox with the current policy and upload the project')
    .option('--provider <name...>', 'attach an OpenShell provider, e.g. github (human, asks for confirmation)')
    .action((o: { name?: string; provider?: string[] }) => up(env, o));
  nameOption(sandbox.command('down')).description('delete the sandbox').action((o: { name?: string }) => down(env, o));
  nameOption(sandbox.command('run [command...]'))
    .description('run one bounded command in a fresh sandbox: cws sandbox run -- <command>')
    .option('--agent <name>', 'record the run as this agent')
    .option('--role <role>', 'optional agent role')
    .option('--claim <id>', 'attach the run result as evidence on this claim')
    .option('--keep', 'leave the sandbox running afterwards')
    .action((command: string[], o: ActorOpts & { name?: string; claim?: string; keep?: boolean }) => run(env, command, o));
  nameOption(sandbox.command('rules'))
    .description('list pending network rules, or approve/reject one')
    .option('--status <status>', 'which rules to list (default pending)')
    .option('--approve <chunk-id>', 'approve one rule (human, asks for confirmation)')
    .option('--reject <chunk-id>', 'reject one rule (human, asks for confirmation)')
    .option('--reason <text>', 'why the rule was rejected; OpenShell passes it to the agent')
    .action((o: { name?: string; status?: string; approve?: string; reject?: string; reason?: string }) => rules(env, o));
  nameOption(sandbox.command('logs')).description('show the sandbox logs').action((o: { name?: string }) => logs(env, o));
  sandbox.action((o: { name?: string }) => status(env, o));
}
