import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { DomainError, type CwsEvent } from '../../domain/types.ts';
import { backupFileName, collectBackup, encodeBackup, readBackupFile, restoreHandoffs } from '../../store/backup.ts';
import { compareLogs, EventLog, restoreLog, type LogComparison } from '../../store/event-log.ts';
import { confirmDecision, fail, openLog, projectRoot, requireHuman, say, type Env } from '../human.ts';

const KEEP_PRIVATE = 'It contains all your notes and decisions: keep it private and store it outside this workspace.';

async function exportBackup(env: Env, opts: { to?: string }): Promise<void> {
  requireHuman(env, 'export');
  const log = await openLog(env);
  const target = path.resolve(env.io.cwd, opts.to ?? backupFileName());
  const bundle = await collectBackup(log.rootDir);
  try {
    await fs.writeFile(target, encodeBackup(bundle), { flag: 'wx' });
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail(env, `error: ${target} already exists; choose another --to path`);
    }
    throw error;
  }
  const handoffs = Object.keys(bundle.handoffs).length;
  say(env, `Backup written: ${target}`, `${bundle.eventCount} events, ${handoffs} session handoffs.`, KEEP_PRIVATE);
}

/** Local events, or null when a local log exists but cannot be read. */
async function localEvents(root: string): Promise<readonly CwsEvent[] | null> {
  try {
    return (await EventLog.open(root)).events;
  } catch (error: unknown) {
    if (!(error instanceof DomainError)) throw error;
    return error.code === 'NO_PROJECT' ? [] : null;
  }
}

function compare(local: readonly CwsEvent[] | null, incoming: readonly CwsEvent[]): LogComparison {
  return local === null ? { relation: 'diverged', common: 0 } : compareLogs(local, incoming);
}

const OUTCOME_TEXT = {
  created: 'Project memory restored from the backup.',
  'fast-forward': 'Local memory updated with the newer events from the backup.',
  replaced: 'Local memory replaced by the backup.',
  same: 'Already up to date; nothing imported.',
  'local-ahead': 'Your local memory is newer than this backup; nothing imported.',
} as const;

async function importBackup(env: Env, file: string, opts: { replace?: boolean }): Promise<void> {
  requireHuman(env, 'import');
  const { bundle, events } = await readBackupFile(path.resolve(env.io.cwd, file));
  const root = projectRoot(env) ?? env.io.cwd;
  const { relation, common } = compare(await localEvents(root), events);
  if (relation === 'same' || relation === 'local-ahead') return say(env, OUTCOME_TEXT[relation]);
  if (relation === 'diverged') {
    if (!opts.replace) {
      fail(
        env,
        `error: local memory and the backup differ from event ${common} on. Nothing was changed.\n` +
          'To overwrite local memory with the backup, run the import again with --replace.',
      );
    }
    say(env, `This overwrites the local event log in ${root} with the backup.`);
    await confirmDecision(env);
  }
  const outcome = await restoreLog(root, bundle.events, relation === 'diverged');
  const restored = outcome === 'same' || outcome === 'local-ahead' ? 0 : await restoreHandoffs(root, bundle.handoffs);
  say(env, OUTCOME_TEXT[outcome], `${events.length} events, ${restored} session handoffs restored.`);
}

export function registerBackup(program: Command, env: Env): void {
  program
    .command('export')
    .description('save the whole project memory into one backup file (human)')
    .option('--to <file>', 'where to write the backup')
    .action((o: { to?: string }) => exportBackup(env, o));
  program
    .command('import <file>')
    .description('restore project memory from a backup file (human)')
    .option('--replace', 'overwrite a local log that differs from the backup (asks for confirmation)')
    .action((f: string, o: { replace?: boolean }) => importBackup(env, f, o));
}
