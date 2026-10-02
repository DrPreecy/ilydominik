import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import type { ProjectState, Session } from '../../domain/types.ts';
import { nextSteps } from '../../guidance/next-steps.ts';
import { assess } from '../../guidance/warnings.ts';
import { assertSessionId, CWS_DIR, type EventLog } from '../../store/event-log.ts';
import { eventLine, warningLine } from '../format.ts';
import { fail, openLog, requireHuman, say, type Env } from '../human.ts';

const HUMAN = { kind: 'human' } as const;

async function start(env: Env, goal: string[]): Promise<void> {
  requireHuman(env, 'session start');
  const log = await openLog(env);
  const sessionId = newId('s');
  await log.append({ type: 'SESSION_STARTED', actor: HUMAN, payload: { sessionId, goal: goal.join(' ') } });
  say(env, `session started [${sessionId}]: ${goal.join(' ')}`);
}

function handoffText(session: Session, changed: string[], state: ProjectState, summary?: string): string {
  const next = nextSteps(state).map((s, i) => `${i + 1}. ${s.title} — cws prompt ${i + 1}`);
  const warnings = assess(state).map(warningLine);
  return [
    `# Session ${session.id}: ${session.goal}`,
    '',
    '## What changed',
    ...changed.map((l) => `- ${l}`),
    '',
    ...(summary ? ['## Summary', summary, ''] : []),
    '## Warnings',
    ...(warnings.length > 0 ? warnings.map((w) => `- ${w}`) : ['- none']),
    '',
    '## Next',
    ...next,
    '',
  ].join('\n');
}

function assertContained(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('handoff destination must remain inside the project');
  }
}

async function handoffPath(log: EventLog, sessionId: string): Promise<string> {
  assertSessionId(sessionId);
  const root = await fs.realpath(log.rootDir);
  const cws = path.join(root, CWS_DIR);
  if ((await fs.lstat(cws)).isSymbolicLink()) throw new Error('handoff directory must not be a symbolic link');
  assertContained(root, await fs.realpath(cws));
  const sessions = path.join(cws, 'sessions');
  try {
    await fs.mkdir(sessions);
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(sessions);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('handoff directory must be a real directory');
  assertContained(root, await fs.realpath(sessions));
  const file = path.resolve(sessions, `${sessionId}.md`);
  assertContained(sessions, file);
  try {
    const target = await fs.lstat(file);
    if (target.isSymbolicLink() || !target.isFile()) throw new Error('handoff destination must be a regular file');
    assertContained(root, await fs.realpath(file));
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return file;
}

async function writeHandoff(log: EventLog, session: Session, text: string): Promise<string> {
  const file = await handoffPath(log, session.id);
  const temporary = `${file}.${newId('handoff')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return `${CWS_DIR}/sessions/${session.id}.md`;
}

async function end(env: Env, opts: { summary?: string }): Promise<void> {
  requireHuman(env, 'session end');
  const log = await openLog(env);
  const latest = log.state.sessions.at(-1);
  const sessionId = log.state.activeSessionId ?? (latest?.endedAt ? latest.id : undefined);
  if (!sessionId) fail(env, 'error: no active session — start one with `cws session start <goal>`');
  await handoffPath(log, sessionId);
  if (log.state.activeSessionId) {
    const payload = opts.summary ? { sessionId, summary: opts.summary } : { sessionId };
    await log.append({ type: 'SESSION_ENDED', actor: HUMAN, payload });
  }
  const session = log.state.sessions.find((s) => s.id === sessionId);
  if (!session) fail(env, `error: session ${sessionId} vanished`);
  const ended = log.events.find((e) => e.type === 'SESSION_ENDED' && e.payload.sessionId === sessionId);
  if (!ended) fail(env, `error: session ${sessionId} has not ended`);
  const changed = log.events.filter((e) => e.seq >= session.startSeq && e.seq <= ended.seq).map(eventLine);
  const handoff = await writeHandoff(log, session, handoffText(session, changed, log.state, session.summary));
  say(env, `Session ended: ${session.goal}`, 'What changed:', ...changed.map((l) => `  ${l}`));
  say(env, `Handoff written: ${handoff}`);
}

export function registerSession(program: Command, env: Env): void {
  const session = program.command('session').description('work sessions');
  session.command('start <goal...>').description('begin a session').action((g: string[]) => start(env, g));
  session
    .command('end')
    .description('end the session and write a handoff')
    .option('--summary <text>', 'what you learned')
    .action((o: { summary?: string }) => end(env, o));
}
