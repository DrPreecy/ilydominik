import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveCredentials } from '../../src/cloud/auth.ts';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('Copilot R1: credential file permissions', () => {
  it('tightens an existing credentials file to owner-only permissions', { skip: process.platform === 'win32' }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-redteam-auth-'));
    directories.push(directory);
    const file = path.join(directory, 'credentials.json');
    await fs.writeFile(file, '{}');
    await fs.chmod(file, 0o644);

    await saveCredentials({ uid: 'test-user', refreshToken: 'test-token' }, file);

    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });
});
