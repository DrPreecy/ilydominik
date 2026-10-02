import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import type { ProjectState, Session } from '../../domain/types.ts';
import { nextSteps } from '../../guidance/next-steps.ts';
import { assess } from '../../guidance/warnings.ts';
import { CWS_DIR, type EventLog } from '../../store/event-log.ts';
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

async function writeHandoff(log: EventLog, session: Session, text: string): Promise<string> {
  const file = path.join(log.rootDir, CWS_DIR, 'sessions', `${session.id}.md`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  return `${CWS_DIR}/sessions/${session.id}.md`;
}

async function end(env: Env, opts: { summary?: string }): Promise<void> {
  requireHuman(env, 'session end');
  const log = await openLog(env);
  const sessionId = log.state.activeSessionId;
  if (!sessionId) fail(env, 'error: no active session — start one with `cws session start <goal>`');
  const payload = opts.summary ? { sessionId, summary: opts.summary } : { sessionId };
  await log.append({ type: 'SESSION_ENDED', actor: HUMAN, payload });
  const session = log.state.sessions.find((s) => s.id === sessionId);
  if (!session) fail(env, `error: session ${sessionId} vanished`);
  const changed = log.events.filter((e) => e.seq >= session.startSeq).map(eventLine);
  say(env, `Session ended: ${session.goal}`, 'What changed:', ...changed.map((l) => `  ${l}`));
  const handoff = await writeHandoff(log, session, handoffText(session, changed, log.state, opts.summary));
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
