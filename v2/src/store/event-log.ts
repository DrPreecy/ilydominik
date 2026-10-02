import { createHash, randomBytes } from 'node:crypto';
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
const LOCK_TIMEOUT_MS = 8000;
const LOCK_STALE_MS = 5000;

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

async function isStale(lockPath: string): Promise<boolean> {
  try {
    const { mtimeMs } = await fs.stat(lockPath);
    return Date.now() - mtimeMs > LOCK_STALE_MS;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

/** Atomically replace a stale lock with a fresh one carrying our nonce. */
async function takeOver(lockPath: string, nonce: string): Promise<boolean> {
  const tmp = `${lockPath}.${nonce}`;
  await fs.writeFile(tmp, nonce);
  try {
    await fs.rename(tmp, lockPath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    if (isErrno(err, 'EPERM') || isErrno(err, 'EBUSY') || isErrno(err, 'EACCES')) return false;
    throw err;
  }
  return (await fs.readFile(lockPath, 'utf8').catch(() => '')) === nonce;
}

/** Acquire the lock; returns the nonce that proves ownership. */
async function acquireLock(lockPath: string): Promise<string> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const nonce = randomBytes(12).toString('hex');
  for (;;) {
    try {
      await fs.writeFile(lockPath, nonce, { flag: 'wx' });
      return nonce;
    } catch (err) {
      if (!isErrno(err, 'EEXIST') && !isErrno(err, 'EPERM') && !isErrno(err, 'EBUSY')) throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lockPath}`);
    if ((await isStale(lockPath)) && (await takeOver(lockPath, nonce))) return nonce;
    await sleep(LOCK_RETRY_MS);
  }
}

/** Remove the lock only if it is still ours. */
async function releaseLock(lockPath: string, nonce: string): Promise<void> {
  const current = await fs.readFile(lockPath, 'utf8').catch(() => null);
  if (current === nonce) await fs.rm(lockPath, { force: true });
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
    return (await this.appendBatch([input]))[0] as CwsEvent;
  }

  /** All-or-nothing: every input is folded against the state in memory first, then written in one append. */
  async appendBatch(inputs: readonly EventInput[]): Promise<CwsEvent[]> {
    const parsed = inputs.map((i) => parseEventInput(i));
    const lockPath = path.join(this.rootDir, CWS_DIR, LOCK_FILE);
    const nonce = await acquireLock(lockPath);
    try {
      return await this.appendLocked(parsed);
    } finally {
      await releaseLock(lockPath, nonce);
    }
  }

  private async appendLocked(inputs: readonly EventInput[]): Promise<CwsEvent[]> {
    const file = EventLog.filePath(this.rootDir);
    const raw = await fs.readFile(file, 'utf8');
    const events = parseLines(raw);
    let state = fold(events);
    let prevHash = events.at(-1)?.hash ?? GENESIS_HASH;
    const added: CwsEvent[] = [];
    for (const input of inputs) {
      const body = {
        v: 1,
        seq: state ? state.lastSeq + 1 : 0,
        id: newId('ev'),
        at: new Date().toISOString(),
        ...(state?.activeSessionId === undefined ? {} : { sessionId: state.activeSessionId }),
        prevHash,
        ...input,
      } as EventBody;
      const event = { ...body, hash: computeHash(body) } as CwsEvent;
      state = reduce(state, event);
      prevHash = event.hash;
      added.push(event);
    }
    const lead = raw.length > 0 && !raw.endsWith('\n') ? '\n' : '';
    await fs.appendFile(file, lead + added.map((e) => JSON.stringify(e) + '\n').join(''));
    this._events = [...events, ...added];
    this._state = state;
    return added;
  }
}
