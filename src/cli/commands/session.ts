import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import type { ProjectState, Session } from '../../domain/types.ts';
import { nextSteps } from '../../guidance/next-steps.ts';
import { assess } from '../../guidance/warnings.ts';
import { autoBackupEnabled, writeAutoBackup } from '../../store/backup.ts';
import { assertSessionId, CWS_DIR, type EventLog } from '../../store/event-log.ts';
import { eventLine, warningLine } from '../format.ts';
import { fail, openLog, requireHuman, say, warn, type Env } from '../human.ts';

const HUMAN = { kind: 'human' } as const;

export interface SessionBrief {
  done?: string;
  not?: string;
}

export async function startSession(env: Env, goal: string, brief: SessionBrief = {}): Promise<void> {
  requireHuman(env, 'session start');
  const log = await openLog(env);
  const sessionId = newId('s');
  const payload = {
    sessionId,
    goal,
    ...(brief.done ? { doneWhen: brief.done } : {}),
    ...(brief.not ? { notTouching: brief.not } : {}),
  };
  await log.append({ type: 'SESSION_STARTED', actor: HUMAN, payload });
  say(env, `session started [${sessionId}]: ${goal}`, ...briefLines(brief.done, brief.not).map((l) => `  ${l}`));
}

function briefLines(doneWhen?: string, notTouching?: string): string[] {
  return [...(doneWhen ? [`done when: ${doneWhen}`] : []), ...(notTouching ? [`not touching: ${notTouching}`] : [])];
}

function briefSection(session: Session): string[] {
  if (!session.doneWhen && !session.notTouching) return [];
  return [
    '## Brief',
    ...(session.doneWhen ? [`- Done when: ${session.doneWhen}`] : []),
    ...(session.notTouching ? [`- Not touching: ${session.notTouching}`] : []),
    ...(session.doneWhen ? ['- Done-when reached? Check it before the next session: yes / not yet.'] : []),
    '',
  ];
}

function handoffText(session: Session, changed: string[], state: ProjectState, summary?: string): string {
  const next = nextSteps(state).map((s, i) => `${i + 1}. ${s.title} — cws prompt ${i + 1}`);
  const warnings = assess(state).map(warningLine);
  return [
    `# Session ${session.id}: ${session.goal}`,
    '',
    ...briefSection(session),
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

/** Workspaces like Codespaces can vanish, so a finished session also leaves a backup there. */
async function autoBackup(env: Env, rootDir: string): Promise<void> {
  if (!autoBackupEnabled()) return;
  try {
    const file = await writeAutoBackup(rootDir);
    say(env, `Backup saved: ${path.relative(rootDir, file)} (download it to keep it outside this workspace)`);
  } catch (error: unknown) {
    warn(env, `warning: automatic backup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function end(env: Env, opts: { summary?: string }): Promise<void> {
  requireHuman(env, 'session end');
  const log = await openLog(env);
  const latest = log.state.sessions.at(-1);
  const sessionId = log.state.activeSessionId ?? (latest?.endedAt ? latest.id : undefined);
  if (!sessionId) fail(env, 'error: no active session — start one with `cws session start <goal>`');
  await handoffPath(log, sessionId);
  if (!log.state.activeSessionId && opts.summary !== undefined) {
    fail(env, `error: session ${sessionId} has already ended, so the summary was not recorded. Start a new session to record new work.`);
  }
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
  await autoBackup(env, log.rootDir);
}

export function registerSession(program: Command, env: Env): void {
  const session = program.command('session').description('work sessions');
  session
    .command('start <goal...>')
    .description('begin a session')
    .option('--done <text>', 'how you will know the session is done')
    .option('--not <text>', 'what stays out of scope this session')
    .action((g: string[], o: SessionBrief) => startSession(env, g.join(' '), o));
  session
    .command('end')
    .description('end the session and write a handoff')
    .option('--summary <text>', 'what you learned')
    .action((o: { summary?: string }) => end(env, o));
}
