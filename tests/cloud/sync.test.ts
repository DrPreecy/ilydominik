import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../../src/cli/app.ts';
import { type CliIO } from '../../src/cli/io.ts';
import { EventLog } from '../../src/store/event-log.ts';
import { saveCredentials, type UserCredentials } from '../../src/cloud/auth.ts';
import {
  type FirestoreSyncClient,
  type RemoteEventDoc,
  type RemoteProjectMeta,
} from '../../src/cloud/sync.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
  copied: string[];
}

let dir: string;
let customCredsPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-sync-test-'));
  customCredsPath = path.join(dir, 'credentials.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function human(answers: string[] = []): FakeIO {
  const io: FakeIO = {
    cwd: dir,
    out: [],
    err: [],
    answers: [...answers],
    copied: [],
    isInteractive: true,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async () => io.answers.shift() ?? '',
    readStdin: async () => '',
    challenge: () => 'K7Q',
    copy: async (t) => {
      io.copied.push(t);
      return true;
    },
  };
  return io;
}

class MockFirestoreSyncClient implements FirestoreSyncClient {
  meta: Map<string, RemoteProjectMeta> = new Map();
  events: Map<string, RemoteEventDoc[]> = new Map();

  private key(uid: string, projectId: string): string {
    return `${uid}/${projectId}`;
  }

  async getProjectMeta(uid: string, projectId: string): Promise<RemoteProjectMeta | null> {
    return this.meta.get(this.key(uid, projectId)) ?? null;
  }

  async setProjectMeta(uid: string, projectId: string, meta: RemoteProjectMeta): Promise<void> {
    this.meta.set(this.key(uid, projectId), { ...meta });
  }

  async getEvents(uid: string, projectId: string, fromSeq: number, toSeq?: number): Promise<RemoteEventDoc[]> {
    const list = this.events.get(this.key(uid, projectId)) ?? [];
    return list.filter((e) => e.seq >= fromSeq && (toSeq === undefined || e.seq <= toSeq));
  }

  async pushEvents(
    uid: string,
    projectId: string,
    newEvents: RemoteEventDoc[],
    newMeta: RemoteProjectMeta,
  ): Promise<void> {
    const k = this.key(uid, projectId);
    const existing = this.events.get(k) ?? [];
    // Enforce append-only in mock: cannot overwrite existing seq
    const existingSeqs = new Set(existing.map((e) => e.seq));
    for (const e of newEvents) {
      if (existingSeqs.has(e.seq)) {
        throw new Error(`Event at seq ${e.seq} already exists (append-only violation)`);
      }
    }
    this.events.set(k, [...existing, ...newEvents]);
    this.meta.set(k, { ...newMeta });
  }
}

async function initProject(io: FakeIO, title = 'Garden Project'): Promise<void> {
  await runCli(['init', title], io);
  io.out.length = 0;
  io.err.length = 0;
}

async function loginUser(credsPath: string): Promise<void> {
  const creds: UserCredentials = {
    uid: 'test_uid_1',
    email: 'user@example.com',
    displayName: 'Test User',
    refreshToken: 'mock_refresh_token',
  };
  await saveCredentials(creds, credsPath);
}

describe('cloud/sync: cws sync link & status', () => {
  it('cws sync link saves remote projectId in integrations config', async () => {
    const io = human();
    await initProject(io);

    const code = await runCli(['sync', 'link', 'remote-cws-1'], io);
    assert.equal(code, 0);
    assert.match(io.out.join('\n'), /linked/i);

    const integrations = JSON.parse(await fs.readFile(path.join(dir, '.cws', 'integrations.json'), 'utf8'));
    assert.equal(integrations.sync?.projectId, 'remote-cws-1');
  });

  it('cws sync status reports not logged in when unauthenticated', async () => {
    const io = human();
    await initProject(io);

    const code = await runCli(['sync', 'status'], io, { credentialsPath: customCredsPath });
    assert.equal(code, 0);
    assert.match(io.out.join('\n'), /not logged in/i);
  });

  it('cws sync status reports up to date after first push', async () => {
    const io = human();
    await initProject(io);
    await loginUser(customCredsPath);
    const mockClient = new MockFirestoreSyncClient();

    // Push first
    const pushCode = await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.equal(pushCode, 0);

    // Status
    io.out.length = 0;
    const statusCode = await runCli(['sync', 'status'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.equal(statusCode, 0);
    assert.match(io.out.join('\n'), /up to date/i);
  });
});

describe('cloud/sync: push & pull', () => {
  it('first push uploads all local events and creates remote metadata', async () => {
    const io = human();
    await initProject(io);
    await loginUser(customCredsPath);
    const mockClient = new MockFirestoreSyncClient();

    // Add a note locally
    await runCli(['dump', 'first note text'], io);

    const log = await EventLog.open(dir);
    assert.equal(log.events.length, 2); // PROJECT_CREATED + NOTE_ADDED

    const code = await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.equal(code, 0);
    assert.match(io.out.join('\n'), /pushed/i);

    const meta = await mockClient.getProjectMeta('test_uid_1', log.state.id);
    assert.ok(meta);
    assert.equal(meta.headSeq, 1);
    assert.equal(meta.headHash, log.events[1]?.hash);

    const remoteEvents = await mockClient.getEvents('test_uid_1', log.state.id, 0);
    assert.equal(remoteEvents.length, 2);
  });

  it('pushing again when up to date reports already up to date', async () => {
    const io = human();
    await initProject(io);
    await loginUser(customCredsPath);
    const mockClient = new MockFirestoreSyncClient();

    await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });

    io.out.length = 0;
    const code2 = await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.equal(code2, 0);
    assert.match(io.out.join('\n'), /up to date/i);
  });

  it('detects history divergence on push and refuses to overwrite', async () => {
    const io = human();
    await initProject(io);
    await loginUser(customCredsPath);
    const mockClient = new MockFirestoreSyncClient();

    const log = await EventLog.open(dir);

    // Set remote head with a different hash at the same seq (simulating another device wrote an event)
    await mockClient.pushEvents(
      'test_uid_1',
      log.state.id,
      [
        {
          seq: 0,
          hash: 'different-diverged-hash',
          prevHash: '0',
          event: { type: 'PROJECT_CREATED', v: 1 },
        },
      ],
      {
        name: 'Remote Project',
        headSeq: 0,
        headHash: 'different-diverged-hash',
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      },
    );

    const code = await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.notEqual(code, 0);
    assert.match(io.err.join('\n'), /diverged/i);
  });

  it('pull downloads new remote events, validates them and updates local log', async () => {
    const io = human();
    await initProject(io);
    await loginUser(customCredsPath);
    const mockClient = new MockFirestoreSyncClient();

    // Push initial project
    await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });

    const log1 = await EventLog.open(dir);

    // Simulate another device pushed a valid note to remote
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-remote-device-'));
    try {
      await fs.mkdir(path.join(remoteDir, '.cws'), { recursive: true });
      await fs.copyFile(path.join(dir, '.cws', 'events.jsonl'), path.join(remoteDir, '.cws', 'events.jsonl'));
      const remoteLog = await EventLog.open(remoteDir);
      const noteEvent = await remoteLog.append({
        type: 'NOTE_ADDED',
        actor: { kind: 'human' },
        payload: { noteId: 'n_remote', text: 'note from phone' },
      });
      assert.ok(noteEvent);

      await mockClient.pushEvents(
        'test_uid_1',
        log1.state.id,
        [
          {
            seq: noteEvent.seq,
            hash: noteEvent.hash,
            prevHash: noteEvent.prevHash,
            event: noteEvent,
          },
        ],
        {
          name: log1.state.title,
          headSeq: noteEvent.seq,
          headHash: noteEvent.hash,
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
      );
    } finally {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }

    // Pull from remote
    io.out.length = 0;
    const pullCode = await runCli(['sync', 'pull'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.equal(pullCode, 0);
    assert.match(io.out.join('\n'), /pulled/i);

    // Verify local log now has 2 events
    const log2 = await EventLog.open(dir);
    assert.equal(log2.events.length, 2);
    assert.equal(log2.state.notes.length, 1);
    assert.equal(log2.state.notes[0]?.text, 'note from phone');
  });

  it('pull rejects tampered remote events without modifying local log', async () => {
    const io = human();
    await initProject(io);
    await loginUser(customCredsPath);
    const mockClient = new MockFirestoreSyncClient();

    await runCli(['sync', 'push'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });

    const log1 = await EventLog.open(dir);

    // Simulate invalid remote event with broken sequence
    await mockClient.pushEvents(
      'test_uid_1',
      log1.state.id,
      [
        {
          seq: 999, // broken seq
          hash: 'fake-hash',
          prevHash: log1.events[0]?.hash ?? '',
          event: { seq: 999, type: 'NOTE_ADDED' },
        },
      ],
      {
        name: log1.state.title,
        headSeq: 999,
        headHash: 'fake-hash',
        updatedAt: new Date().toISOString(),
        schemaVersion: 1,
      },
    );

    io.err.length = 0;
    const pullCode = await runCli(['sync', 'pull'], io, {
      credentialsPath: customCredsPath,
      firestoreSyncClient: mockClient,
    });
    assert.notEqual(pullCode, 0);
    assert.match(io.err.join('\n'), /broken|verification|rejected|invalid/i);

    // Local log is completely unchanged
    const log2 = await EventLog.open(dir);
    assert.equal(log2.events.length, 1);
  });
});
