import { Command, CommanderError } from 'commander';
import { DomainError } from '../domain/types.ts';
import { registerCapture } from './commands/capture.ts';
import { registerDecisions } from './commands/decisions.ts';
import { registerGuidance } from './commands/guidance.ts';
import { registerProject } from './commands/project.ts';
import { registerProposals } from './commands/proposals.ts';
import { registerSession } from './commands/session.ts';
import { CliExit, type Env } from './human.ts';
import { EXIT, type CliIO } from './io.ts';

const CLEAN_COMMANDER_EXITS = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version']);

export function buildProgram(env: Env): Command {
  const program = new Command('cws')
    .description('Cognitive Work System — human-led project memory with agent-agnostic prompts')
    .exitOverride()
    .configureOutput({ writeOut: env.io.stdout, writeErr: env.io.stderr });
  registerProject(program, env);
  registerSession(program, env);
  registerCapture(program, env);
  registerGuidance(program, env);
  registerProposals(program, env);
  registerDecisions(program, env);
  return program;
}

function exitCodeFor(error: unknown, io: CliIO): number {
  if (error instanceof CliExit) return error.code;
  if (error instanceof CommanderError) return CLEAN_COMMANDER_EXITS.has(error.code) ? EXIT.OK : EXIT.ERROR;
  const message = error instanceof DomainError || error instanceof Error ? error.message : String(error);
  io.stderr(`error: ${message}\n`);
  return EXIT.ERROR;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  try {
    await buildProgram({ io }).parseAsync(argv, { from: 'user' });
    return EXIT.OK;
  } catch (error: unknown) {
    return exitCodeFor(error, io);
  }
}
