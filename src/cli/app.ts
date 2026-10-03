import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { DomainError } from '../domain/types.ts';
import { registerAi } from './commands/ai.ts';
import { registerBackup } from './commands/backup.ts';
import { registerCapture } from './commands/capture.ts';
import { registerDecisions } from './commands/decisions.ts';
import { registerDoctor } from './commands/doctor.ts';
import { registerFindings } from './commands/findings.ts';
import { registerGuidance } from './commands/guidance.ts';
import { registerMenu } from './commands/menu.ts';
import { registerProject } from './commands/project.ts';
import { registerProposals } from './commands/proposals.ts';
import { registerReviewCode } from './commands/review-code.ts';
import { registerSafety } from './commands/safety.ts';
import { registerSandbox } from './commands/sandbox.ts';
import { registerSession } from './commands/session.ts';
import { sanitize } from './format.ts';
import { CliExit, type Env } from './human.ts';
import { EXIT, type CliIO } from './io.ts';

const CLEAN_COMMANDER_EXITS = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

/** `src/cli/app.ts` and `dist/cli/app.js` both sit two levels below the package root. */
function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    const version = typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
    return typeof version === 'string' ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function buildProgram(env: Env): Command {
  const program = new Command('cws')
    .description('Cognitive Work System — human-led project memory with agent-agnostic prompts')
    .version(packageVersion(), '-V, --version', 'print the cws version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => env.io.stdout(sanitize(text, true)),
      writeErr: (text) => env.io.stderr(sanitize(text, true)),
    });
  registerProject(program, env);
  registerDoctor(program, env);
  registerSession(program, env);
  registerCapture(program, env);
  registerAi(program, env);
  registerGuidance(program, env);
  registerProposals(program, env);
  registerDecisions(program, env);
  registerSafety(program, env);
  registerBackup(program, env);
  registerFindings(program, env);
  registerReviewCode(program, env);
  registerSandbox(program, env);
  // Last: the menu is the root action, and it must not hand its settings down to the commands above.
  registerMenu(program, env, (args) => buildProgram(env).parseAsync(args, { from: 'user' }));
  return program;
}

function exitCodeFor(error: unknown, io: CliIO): number {
  if (error instanceof CliExit) return error.code;
  if (error instanceof CommanderError) return CLEAN_COMMANDER_EXITS.has(error.code) ? EXIT.OK : EXIT.ERROR;
  const message = error instanceof DomainError || error instanceof Error ? error.message : String(error);
  io.stderr(`error: ${sanitize(message, true)}\n`);
  return EXIT.ERROR;
}

export async function runCli(argv: string[], io: CliIO, envOverrides?: Partial<Env>): Promise<number> {
  try {
    await buildProgram({ io, ...envOverrides }).parseAsync(argv, { from: 'user' });
    return EXIT.OK;
  } catch (error: unknown) {
    return exitCodeFor(error, io);
  }
}
