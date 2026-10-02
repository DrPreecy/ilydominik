import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import type { EventInput } from '../../domain/types.ts';
import { hostKind, resolveSandboxMode } from './doctor.ts';
import { loadIntegrations } from '../../integrations/config.ts';
import { findExecutable, runTool, type RunResult } from '../../integrations/exec.ts';
import { assertSandboxName, connectArgs, createArgs, deleteArgs, logsArgs, projectUpload, ruleApproveArgs, ruleGetArgs, ruleRejectArgs } from '../../integrations/openshell/args.ts';
import { parseRuleSpec, policyFor, type SandboxNetworkRule } from '../../integrations/openshell/policy.ts';
import { CWS_DIR } from '../../store/event-log.ts';
import { EXIT } from '../io.ts';
import { actorOf, CliExit, confirmDecision, fail, openLog, projectRoot, requireClaim, requireHuman, say, warn, type ActorOpts, type Env } from '../human.ts';

const SANDBOX_DIR = path.join(CWS_DIR, 'sandbox');
const POLICY_FILE = 'policy.yaml';
const RULES_FILE = 'rules.json';

export interface SandboxContext {
  root: string;
  name: string;
  policyFile: string;
  rulesFile: string;
}

/** `.cws/sandbox` must be a real directory inside the project, never a symlink. */
async function sandboxDir(root: string): Promise<string> {
  const dir = path.join(root, SANDBOX_DIR);
  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} must be a real directory`);
  const relative = path.relative(await fs.realpath(root), await fs.realpath(dir));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${dir} must stay inside the project`);
  }
  return dir;
}

async function sandboxName(root: string, requested?: string): Promise<string> {
  if (requested !== undefined) return requested;
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base === '' ? 'cws-sandbox' : `cws-${base}`).slice(0, 19).replace(/-+$/, '');
}

export async function sandboxContext(env: Env, requested?: string): Promise<SandboxContext> {
  const root = projectRoot(env);
  if (root === null) fail(env, 'error: no CWS project here — run `cws init "<title>"` first');
  const name = await sandboxName(root, requested);
  try {
    assertSandboxName(name);
  } catch (error: unknown) {
    fail(env, `error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dir = await sandboxDir(root);
  return {
    root,
    name,
    policyFile: path.join(dir, POLICY_FILE),
    rulesFile: path.join(dir, RULES_FILE),
  };
}

async function readRules(file: string): Promise<SandboxNetworkRule[]> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as SandboxNetworkRule[];
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** OpenShell's own binary, from the config first and then from PATH. */
async function resolveOpenshell(env: Env, ctx: SandboxContext): Promise<string> {
  const configured = (await loadIntegrations(ctx.root)).config.tools.openshell;
  const found = findExecutable(configured ?? 'openshell');
  if (found === null) {
    const hint =
      configured === undefined
        ? 'Install OpenShell and start its gateway, or use `cws safe-run` for a guarded local command.'
        : `The path in .cws/integrations.json does not exist: ${configured}`;
    fail(env, `error: \`openshell\` was not found. ${hint}`);
  }
  return found;
}

/** The policy file is derived from the approved rules: write it when it is missing, never clobber one. */
async function ensurePolicy(env: Env, ctx: SandboxContext): Promise<void> {
  const existing = await fs.readFile(ctx.policyFile, 'utf8').catch(() => null);
  if (existing !== null) return;
  const rules = await readRules(ctx.rulesFile);
  await writeFileAtomic(ctx.policyFile, policyFor(rules).text);
  say(
    env,
    `Wrote ${path.relative(ctx.root, ctx.policyFile)}: ${rules.length} approved network rule(s), everything else denied.`,
  );
}

function report(env: Env, label: string, result: RunResult): void {
  const { out, err } = reportLines(label, result);
  if (out.length > 0) say(env, ...out);
  if (err.length > 0) warn(env, ...err);
}

/** What a finished tool run looks like. Kept pure so it can be checked without a gateway. */
export function reportLines(label: string, result: RunResult): { out: string[]; err: string[] } {
  const seconds = (result.durationMs / 1000).toFixed(1);
  if (result.ok) {
    const body = result.stdout.trim();
    return { out: [`${label} ok (${seconds}s)`, ...(body === '' ? [] : [body])], err: [] };
  }
  const reason = result.timedOut ? 'timed out' : `exit ${result.code ?? 'unknown'}`;
  const detail = result.stderr.trim();
  return { out: [], err: [`${label} failed (${reason}, ${seconds}s)`, ...(detail === '' ? [] : [detail])] };
}

/** The decision a human makes when a task needs network access. */
export function accessDecisionPayload(
  added: readonly SandboxNetworkRule[],
  already: number,
): Extract<EventInput, { type: 'DECISION_RECORDED' }>['payload'] {
  return {
    decisionId: newId('d'),
    title: 'Sandbox network access',
    options: added.map((rule) => `${rule.host}:${rule.port}${rule.method === undefined ? '' : ` ${rule.method} ${rule.path ?? ''}`}`),
    selected: added.map((rule) => rule.host).join(', '),
    rationale:
      `Approved ${added.length} sandbox network rule(s), ${already} from before. ` +
      'Every destination outside these rules stays denied.',
    kind: 'NORMAL',
  };
}

/** The decision a human makes on a rule OpenShell held back. */
export function ruleDecisionPayload(
  chunkId: string,
  approving: boolean,
  reason?: string,
): Extract<EventInput, { type: 'DECISION_RECORDED' }>['payload'] {
  return {
    decisionId: newId('d'),
    title: `Sandbox network rule ${approving ? 'approved' : 'rejected'}`,
    options: [chunkId],
    selected: approving ? `approve ${chunkId}` : `reject ${chunkId}`,
    rationale: approving
      ? 'The human approved this sandbox network rule in OpenShell. Only this rule was added.'
      : `The human rejected this rule${reason === undefined || reason.trim() === '' ? '' : `: ${reason}`}`,
    kind: 'NORMAL',
  };
}

/** A sandbox run is evidence: it has a command, an exit code and a policy behind it. */
export function runEvidencePayload(
  claimId: string,
  command: readonly string[],
  result: RunResult,
  policyPath: string,
): Extract<EventInput, { type: 'EVIDENCE_ADDED' }>['payload'] {
  const outcome = result.timedOut
    ? `timed out after ${(result.durationMs / 1000).toFixed(1)}s`
    : `exited ${result.code ?? 'unknown'} after ${(result.durationMs / 1000).toFixed(1)}s`;
  return {
    evidenceId: newId('e'),
    claimId,
    text: `Sandbox run: \`${command.join(' ')}\` ${outcome}. It reused the policy at ${policyPath}.`,
    source: 'openshell sandbox create',
  };
}

async function status(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const loaded = await loadIntegrations(ctx.root);
  const openshell = findExecutable(loaded.config.tools.openshell ?? 'openshell');
  const rules = await readRules(ctx.rulesFile);
  const available = {
    docker: findExecutable('docker') !== null,
    podman: findExecutable('podman') !== null,
    wsl: findExecutable('wsl') !== null,
    openshell: openshell !== null,
    gateway: loaded.config.sandbox.gateway !== undefined,
  };
  const mode = resolveSandboxMode(loaded.config, hostKind(), available);
  say(
    env,
    `Sandbox: ${ctx.name}`,
    `Mode: ${mode}${loaded.config.sandbox.mode === 'auto' ? ' (auto)' : ''}`,
    `Policy: ${path.relative(ctx.root, ctx.policyFile)} — ${rules.length} approved network rule${rules.length === 1 ? '' : 's'}`,
    `openshell: ${openshell ?? 'not found'}`,
    ...(loaded.problem === undefined ? [] : [`Settings problem: ${loaded.problem}`]),
    '',
    openshell === null
      ? 'Without OpenShell, `cws safe-run` is the guard and agent work is not isolated.'
      : 'Next: `cws sandbox policy --rule <host:port>` to allow access, then `cws sandbox up`.',
  );
}

async function policy(env: Env, opts: { rule?: string[]; name?: string; show?: boolean }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const existing = await readRules(ctx.rulesFile);

  if (opts.show === true) {
    const text = await fs.readFile(ctx.policyFile, 'utf8').catch(() => null);
    if (text === null) return say(env, `No policy yet at ${path.relative(ctx.root, ctx.policyFile)}.`);
    return say(env, text.trimEnd());
  }

  let added: SandboxNetworkRule[] = [];
  try {
    added = (opts.rule ?? []).map(parseRuleSpec);
  } catch (error: unknown) {
    fail(env, `error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (added.length === 0) {
    return say(
      env,
      'Nothing to do. Add the access a task needs, for example:',
      '  cws sandbox policy --rule api.github.com:443',
      '  cws sandbox policy --rule /usr/bin/gh@api.github.com:443/PUT:/repos/me/repo/contents/docs/**',
      'Every rule is a decision: the sandbox gets nothing beyond these.',
    );
  }

  requireHuman(env, 'sandbox policy');
  const merged = [...existing, ...added.filter((rule) => !existing.some((kept) => JSON.stringify(kept) === JSON.stringify(rule)))];
  let text: string;
  try {
    text = policyFor(merged).text;
  } catch (error: unknown) {
    fail(env, `error: ${error instanceof Error ? error.message : String(error)}`);
  }

  const log = await openLog(env);
  await log.append({ type: 'DECISION_RECORDED', actor: actorOf({}), payload: accessDecisionPayload(added, existing.length) });
  await writeFileAtomic(ctx.rulesFile, `${JSON.stringify(merged, null, 2)}\n`);
  await writeFileAtomic(ctx.policyFile, text);
  say(
    env,
    `Policy written: ${path.relative(ctx.root, ctx.policyFile)}`,
    `${merged.length} network rule(s). All other outbound traffic stays denied.`,
    'The decision is recorded in the log.',
  );
}

async function up(env: Env, opts: { name?: string; provider?: string[] }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const openshell = await resolveOpenshell(env, ctx);
  await ensurePolicy(env, ctx);
  const rules = await readRules(ctx.rulesFile);
  const result = await runTool(
    openshell,
    createArgs({
      name: ctx.name,
      policyFile: ctx.policyFile,
      ...(opts.provider === undefined ? {} : { providers: opts.provider }),
      uploads: [projectUpload(ctx.root)],
      approvalMode: 'manual',
      keep: true,
    }),
    { cwd: ctx.root, timeoutMs: 600_000 },
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

async function down(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const openshell = await resolveOpenshell(env, ctx);
  const result = await runTool(openshell, deleteArgs(ctx.name), { cwd: ctx.root, timeoutMs: 120_000 });
  report(env, `sandbox ${ctx.name} down`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}

async function run(env: Env, command: string[], opts: ActorOpts & { name?: string; claim?: string; keep?: boolean }): Promise<void> {
  if (command.length === 0) fail(env, 'error: nothing to run — use `cws sandbox run -- <command...>`');
  const ctx = await sandboxContext(env, opts.name);
  const openshell = await resolveOpenshell(env, ctx);
  await ensurePolicy(env, ctx);

  const result = await runTool(
    openshell,
    createArgs({
      name: ctx.name,
      policyFile: ctx.policyFile,
      uploads: [projectUpload(ctx.root)],
      approvalMode: 'manual',
      keep: opts.keep === true,
      command,
    }),
    { cwd: ctx.root, timeoutMs: 900_000 },
  );
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

async function rules(env: Env, opts: { name?: string; status?: string; approve?: string; reject?: string; reason?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const openshell = await resolveOpenshell(env, ctx);

  if (opts.approve !== undefined || opts.reject !== undefined) {
    requireHuman(env, opts.approve === undefined ? 'sandbox reject' : 'sandbox approve');
    const chunkId = opts.approve ?? opts.reject ?? '';
    const approving = opts.approve !== undefined;
    say(env, approving ? `Approving network rule ${chunkId}.` : `Rejecting network rule ${chunkId}.`);
    await confirmDecision(env);
    const args = approving ? ruleApproveArgs(ctx.name, chunkId) : ruleRejectArgs(ctx.name, chunkId, opts.reason);
    const result = await runTool(openshell, args, { cwd: ctx.root, timeoutMs: 120_000 });
    report(env, approving ? 'rule approve' : 'rule reject', result);
    if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
    const log = await openLog(env);
    await log.append({ type: 'DECISION_RECORDED', actor: actorOf({}), payload: ruleDecisionPayload(chunkId, approving, opts.reason) });
    return;
  }

  const result = await runTool(openshell, ruleGetArgs(ctx.name, opts.status ?? 'pending'), { cwd: ctx.root, timeoutMs: 120_000 });
  report(env, 'rule get', result);
  const output = result.ok ? result.stdout.trim() : '';
  say(
    env,
    ...(result.ok ? [output === '' ? `No ${opts.status ?? 'pending'} network rules for ${ctx.name}.` : output, ''] : []),
    'Approve one:  cws sandbox approve <chunk-id>',
    'Reject one:   cws sandbox reject <chunk-id> --reason "scope this to ..."',
    'OpenShell keeps its own gate; cws records your decision in the log.',
  );
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}

async function logs(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const openshell = await resolveOpenshell(env, ctx);
  const result = await runTool(openshell, logsArgs(ctx.name, false), { cwd: ctx.root, timeoutMs: 120_000 });
  report(env, `sandbox logs ${ctx.name}`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}

export function registerSandbox(program: Command, env: Env): void {
  const sandbox = program.command('sandbox').description('run agent work inside an OpenShell sandbox (optional)');
  const nameOption = (command: Command): Command => command.option('--name <name>', 'sandbox name (default: cws-<folder>)');

  nameOption(sandbox.command('status')).description('where the sandbox stands: mode, policy, openshell').action((o: { name?: string }) => status(env, o));
  nameOption(sandbox.command('policy'))
    .description('show or extend the network rules the sandbox is allowed to use (human)')
    .option('--rule <spec...>', 'host:port, or binary@host:port/METHOD:/path')
    .option('--show', 'print the current policy file')
    .action((o: { rule?: string[]; name?: string; show?: boolean }) => policy(env, o));
  nameOption(sandbox.command('up'))
    .description('create the sandbox with the current policy and upload the project')
    .option('--provider <name...>', 'attach an OpenShell provider, e.g. github')
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
