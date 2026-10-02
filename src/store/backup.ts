import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { CwsEvent, ProjectState } from '../domain/types.ts';
import { assertSessionId, CWS_DIR, EVENTS_FILE, verifyLogText } from './event-log.ts';

export const BACKUP_FORMAT = 'cws-backup';
export const AUTO_BACKUP_KEEP = 5;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_HANDOFF_BYTES = 1024 * 1024;
const SESSIONS_DIR = 'sessions';
const BACKUPS_DIR = 'backups';
const BACKUP_NAME = /^cws-backup-[0-9TZ.]+-[0-9a-f]{6}\.json\.gz$/;

const bundleSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(1),
  createdAt: z.string(),
  projectId: z.string(),
  eventCount: z.number().int().min(1),
  headHash: z.string(),
  events: z.string(),
  handoffs: z.record(z.string(), z.string().max(MAX_HANDOFF_BYTES)),
});

export type BackupBundle = z.infer<typeof bundleSchema>;

export interface DecodedBackup {
  bundle: BackupBundle;
  events: CwsEvent[];
  state: ProjectState;
}

export function backupFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '');
  return `cws-backup-${stamp}-${randomBytes(3).toString('hex')}.json.gz`;
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/** The sessions directory, or null when it is missing or not a real directory. */
async function sessionsDir(rootDir: string): Promise<string | null> {
  const dir = path.join(rootDir, CWS_DIR, SESSIONS_DIR);
  try {
    const stat = await fs.lstat(dir);
    return stat.isDirectory() && !stat.isSymbolicLink() ? dir : null;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

async function readHandoff(dir: string, sessionId: string): Promise<string | null> {
  assertSessionId(sessionId);
  const file = path.join(dir, `${sessionId}.md`);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > MAX_HANDOFF_BYTES) return null;
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null;
    throw err;
  }
}

/** Snapshot the event log and session handoffs of the project at `rootDir`. */
export async function collectBackup(rootDir: string, now: Date = new Date()): Promise<BackupBundle> {
  const events = await fs.readFile(path.join(rootDir, CWS_DIR, EVENTS_FILE), 'utf8');
  const verified = verifyLogText(events);
  const dir = await sessionsDir(rootDir);
  const handoffs: Record<string, string> = {};
  for (const session of dir ? verified.state.sessions : []) {
    const text = await readHandoff(dir!, session.id);
    if (text !== null) handoffs[session.id] = text;
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now.toISOString(),
    projectId: verified.state.id,
    eventCount: verified.events.length,
    headHash: verified.events.at(-1)!.hash,
    events,
    handoffs,
  };
}

export function encodeBackup(bundle: BackupBundle): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'));
}

function parseBundle(data: Buffer): BackupBundle {
  if (data.length > MAX_COMPRESSED_BYTES) throw new Error('backup file is too large');
  let json: unknown;
  try {
    json = JSON.parse(gunzipSync(data, { maxOutputLength: MAX_EXPANDED_BYTES }).toString('utf8'));
  } catch {
    throw new Error('not a readable cws backup (expected gzip-compressed JSON within the size limit)');
  }
  const parsed = bundleSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`not a valid cws backup: ${issues}`);
  }
  return parsed.data;
}

/** Decode and fully verify a backup: schema, hash chain, authority rules, manifest and handoff names. */
export function decodeBackup(data: Buffer): DecodedBackup {
  const bundle = parseBundle(data);
  const { events, state } = verifyLogText(bundle.events);
  if (events.length !== bundle.eventCount || events.at(-1)!.hash !== bundle.headHash || state.id !== bundle.projectId) {
    throw new Error('backup manifest does not match its event log');
  }
  const known = new Set(state.sessions.map((s) => s.id));
  for (const sessionId of Object.keys(bundle.handoffs)) {
    assertSessionId(sessionId);
    if (!known.has(sessionId)) throw new Error(`backup contains a handoff for unknown session ${sessionId}`);
  }
  return { bundle, events, state };
}

export async function readBackupFile(file: string): Promise<DecodedBackup> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  if (stat.size > MAX_COMPRESSED_BYTES) throw new Error('backup file is too large');
  return decodeBackup(await fs.readFile(file));
}

async function realDirectory(dir: string, rootDir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} must be a real directory`);
  const relative = path.relative(await fs.realpath(rootDir), await fs.realpath(dir));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${dir} must stay inside the project`);
  }
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error(`${file} must be a regular file`);
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err;
  }
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Write the backup's session handoffs into `.cws/sessions`; returns how many were written. */
export async function restoreHandoffs(rootDir: string, handoffs: Record<string, string>): Promise<number> {
  const entries = Object.entries(handoffs);
  if (entries.length === 0) return 0;
  const dir = path.join(rootDir, CWS_DIR, SESSIONS_DIR);
  await realDirectory(dir, rootDir);
  for (const [sessionId, text] of entries) {
    assertSessionId(sessionId);
    await writeAtomic(path.join(dir, `${sessionId}.md`), text);
  }
  return entries.length;
}

export function autoBackupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODESPACES === 'true' || env.CWS_AUTO_BACKUP === '1';
}

async function pruneBackups(dir: string, keep: number): Promise<void> {
  const names = (await fs.readdir(dir)).filter((name) => BACKUP_NAME.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    const file = path.join(dir, name);
    if ((await fs.lstat(file)).isFile()) await fs.rm(file);
  }
}

/** Save a backup into `.cws/backups`, keeping the newest AUTO_BACKUP_KEEP; returns the file path. */
export async function writeAutoBackup(rootDir: string, now: Date = new Date()): Promise<string> {
  const dir = path.join(rootDir, CWS_DIR, BACKUPS_DIR);
  await realDirectory(dir, rootDir);
  const file = path.join(dir, backupFileName(now));
  await fs.writeFile(file, encodeBackup(await collectBackup(rootDir, now)), { flag: 'wx' });
  await pruneBackups(dir, AUTO_BACKUP_KEEP);
  return file;
}
