import type { Command } from 'commander';
import { defaultConfig, loadIntegrations, type IntegrationsConfig, type SandboxMode } from '../../integrations/config.ts';
import { findExecutable, isBatchShim, runTool, toolVersion, type RunResult } from '../../integrations/exec.ts';
import { EXIT } from '../io.ts';
import { projectRoot, say, type Env } from '../human.ts';

export type HostKind = 'codespace' | 'wsl' | 'windows' | 'linux' | 'macos' | 'unknown';

export function hostKind(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): HostKind {
  if (env.CODESPACES === 'true') return 'codespace';
  if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return 'wsl';
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  return 'unknown';
}

export interface Probe {
  name: string;
  command: string;
  purpose: string;
  required?: boolean;
  hint?: string;
  /** other names the same tool answers to on some platforms */
  fallbacks?: readonly string[];
  /** arguments that only succeed when the tool's daemon or service is reachable */
  daemonArgs?: readonly string[];
}

export const PROBES: readonly Probe[] = [
  { name: 'node', command: 'node', purpose: 'runs cws', required: true },
  { name: 'git', command: 'git', purpose: 'change detection for reviews', required: true },
  { name: 'docker', command: 'docker', purpose: 'sandbox runtime', hint: 'install Docker Engine or Docker Desktop 28+', daemonArgs: ['info'] },
  { name: 'podman', command: 'podman', purpose: 'sandbox runtime', hint: 'install Podman 5.x and start the user socket', daemonArgs: ['info'] },
  { name: 'wsl', command: 'wsl', purpose: 'Windows bridge to Linux tools', hint: 'run `wsl --install` in PowerShell' },
  { name: 'openshell', command: 'openshell', purpose: 'bounded agent sandbox', hint: 'install OpenShell and start its gateway' },
  { name: 'openshell-prover', command: 'openshell-prover', purpose: 'sandbox policy boundary check', hint: 'ships with the OpenShell packages' },
  { name: 'ocr', command: 'ocr', purpose: 'code review coverage', hint: 'npm i -g @alibaba-group/open-code-review' },
  { name: 'semgrep', command: 'semgrep', purpose: 'security scan (patterns)', hint: 'pip install semgrep' },
  { name: 'codeql', command: 'codeql', purpose: 'security scan (data flow)', hint: 'install the CodeQL CLI' },
  { name: 'uv', command: 'uv', purpose: 'runs Python-based agent skills', hint: 'pip install uv' },
  { name: 'python3', command: 'python3', purpose: 'skill scripts', hint: 'install Python 3', fallbacks: ['python'] },
  { name: 'claude', command: 'claude', purpose: 'Claude Code', hint: 'npm i -g @anthropic-ai/claude-code' },
  { name: 'codex', command: 'codex', purpose: 'Codex', hint: 'npm i -g @openai/codex' },
  { name: 'gemini', command: 'gemini', purpose: 'Gemini CLI', hint: 'npm i -g @google/gemini-cli' },
  { name: 'copilot', command: 'copilot', purpose: 'Copilot CLI', hint: 'npm i -g @github/copilot' },
];

const TOOL_OVERRIDES: Readonly<Record<string, keyof IntegrationsConfig['tools']>> = {
  ocr: 'ocr',
  openshell: 'openshell',
  'openshell-prover': 'prover',
};

export interface ProbeResult {
  probe: Probe;
  file: string | null;
  version: string | null;
  /** reachability of a daemon, when the probe asks for one */
  detail?: string;
}

export interface DoctorDeps {
  find(command: string): string | null;
  version(file: string, args?: readonly string[]): Promise<string | null>;
  run?(file: string, args: readonly string[]): Promise<RunResult>;
}

export function probesFor(config: IntegrationsConfig): Probe[] {
  return PROBES.map((probe) => {
    const key = TOOL_OVERRIDES[probe.name];
    const override = key === undefined ? undefined : config.tools[key];
    return override === undefined ? { ...probe } : { ...probe, command: override };
  });
}

export async function probeAll(deps: DoctorDeps, probes: readonly Probe[] = PROBES): Promise<ProbeResult[]> {
  const locate = (probe: Probe): string | null => {
    const direct = deps.find(probe.command);
    if (direct !== null) return direct;
    for (const fallback of probe.fallbacks ?? []) {
      const file = deps.find(fallback);
      if (file !== null) return file;
    }
    return null;
  };
  return Promise.all(
    probes.map(async (probe): Promise<ProbeResult> => {
      const file = locate(probe);
      if (file === null) return { probe, file: null, version: null };
      const version = await deps.version(file);
      if (probe.daemonArgs === undefined || deps.run === undefined) return { probe, file, version };
      const reachable = (await deps.run(file, probe.daemonArgs)).ok;
      return { probe, file, version, detail: reachable ? 'service reachable' : 'service not reachable' };
    }),
  );
}

export interface SandboxAvailability {
  docker: boolean;
  podman: boolean;
  wsl: boolean;
  openshell: boolean;
  gateway: boolean;
}

export function resolveSandboxMode(config: IntegrationsConfig, host: HostKind, available: SandboxAvailability): SandboxMode {
  if (config.sandbox.mode !== 'auto') return config.sandbox.mode;
  if (available.openshell && (available.docker || available.podman)) return 'local';
  if (host === 'windows' && available.wsl && available.openshell) return 'wsl';
  if (available.gateway) return 'remote';
  return 'off';
}

const MODE_MEANING: Record<SandboxMode, string> = {
  local: 'agent work can run in a sandbox on this machine',
  wsl: 'agent work can run in a sandbox through WSL',
  remote: 'agent work can run in a sandbox on the configured gateway',
  off: 'no sandbox: cws safe-run guards commands, but agent work is not isolated',
  auto: 'auto',
};

function toolLine(result: ProbeResult): string {
  const mark = result.file === null ? '--  ' : 'ok  ';
  const version = result.version === null ? '' : ` ${result.version}`;
  if (result.file === null) {
    const hint = result.probe.hint === undefined ? '' : ` (${result.probe.hint})`;
    return `  ${mark} ${result.probe.name.padEnd(16)} not found — ${result.probe.purpose}${hint}`;
  }
  // A batch shim has no readable version: cws never starts a shell to ask for one.
  const shim = result.version === null && isBatchShim(result.file) ? '  [batch shim]' : '';
  const detail = result.detail === undefined ? '' : `  [${result.detail}]`;
  return `  ${mark} ${result.probe.name.padEnd(16)}${version}${shim}${detail}  ${result.file}`;
}

export function reportLines(
  results: readonly ProbeResult[],
  ctx: { host: HostKind; configFile: string | null; configProblem?: string; mode: SandboxMode; project: boolean },
): string[] {
  const required = results.filter((r) => r.probe.required === true);
  const optional = results.filter((r) => r.probe.required !== true);
  const settings = ctx.configProblem === undefined ? 'defaults in use' : ctx.configProblem;
  return [
    `CWS doctor  (host: ${ctx.host})`,
    '',
    `Project memory:  ${ctx.project ? 'yes' : 'no — run `cws init "<title>"` here'}`,
    `Integrations:    ${ctx.configFile === null ? 'none' : ctx.configFile} (${settings})`,
    `Sandbox mode:    ${ctx.mode} — ${MODE_MEANING[ctx.mode]}`,
    '',
    'Required',
    ...required.map((r) => toolLine(r)),
    '',
    'Optional',
    ...optional.map((r) => toolLine(r)),
  ];
}

export async function doctor(env: Env, opts: { deep?: boolean } = {}): Promise<number> {
  const host = hostKind();
  const root = projectRoot(env);
  const loaded =
    root === null
      ? { config: defaultConfig(), file: null as string | null, problem: 'no project here; defaults in use' }
      : await loadIntegrations(root);
  const config = loaded.config;
  const results = await probeAll(
    {
      find: (command) => findExecutable(command),
      version: (file, args) => toolVersion(file, args),
      ...(opts.deep === true ? { run: (file: string, args: readonly string[]) => runTool(file, args, { timeoutMs: 8_000 }) } : {}),
    },
    probesFor(config),
  );

  const has = (name: string): boolean => results.some((r) => r.probe.name === name && r.file !== null);
  const mode = resolveSandboxMode(config, host, {
    docker: has('docker'),
    podman: has('podman'),
    wsl: has('wsl'),
    openshell: has('openshell'),
    gateway: config.sandbox.gateway !== undefined,
  });

  const lines = reportLines(results, {
    host,
    configFile: loaded.file,
    ...(loaded.problem === undefined ? {} : { configProblem: loaded.problem }),
    mode,
    project: root !== null,
  });

  const missingRequired = results.filter((r) => r.probe.required === true && r.file === null);
  if (missingRequired.length > 0) lines.push('', `Missing required tools: ${missingRequired.map((r) => r.probe.name).join(', ')}`);
  if (mode === 'off') {
    lines.push(
      '',
      has('openshell')
        ? 'Next: start the OpenShell gateway, then `cws sandbox status`.'
        : 'Next: install Docker or Podman (see `.devcontainer`), or OpenShell, to enable a sandbox.',
    );
  } else if (root !== null) {
    lines.push('', 'Next: `cws sandbox policy --rule <host:port>` to allow one destination, then `cws sandbox up`.');
  }
  say(env, ...lines);
  return EXIT.OK;
}

export function registerDoctor(program: Command, env: Env): void {
  program
    .command('doctor')
    .description('check this workspace: host, project memory, and the tools agents use')
    .option('--deep', 'also check that container services answer (slower)')
    .action(async (o: { deep?: boolean }) => {
      await doctor(env, o);
    });
}
