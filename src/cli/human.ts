import { DomainError, type Actor, type ProjectState } from '../domain/types.ts';
import { EventLog, findProjectRoot } from '../store/event-log.ts';
import { sanitize } from './format.ts';
import { EXIT, type CliIO } from './io.ts';

/** Thrown after the message has been printed; carries the process exit code. */
export class CliExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

export interface Env {
  io: CliIO;
  geminiCaller?: import('../integrations/gemini.ts').GeminiCaller;
  credentialsPath?: string;
  firestoreSyncClient?: import('../cloud/sync.ts').FirestoreSyncClient;
}

export interface ActorOpts {
  agent?: string;
  role?: string;
}

export const NO_PROJECT_MESSAGE = 'No CWS project here. Start one with: cws init <title>';

export function say(env: Env, ...lines: string[]): void {
  env.io.stdout(`${sanitize(lines.join('\n'), true)}\n`);
}

/** Schema version of every `--json` document; bump it when a field is removed or changes meaning. */
export const JSON_SCHEMA_VERSION = 1;

const BACKSLASH = '\u005c';

/** One JSON document on stdout and nothing else; C1/DEL control characters are escaped for terminals. */
export function sayJson(env: Env, value: Record<string, unknown>): void {
  const text = JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, ...value }, null, 2);
  env.io.stdout(`${text.replace(/[\u007f-\u009f]/g, (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`);
}

export function warn(env: Env, ...lines: string[]): void {
  env.io.stderr(`${sanitize(lines.join('\n'), true)}\n`);
}

export function fail(env: Env, message: string, code: number = EXIT.ERROR): never {
  warn(env, message);
  throw new CliExit(code);
}

/** A role describes an AI agent; without --agent it would silently vanish into a human record. */
export function requireAgentForRole(env: Env, opts: ActorOpts): void {
  if (opts.role !== undefined && !opts.agent) fail(env, 'error: --role only applies together with --agent <name>');
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

/** One plain line for a person: no error codes, no stack, no library jargon. */
export function describeError(error: unknown): string {
  if (error instanceof DomainError) return error.message.replace(/^\[[A-Z_]+\]\s*/, '');
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: unknown; path?: unknown; issues?: unknown; message?: unknown };
    if (Array.isArray(e.issues)) {
      const issues = (e.issues as { path?: unknown; message?: unknown }[]).map((issue) => {
        const where = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${where}${String(issue.message)}`;
      });
      return `invalid input (${issues.join('; ')})`;
    }
    const target = typeof e.path === 'string' ? ` (${e.path})` : '';
    switch (e.code) {
      case 'ENOENT': return `file or folder not found${target}`;
      case 'EACCES':
      case 'EPERM': return `no permission to use it${target}`;
      case 'EISDIR': return `expected a file but found a folder${target}`;
      case 'ENOTDIR': return `expected a folder but found a file${target}`;
      default: break;
    }
  }
  return error instanceof Error ? error.message : String(error);
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
