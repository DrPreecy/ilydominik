import type { Actor, ProjectState } from '../domain/types.ts';
import { EventLog, findProjectRoot } from '../store/event-log.ts';
import { EXIT, type CliIO } from './io.ts';

/** Thrown after the message has been printed; carries the process exit code. */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export interface Env {
  io: CliIO;
}

export interface ActorOpts {
  agent?: string;
  role?: string;
}

export const NO_PROJECT_MESSAGE = 'No CWS project here. Start one with: cws init <title>';

export function say(env: Env, ...lines: string[]): void {
  env.io.stdout(`${lines.join('\n')}\n`);
}

export function warn(env: Env, ...lines: string[]): void {
  env.io.stderr(`${lines.join('\n')}\n`);
}

export function fail(env: Env, message: string, code: number = EXIT.ERROR): never {
  warn(env, message);
  throw new CliExit(code);
}

export function actorOf(opts: ActorOpts): Actor {
  if (!opts.agent) return { kind: 'human' };
  return opts.role ? { kind: 'ai', agent: opts.agent, role: opts.role } : { kind: 'ai', agent: opts.agent };
}

export async function openLog(env: Env): Promise<EventLog> {
  const root = findProjectRoot(env.io.cwd);
  if (!root) fail(env, NO_PROJECT_MESSAGE);
  return EventLog.open(root);
}

export function projectRoot(env: Env): string | null {
  return findProjectRoot(env.io.cwd);
}

/** LIGHT check: a person must be at the terminal. */
export function requireHuman(env: Env, command: string): void {
  if (env.io.isInteractive) return;
  fail(
    env,
    `\`cws ${command}\` is a human action — run it yourself in a terminal. ` +
      'AI agents: record your suggestion with `cws propose --agent <your-name>` instead.',
    EXIT.NEEDS_HUMAN,
  );
}

/** LIGHT check that is skipped when an agent identifies itself (the command then records AI work). */
export function requireHumanUnlessAgent(env: Env, command: string, opts: ActorOpts): void {
  if (!opts.agent) requireHuman(env, command);
}

/** DECISION-LEVEL check: the person must type back a random code. Call right before writing. */
export async function confirmDecision(env: Env): Promise<void> {
  const code = env.io.challenge();
  const answer = await env.io.ask(`Type ${code} to confirm (you are acting as the human decision-maker): `);
  if (answer.trim().toUpperCase() === code.toUpperCase()) return;
  fail(env, 'Not confirmed.', EXIT.NEEDS_HUMAN);
}

export function requireClaim(env: Env, state: ProjectState, claimId: string): void {
  if (!state.claims.some((c) => c.id === claimId)) fail(env, `error: no claim with id ${claimId}`);
}

export function splitList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function parseCount(env: Env, value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(env, `error: ${flag} must be a positive whole number`);
  return n;
}
