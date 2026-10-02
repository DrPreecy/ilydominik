import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from '../domain/ids.ts';
import { fold, reduce } from '../domain/reducer.ts';
import { parseEventInput, parseStoredEvent } from '../domain/schema.ts';
import { DomainError } from '../domain/types.ts';
import type { CwsEvent, EventInput, ProjectState } from '../domain/types.ts';

export const CWS_DIR = '.cws';
export const EVENTS_FILE = 'events.jsonl';
const LOCK_FILE = 'lock';
const GENESIS_HASH = '0'.repeat(64);
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 3000;
const LOCK_STALE_MS = 10_000;

export interface Integrity {
  ok: boolean;
  brokenAtSeq?: number;
}

type EventBody = Omit<CwsEvent, 'hash'>;

export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, CWS_DIR, EVENTS_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** sha256(prevHash + canonical JSON) with a fixed key order, independent of parse order. */
function computeHash(e: EventBody): string {
  const canonical = {
    v: e.v,
    seq: e.seq,
    id: e.id,
    at: e.at,
    ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }),
    type: e.type,
    actor: e.actor,
    payload: e.payload,
    prevHash: e.prevHash,
  };
  return createHash('sha256').update(e.prevHash + JSON.stringify(canonical)).digest('hex');
}

function checkIntegrity(events: readonly CwsEvent[]): Integrity {
  let prev = GENESIS_HASH;
  for (const e of events) {
    if (e.prevHash !== prev || computeHash(e) !== e.hash) return { ok: false, brokenAtSeq: e.seq };
    prev = e.hash;
  }
  return { ok: true };
}

function parseLines(raw: string): CwsEvent[] {
  const events: CwsEvent[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      events.push(parseStoredEvent(JSON.parse(line)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new DomainError('LOG_CORRUPT', `line ${i + 1}: ${reason}`);
    }
  });
  return events;
}

async function readEvents(file: string): Promise<CwsEvent[]> {
  return parseLines(await fs.readFile(file, 'utf8'));
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function removeIfStale(lockPath: string): Promise<void> {
  try {
    const { mtimeMs } = await fs.stat(lockPath);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) await fs.rm(lockPath, { force: true });
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await (await fs.open(lockPath, 'wx')).close();
      return;
    } catch (err) {
      if (!isErrno(err, 'EEXIST') && !isErrno(err, 'EPERM') && !isErrno(err, 'EBUSY')) throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
    await removeIfStale(lockPath);
    await sleep(LOCK_RETRY_MS);
  }
}

export class EventLog {
  private constructor(
    readonly rootDir: string,
    private _events: readonly CwsEvent[],
    private _state: ProjectState | null,
  ) {}

  private static filePath(rootDir: string): string {
    return path.join(rootDir, CWS_DIR, EVENTS_FILE);
  }

  static async init(rootDir: string, title: string): Promise<EventLog> {
    const file = EventLog.filePath(rootDir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, '', { flag: 'wx' });
    } catch (err) {
      if (isErrno(err, 'EEXIST')) throw new DomainError('PROJECT_EXISTS', `project already exists in ${rootDir}`);
      throw err;
    }
    const log = new EventLog(rootDir, [], null);
    try {
      await log.append({ type: 'PROJECT_CREATED', actor: { kind: 'human' }, payload: { projectId: newId('p'), title } });
    } catch (err) {
      await fs.rm(file, { force: true });
      throw err;
    }
    return log;
  }

  static async open(rootDir: string): Promise<EventLog> {
    let events: CwsEvent[];
    try {
      events = await readEvents(EventLog.filePath(rootDir));
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new DomainError('NO_PROJECT', `no project found in ${rootDir}`);
      throw err;
    }
    const state = fold(events);
    if (!state) throw new DomainError('NO_PROJECT', `event log in ${rootDir} is empty`);
    return new EventLog(rootDir, events, state);
  }

  get state(): ProjectState {
    if (!this._state) throw new DomainError('NO_PROJECT', 'project not created yet');
    return this._state;
  }

  get events(): readonly CwsEvent[] {
    return this._events;
  }

  get integrity(): Integrity {
    return checkIntegrity(this._events);
  }

  async append(input: EventInput): Promise<CwsEvent> {
    const parsed = parseEventInput(input);
    const lockPath = path.join(this.rootDir, CWS_DIR, LOCK_FILE);
    await acquireLock(lockPath);
    try {
      return await this.appendLocked(parsed);
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }

  private async appendLocked(input: EventInput): Promise<CwsEvent> {
    const file = EventLog.filePath(this.rootDir);
    const events = await readEvents(file);
    const state = fold(events);
    const body = {
      v: 1,
      seq: state ? state.lastSeq + 1 : 0,
      id: newId('ev'),
      at: new Date().toISOString(),
      ...(state?.activeSessionId === undefined ? {} : { sessionId: state.activeSessionId }),
      prevHash: events.at(-1)?.hash ?? GENESIS_HASH,
      ...input,
    } as EventBody;
    const event = { ...body, hash: computeHash(body) } as CwsEvent;
    const nextState = reduce(state, event);
    await fs.appendFile(file, `${JSON.stringify(event)}\n`);
    this._events = [...events, event];
    this._state = nextState;
    return event;
  }
}
