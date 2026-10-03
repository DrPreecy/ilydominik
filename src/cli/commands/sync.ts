import type { Command } from 'commander';
import { clearCredentials, loadCredentials, loginWithToken } from '../../cloud/auth.ts';
import {
  checkSyncStatus,
  DefaultFirestoreSyncClient,
  syncPull,
  syncPush,
  type FirestoreSyncClient,
} from '../../cloud/sync.ts';
import { loadIntegrations, updateSyncConfig } from '../../integrations/config.ts';
import { fail, openLog, projectRoot, say, type Env } from '../human.ts';

function getClient(env: Env): FirestoreSyncClient {
  return env.firestoreSyncClient ?? new DefaultFirestoreSyncClient();
}

export async function login(env: Env, opts: { token?: string }): Promise<void> {
  if (opts.token) {
    const creds = await loginWithToken(opts.token, env.credentialsPath);
    say(env, `Logged in successfully as ${creds.email ?? creds.uid}.`);
    return;
  }

  if (!env.io.isInteractive) {
    fail(
      env,
      'error: interactive login requires a terminal. Use `cws login --token <token>` instead.',
    );
  }

  say(
    env,
    'To log in with your Google account, enter your auth token or access credential:',
    '(You can obtain one from the web dashboard or Firebase console)',
  );
  const token = await env.io.ask('Token: ');
  if (!token.trim()) {
    fail(env, 'error: no token provided; login cancelled.');
  }

  const creds = await loginWithToken(token.trim(), env.credentialsPath);
  say(env, `Logged in successfully as ${creds.email ?? creds.uid}.`);
}

export async function logout(env: Env): Promise<void> {
  const cleared = await clearCredentials(env.credentialsPath);
  if (cleared) {
    say(env, 'Logged out; saved credentials removed.');
  } else {
    say(env, 'Already logged out; no credentials found.');
  }
}

async function requireAuthAndProject(
  env: Env,
): Promise<{ rootDir: string; uid: string; email?: string; projectId: string }> {
  const log = await openLog(env);
  const creds = await loadCredentials(env.credentialsPath);
  if (!creds) {
    fail(env, 'error: not logged in. Run `cws login` first.');
  }

  const { config } = await loadIntegrations(log.rootDir);
  const projectId = config.sync.projectId || log.state.id;
  return { rootDir: log.rootDir, uid: creds.uid, email: creds.email, projectId };
}

export async function syncLink(env: Env, projectIdArg: string): Promise<void> {
  const root = projectRoot(env);
  if (!root) {
    fail(env, 'No CWS project here. Start one with: cws init <title>');
  }

  const clean = projectIdArg.trim();
  if (!clean) {
    fail(env, 'error: remote project ID cannot be blank.');
  }

  await updateSyncConfig(root, { projectId: clean });
  say(env, `Linked local project to remote project "${clean}".`);
}

export async function syncStatus(env: Env): Promise<void> {
  const log = await openLog(env);
  const creds = await loadCredentials(env.credentialsPath);
  const { config } = await loadIntegrations(log.rootDir);
  const projectId = config.sync.projectId || log.state.id;

  say(env, '=== CWS Sync Status ===', `Local Project ID:  ${log.state.id} ("${log.state.title}")`);

  if (!creds) {
    say(
      env,
      'Account:           Not logged in',
      'Remote Status:     Run `cws login` to connect to Google Cloud',
    );
    return;
  }

  say(env, `Account:           ${creds.email ?? creds.uid} (logged in)`);
  say(env, `Remote Project ID: ${projectId}${config.sync.projectId ? ' (explicitly linked)' : ' (defaults to local ID)'}`);

  const client = getClient(env);
  let status;
  try {
    status = await checkSyncStatus(log.rootDir, creds.uid, projectId, client);
  } catch (err: unknown) {
    fail(env, `error: failed to contact remote Firestore: ${err instanceof Error ? err.message : String(err)}`);
  }

  say(env, `Local Head:        seq ${status.localHeadSeq} (hash: ${status.localHeadHash.slice(0, 12)}...)`);
  if (status.remoteHeadSeq !== undefined && status.remoteHeadHash !== undefined) {
    say(env, `Remote Head:       seq ${status.remoteHeadSeq} (hash: ${status.remoteHeadHash.slice(0, 12)}...)`);
  } else {
    say(env, 'Remote Head:       (none - remote project is empty)');
  }

  switch (status.state) {
    case 'UP_TO_DATE':
      say(env, 'Status:            Up to date ✓');
      break;
    case 'AHEAD':
      say(env, 'Status:            Ahead of remote (run `cws sync push` to sync)');
      break;
    case 'BEHIND':
      say(env, 'Status:            Behind remote (run `cws sync pull` to sync)');
      break;
    case 'DIVERGED':
      say(
        env,
        `Status:            DIVERGED at seq ${status.divergedAtSeq}!`,
        '⚠️ Local and remote histories differ. Automatic merging is disabled to protect history integrity.',
      );
      break;
    default:
      say(env, `Status:            ${status.state}`);
  }
}

export async function push(env: Env): Promise<void> {
  const { rootDir, uid, projectId } = await requireAuthAndProject(env);
  const client = getClient(env);

  try {
    const result = await syncPush(rootDir, uid, projectId, client);
    if (result.alreadyUpToDate) {
      say(env, `Up to date: remote project "${projectId}" is already at local head.`);
    } else {
      say(
        env,
        `Pushed ${result.pushedCount} event(s) (seq ${result.fromSeq} -> ${result.toSeq}) to remote project "${projectId}".`,
      );
    }
  } catch (err: unknown) {
    fail(env, `error: sync push failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function pull(env: Env): Promise<void> {
  const { rootDir, uid, projectId } = await requireAuthAndProject(env);
  const client = getClient(env);

  try {
    const result = await syncPull(rootDir, uid, projectId, client);
    if (result.alreadyUpToDate) {
      say(env, `Up to date: local project is already at remote head.`);
    } else {
      say(
        env,
        `Pulled ${result.pulledCount} event(s) (seq ${result.fromSeq} -> ${result.toSeq}) from remote project "${projectId}". Local project updated.`,
      );
    }
  } catch (err: unknown) {
    fail(env, `error: sync pull failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function syncAll(env: Env): Promise<void> {
  await pull(env);
  await push(env);
}

export function registerSync(program: Command, env: Env): void {
  program
    .command('login')
    .description('log in with Google credentials for cloud synchronization')
    .option('--token <token>', 'provide an authentication token directly')
    .action((opts: { token?: string }) => login(env, opts));

  program
    .command('logout')
    .description('log out and remove saved Google credentials')
    .action(() => logout(env));

  const syncCmd = program
    .command('sync [action]')
    .description('synchronize project events with Google Cloud Firestore (pull and push)')
    .action(async (action?: string) => {
      if (!action) {
        await syncAll(env);
      } else {
        fail(env, `error: unknown sync action "${action}" (choose from push, pull, status, link)`);
      }
    });

  syncCmd
    .command('push')
    .description('upload local un-synced events to Firestore')
    .action(() => push(env));

  syncCmd
    .command('pull')
    .description('download remote un-synced events from Firestore')
    .action(() => pull(env));

  syncCmd
    .command('status')
    .description('display sync relationship between local and remote project')
    .action(() => syncStatus(env));

  syncCmd
    .command('link <projectId>')
    .description('link this project to a remote Firestore project ID')
    .action((projectId: string) => syncLink(env, projectId));
}
