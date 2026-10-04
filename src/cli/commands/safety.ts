import { InvalidArgumentError, type Command } from 'commander';
import { childEnv, runInherited } from '../../integrations/exec.ts';
import { assessCommandSafety } from '../../safety/command-guard.ts';
import { CliExit, fail, projectRoot, say, warn, type Env } from '../human.ts';
import { EXIT } from '../io.ts';

interface SafeRunOptions {
  check?: boolean;
  timeout?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
/** What a guarded program may inherit besides the standard allowlist: git and ssh agent plumbing, never credentials. */
const SAFE_RUN_ENV = { names: ['SSH_AUTH_SOCK', 'EDITOR', 'VISUAL', 'PAGER', 'CI'], prefixes: ['GIT_'] };

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new InvalidArgumentError('must be a positive number of seconds');
  return seconds;
}

/**
 * The program's own exit code is shown, never returned: cws reserves 2 (needs a human) and 3 (log
 * integrity), and a child that exits 2 or 3 must not be read as one of those. Any failure exits 1.
 */
function exitOutcome(env: Env, argv: readonly string[], result: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }, timeout: number): void {
  if (result.timedOut) {
    fail(env, `safe-run: ${argv[0]} timed out after ${timeout}s and was stopped together with its child processes (--timeout <seconds> changes the limit)`);
  }
  if (result.code === EXIT.OK) return;
  const how = result.signal === null ? `exit code ${result.code ?? 'unknown'}` : `signal ${result.signal}`;
  warn(env, `safe-run: ${argv[0]} failed (${how}); cws safe-run exits ${EXIT.ERROR} for any failing command`);
  throw new CliExit(EXIT.ERROR);
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

  const timeout = opts.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const result = await runInherited(argv[0]!, argv.slice(1), {
    cwd: env.io.cwd,
    env: childEnv(process.env, SAFE_RUN_ENV),
    timeoutMs: timeout * 1000,
  }).catch((error: unknown) =>
    fail(env, `could not start command with shell: false: ${error instanceof Error ? error.message : String(error)}; use a standalone executable`));
  exitOutcome(env, argv, result, timeout);
}

export function registerSafety(program: Command, env: Env): void {
  program
    .command('safe-run')
    .description('assess and run a standalone command (advisory, not a sandbox); use --check to validate only')
    .allowUnknownOption(true)
    .option('--check', 'validate only; do not run the command')
    .option('--timeout <seconds>', `stop the command and its child processes after this long (default ${DEFAULT_TIMEOUT_SECONDS})`, parseTimeout)
    .argument('<argv...>', 'command and arguments, usually after --')
    .action((argv: string[], opts: SafeRunOptions) => safeRun(env, argv, opts));
}
