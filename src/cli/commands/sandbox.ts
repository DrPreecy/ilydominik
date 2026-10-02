import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import type { EventInput } from '../../domain/types.ts';
import { hostKind, resolveSandboxMode } from './doctor.ts';
import { loadIntegrations, TOOL_ENV, toolOverride, type LoadedConfig, type SandboxMode } from '../../integrations/config.ts';
import { findExecutable, resolveToolCommand, runTool, type RunResult, type ToolCommand } from '../../integrations/exec.ts';
import { assertSandboxName, connectArgs, createArgs, deleteArgs, logsArgs, projectUpload, ruleApproveArgs, ruleGetArgs, ruleRejectArgs } from '../../integrations/openshell/args.ts';
import { parseRules, parseRuleSpec, policyFor, ruleName, type SandboxNetworkRule } from '../../integrations/openshell/policy.ts';
import { windowsToWslPath, wslArgs } from '../../integrations/wsl.ts';
import { CWS_DIR } from '../../store/event-log.ts';
import { EXIT } from '../io.ts';
import { actorOf, CliExit, confirmDecision, fail, openLog, projectRoot, requireClaim, requireHuman, say, warn, type ActorOpts, type Env } from '../human.ts';

const SANDBOX_DIR = path.join(CWS_DIR, 'sandbox');
const POLICY_FILE = 'policy.yaml';
const RULES_FILE = 'rules.json';
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface SandboxContext {
  root: string;
  name: string;
  policyFile: string;
  rulesFile: string;
}

/** How cws starts openshell: directly, or through `wsl.exe -e` in wsl mode. */
interface Launch {
  tool: ToolCommand;
  mode: SandboxMode;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
    fail(env, `error: ${messageOf(error)}`);
  }
  const dir = await sandboxDir(root);
  return {
    root,
    name,
    policyFile: path.join(dir, POLICY_FILE),
    rulesFile: path.join(dir, RULES_FILE),
  };
}

/** rules.json, strictly: it lives in the project, so anything in it may have been edited. */
async function readRules(file: string): Promise<SandboxNetworkRule[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('not valid JSON');
  }
  return parseRules(json);
}

function rulesProblem(ctx: SandboxContext, error: unknown): string {
  return `${path.relative(ctx.root, ctx.rulesFile)} cannot be used (${messageOf(error)})`;
}

/** The approved rules, or a clean stop when rules.json no longer holds safe rules. */
async function approvedRules(env: Env, ctx: SandboxContext): Promise<SandboxNetworkRule[]> {
  try {
    return await readRules(ctx.rulesFile);
  } catch (error: unknown) {
    fail(env, `error: ${rulesProblem(ctx, error)}. Fix or delete it, then add rules again with \`cws sandbox policy --rule\`.`);
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

interface SandboxSetup {
  loaded: LoadedConfig;
  mode: SandboxMode;
  /** openshell from CWS_TOOL_OPENSHELL or PATH; a repo file never chooses it */
  openshell: ToolCommand | null;
  configured: string | undefined;
}

async function sandboxSetup(ctx: SandboxContext): Promise<SandboxSetup> {
  const loaded = await loadIntegrations(ctx.root);
  const configured = toolOverride('openshell');
  const openshell = resolveToolCommand(configured ?? 'openshell');
  const mode = resolveSandboxMode(loaded.config, hostKind(), {
    docker: findExecutable('docker') !== null,
    podman: findExecutable('podman') !== null,
    wsl: findExecutable('wsl') !== null,
    openshell: openshell !== null,
    gateway: loaded.config.sandbox.gateway !== undefined,
  });
  return { loaded, mode, openshell, configured };
}

/** openshell, ready to run. `creates` refuses when the human turned the sandbox off. */
async function openshellFor(env: Env, ctx: SandboxContext, creates = false): Promise<Launch> {
  const setup = await sandboxSetup(ctx);
  if (creates && setup.loaded.config.sandbox.mode === 'off') {
    fail(env, 'error: the sandbox mode is off in .cws/integrations.json, so no sandbox is started. Use `cws safe-run` for a guarded local command.');
  }
  if (setup.mode === 'wsl') {
    const wsl = findExecutable('wsl');
    if (wsl === null) fail(env, 'error: the sandbox mode is wsl, but `wsl` was not found. Run `wsl --install` in PowerShell.');
    const distro = setup.loaded.config.sandbox.wslDistro;
    return { mode: 'wsl', tool: { file: wsl, prefix: wslArgs(distro === undefined ? {} : { distro }, setup.configured ?? 'openshell') } };
  }
  if (setup.openshell === null) {
    const hint =
      setup.configured === undefined
        ? 'Install OpenShell and start its gateway, or use `cws safe-run` for a guarded local command.'
        : `The path in ${TOOL_ENV.openshell} does not exist: ${setup.configured}`;
    fail(env, `error: \`openshell\` was not found. ${hint}`);
  }
  return { mode: setup.mode, tool: setup.openshell };
}

function runOpenshell(launch: Launch, ctx: SandboxContext, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return runTool(launch.tool.file, [...launch.tool.prefix, ...args], { cwd: ctx.root, timeoutMs });
}

/** A host path as openshell sees it: a `/mnt/...` path in wsl mode, unchanged otherwise. */
export function hostPathFor(mode: SandboxMode, value: string): string {
  if (mode !== 'wsl') return value;
  const translated = windowsToWslPath(value);
  if (translated === null) throw new Error(`cannot translate ${value} into a WSL path`);
  return translated;
}

/** The project upload. Native Windows uploads `.` (the working directory): `E:\p:/sandbox` has two colons. */
export function uploadSpec(mode: SandboxMode, root: string, platform: NodeJS.Platform = process.platform): string {
  if (mode === 'wsl') return projectUpload(hostPathFor(mode, root));
  return projectUpload(platform === 'win32' ? '.' : root);
}

function createPaths(env: Env, ctx: SandboxContext, launch: Launch): { policyFile: string; uploads: string[] } {
  try {
    return { policyFile: hostPathFor(launch.mode, ctx.policyFile), uploads: [uploadSpec(launch.mode, ctx.root)] };
  } catch (error: unknown) {
    fail(env, `error: ${messageOf(error)}`);
  }
}

/** policy.yaml is rewritten from the approved rules every time; a file on disk is never trusted. */
async function syncPolicy(env: Env, ctx: SandboxContext): Promise<SandboxNetworkRule[]> {
  const rules = await approvedRules(env, ctx);
  const text = policyFor(rules).text;
  const existing = await fs.readFile(ctx.policyFile, 'utf8').catch(() => null);
  if (existing === text) return rules;
  await writeFileAtomic(ctx.policyFile, text);
  const file = path.relative(ctx.root, ctx.policyFile);
  say(
    env,
    existing === null
      ? `Wrote ${file}: ${rules.length} approved network rule(s), everything else denied.`
      : `Rewrote ${file} from the approved rules (${rules.length}); the file on disk did not match them.`,
  );
  return rules;
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

function ruleLabel(rule: SandboxNetworkRule): string {
  return `${rule.host}:${rule.port}${rule.method === undefined ? '' : ` ${rule.method} ${rule.path ?? ''}`}`;
}

/** The decision a human makes when a task needs network access. */
export function accessDecisionPayload(
  added: readonly SandboxNetworkRule[],
  already: number,
): Extract<EventInput, { type: 'DECISION_RECORDED' }>['payload'] {
  return {
    decisionId: newId('d'),
    title: 'Sandbox network access',
    options: added.map(ruleLabel),
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

/** Prints the policy cws will use, generated from the approved rules, and flags a drifted file. */
async function showPolicy(env: Env, ctx: SandboxContext): Promise<void> {
  const rules = await approvedRules(env, ctx);
  const onDisk = await fs.readFile(ctx.policyFile, 'utf8').catch(() => null);
  const file = path.relative(ctx.root, ctx.policyFile);
  if (onDisk === null && rules.length === 0) return say(env, `No policy yet at ${file}.`);
  const text = policyFor(rules).text;
  say(
    env,
    text.trimEnd(),
    ...(onDisk === text ? [] : ['', `note: ${file} is missing or differs from the approved rules; cws rewrites it before every up and run.`]),
  );
}

async function policy(env: Env, opts: { rule?: string[]; name?: string; show?: boolean }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  if (opts.show === true) return showPolicy(env, ctx);

  let added: SandboxNetworkRule[] = [];
  try {
    added = (opts.rule ?? []).map(parseRuleSpec);
  } catch (error: unknown) {
    fail(env, `error: ${messageOf(error)}`);
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
  const existing = await approvedRules(env, ctx);
  const merged = [...existing, ...added.filter((rule) => !existing.some((kept) => ruleName(kept) === ruleName(rule)))];
  let text: string;
  try {
    text = policyFor(merged).text;
  } catch (error: unknown) {
    fail(env, `error: ${messageOf(error)}`);
  }

  say(env, 'This lets code in the sandbox reach:', ...added.map((rule) => `  ${ruleLabel(rule)}`));
  await confirmDecision(env);
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

/** Providers hand credentials to code in the sandbox, so attaching one is a human decision. */
async function confirmProviders(env: Env, providers: readonly string[]): Promise<void> {
  const bad = providers.find((provider) => !PROVIDER_NAME.test(provider));
  if (bad !== undefined) fail(env, `error: not a provider name: ${bad}`);
  requireHuman(env, 'sandbox up --provider');
  say(env, `Attaching provider credentials to the sandbox: ${providers.join(', ')}.`, 'Code inside the sandbox can use them.');
  await confirmDecision(env);
}

async function up(env: Env, opts: { name?: string; provider?: string[] }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx, true);
  const providers = opts.provider ?? [];
  const paths = createPaths(env, ctx, launch);
  const rules = await syncPolicy(env, ctx);
  if (providers.length > 0) await confirmProviders(env, providers);
  const result = await runOpenshell(
    launch,
    ctx,
    createArgs({ name: ctx.name, ...paths, providers, approvalMode: 'manual', keep: true }),
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

async function down(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx);
  const result = await runOpenshell(launch, ctx, deleteArgs(ctx.name), 120_000);
  report(env, `sandbox ${ctx.name} down`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}

async function run(env: Env, command: string[], opts: ActorOpts & { name?: string; claim?: string; keep?: boolean }): Promise<void> {
  if (command.length === 0) fail(env, 'error: nothing to run — use `cws sandbox run -- <command...>`');
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx, true);
  const paths = createPaths(env, ctx, launch);
  await syncPolicy(env, ctx);

  const result = await runOpenshell(
    launch,
    ctx,
    createArgs({ name: ctx.name, ...paths, approvalMode: 'manual', keep: opts.keep === true, command }),
    900_000,
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

async function logs(env: Env, opts: { name?: string }): Promise<void> {
  const ctx = await sandboxContext(env, opts.name);
  const launch = await openshellFor(env, ctx);
  const result = await runOpenshell(launch, ctx, logsArgs(ctx.name, false), 120_000);
  report(env, `sandbox logs ${ctx.name}`, result);
  if (!result.ok) throw new CliExit(result.code ?? EXIT.ERROR);
}

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
