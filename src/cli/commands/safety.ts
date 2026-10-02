import { spawn } from 'node:child_process';
import type { Command } from 'commander';
import { assessCommandSafety } from '../../safety/command-guard.ts';
import { CliExit, fail, projectRoot, say, type Env } from '../human.ts';
import { EXIT } from '../io.ts';

interface SafeRunOptions {
  check?: boolean;
}

function runProcess(argv: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? EXIT.ERROR));
  });
}

async function safeRun(env: Env, argv: string[], opts: SafeRunOptions): Promise<void> {
  const root = projectRoot(env) ?? env.io.cwd;
  const decision = assessCommandSafety(argv, { cwd: env.io.cwd, projectRoot: root, runsWithoutShell: opts.check !== true });
  if (!decision.ok) fail(env, `blocked: ${decision.reason}`);

  const lines = [
    decision.destructive ? 'safe-run: allowed destructive command' : 'safe-run: allowed command',
    `project root: ${root}`,
    ...decision.targets.map((target) => `target: ${target}`),
    ...decision.notes.map((note) => `note: ${note}`),
    'note: advisory checks only, not a sandbox; filesystem paths can change before execution',
  ];
  say(env, ...lines);
  if (opts.check) return;

  const code = await runProcess(argv, env.io.cwd).catch((error: unknown) =>
    fail(env, `could not start command with shell: false: ${error instanceof Error ? error.message : String(error)}; use a standalone executable`));
  if (code !== EXIT.OK) throw new CliExit(code);
}

export function registerSafety(program: Command, env: Env): void {
  program
    .command('safe-run')
    .description('assess and run a standalone command (advisory, not a sandbox); use --check to validate only')
    .allowUnknownOption(true)
    .option('--check', 'validate only; do not run the command')
    .argument('<argv...>', 'command and arguments, usually after --')
    .action((argv: string[], opts: SafeRunOptions) => safeRun(env, argv, opts));
}
