import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  clearCredentials,
  credentialsPath,
  isLoggedIn,
  loadCredentials,
  saveCredentials,
  type UserCredentials,
} from '../../src/cloud/auth.ts';
import { runCli } from '../../src/cli/app.ts';
import { type CliIO } from '../../src/cli/io.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
  copied: string[];
}

let dir: string;
let customCredsPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-auth-test-'));
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

describe('cloud/auth: credentials storage', () => {
  it('loads null when credentials file is missing', async () => {
    const creds = await loadCredentials(customCredsPath);
    assert.equal(creds, null);
    assert.equal(await isLoggedIn(customCredsPath), false);
  });

  it('saves and reloads credentials successfully', async () => {
    const sample: UserCredentials = {
      uid: 'user_123',
      email: 'user@example.com',
      displayName: 'Alice User',
      refreshToken: 'sample_refresh_token_xyz',
    };

    await saveCredentials(sample, customCredsPath);
    const loaded = await loadCredentials(customCredsPath);
    assert.deepEqual(loaded, sample);
    assert.equal(await isLoggedIn(customCredsPath), true);
  });

  it('clears credentials on logout', async () => {
    const sample: UserCredentials = {
      uid: 'user_123',
      refreshToken: 'sample_refresh_token_xyz',
    };

    await saveCredentials(sample, customCredsPath);
    assert.equal(await isLoggedIn(customCredsPath), true);

    const cleared = await clearCredentials(customCredsPath);
    assert.equal(cleared, true);
    assert.equal(await isLoggedIn(customCredsPath), false);
    assert.equal(await loadCredentials(customCredsPath), null);
  });

  it('cws login --token saves credentials and cws logout removes them', async () => {
    const io = human();
    const token = 'my-test-token-12345';

    const loginCode = await runCli(['login', '--token', token], io, {
      credentialsPath: customCredsPath,
    });
    assert.equal(loginCode, 0);
    assert.match(io.out.join('\n'), /logged in/i);

    const creds = await loadCredentials(customCredsPath);
    assert.ok(creds);
    assert.equal(creds.refreshToken, token);

    // cws logout
    io.out.length = 0;
    const logoutCode = await runCli(['logout'], io, {
      credentialsPath: customCredsPath,
    });
    assert.equal(logoutCode, 0);
    assert.match(io.out.join('\n'), /logged out/i);
    assert.equal(await isLoggedIn(customCredsPath), false);
  });
});
