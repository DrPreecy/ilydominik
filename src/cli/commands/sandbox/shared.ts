import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { hostKind, resolveSandboxMode } from '../doctor.ts';
import { loadIntegrations, TOOL_ENV, toolOverride, type LoadedConfig, type SandboxMode } from '../../../integrations/config.ts';
import { findExecutable, resolveToolCommand, runTool, type RunResult, type ToolCommand } from '../../../integrations/exec.ts';
import { assertSandboxName, projectUpload } from '../../../integrations/openshell/args.ts';
import { parseRules, policyFor, type SandboxNetworkRule } from '../../../integrations/openshell/policy.ts';
import { windowsToWslPath, wslArgs } from '../../../integrations/wsl.ts';
import { CWS_DIR } from '../../../store/event-log.ts';
import { fail, projectRoot, say, warn, type Env } from '../../human.ts';

const SANDBOX_DIR = path.join(CWS_DIR, 'sandbox');
const POLICY_FILE = 'policy.yaml';
const RULES_FILE = 'rules.json';

export interface SandboxContext {
  root: string;
  name: string;
  policyFile: string;
  rulesFile: string;
}

/** How cws starts openshell: directly, or through `wsl.exe -e` in wsl mode. */
export interface Launch {
  tool: ToolCommand;
  mode: SandboxMode;
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** `.cws/sandbox` must be a real directory inside the project, never a symlink. */
export async function sandboxDir(root: string): Promise<string> {
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

export async function sandboxName(root: string, requested?: string): Promise<string> {
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
export async function readRules(file: string): Promise<SandboxNetworkRule[]> {
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

export function rulesProblem(ctx: SandboxContext, error: unknown): string {
  return `${path.relative(ctx.root, ctx.rulesFile)} cannot be used (${messageOf(error)})`;
}

/** The approved rules, or a clean stop when rules.json no longer holds safe rules. */
export async function approvedRules(env: Env, ctx: SandboxContext): Promise<SandboxNetworkRule[]> {
  try {
    return await readRules(ctx.rulesFile);
  } catch (error: unknown) {
    fail(env, `error: ${rulesProblem(ctx, error)}. Fix or delete it, then add rules again with \`cws sandbox policy --rule\`.`);
  }
}

export async function writeFileAtomic(file: string, text: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export interface SandboxSetup {
  loaded: LoadedConfig;
  mode: SandboxMode;
  /** openshell from CWS_TOOL_OPENSHELL or PATH; a repo file never chooses it */
  openshell: ToolCommand | null;
  configured: string | undefined;
}

export async function sandboxSetup(ctx: SandboxContext): Promise<SandboxSetup> {
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
export async function openshellFor(env: Env, ctx: SandboxContext, creates = false): Promise<Launch> {
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

export function runOpenshell(launch: Launch, ctx: SandboxContext, args: readonly string[], timeoutMs: number): Promise<RunResult> {
  return runTool(launch.tool.file, [...launch.tool.prefix, ...args], { cwd: ctx.root, timeoutMs });
}

/** A host path as openshell sees it: a `/mnt/...` path in wsl mode, unchanged otherwise. */
export function hostPathFor(mode: SandboxMode, value: string): string {
  if (mode !== 'wsl') return value;
  const translated = windowsToWslPath(value);
  if (translated === null) throw new Error(`cannot translate ${value} into a WSL path`);
  return translated;
}

/**
 * The project upload is always `.:/sandbox`: openshell runs with the project as its working
 * directory in every mode, and an absolute Windows path would break OpenShell's `LOCAL:DEST` split.
 */
export function uploadSpec(): string {
  return projectUpload('.');
}

export function createPaths(env: Env, ctx: SandboxContext, launch: Launch): { policyFile: string; uploads: string[] } {
  try {
    return { policyFile: hostPathFor(launch.mode, ctx.policyFile), uploads: [uploadSpec()] };
  } catch (error: unknown) {
    fail(env, `error: ${messageOf(error)}`);
  }
}

/** policy.yaml is rewritten from the approved rules every time; a file on disk is never trusted. */
export async function syncPolicy(env: Env, ctx: SandboxContext): Promise<SandboxNetworkRule[]> {
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

export function report(env: Env, label: string, result: RunResult): void {
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

export function ruleLabel(rule: SandboxNetworkRule): string {
  return `${rule.host}:${rule.port}${rule.method === undefined ? '' : ` ${rule.method} ${rule.path ?? ''}`}`;
}
