import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { registerSafety } from '../src/cli/commands/safety.ts';
import { CliExit } from '../src/cli/human.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { childEnv, clampTimeout, findExecutable, runInherited, runTool, systemToolPath } from '../src/integrations/exec.ts';

const isWin = process.platform === 'win32';
let tmp = '';
let repo = '';

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cws-exec-')));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  spawnSync('git', ['init', '-q'], { cwd: repo });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('childEnv: an allowlist, not a copy', () => {
  const source = {
    PATH: '/bin', Path: 'C:\\x', HOME: '/home/u', USERPROFILE: 'C:\\Users\\u', SystemRoot: 'C:\\Windows', TEMP: '/tmp', LANG: 'en_US.UTF-8', LC_ALL: 'C',
    GEMINI_API_KEY: 'k', OPENAI_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 's', NPM_TOKEN: 't', DB_PASSWORD: 'p',
    GOOGLE_APPLICATION_CREDENTIALS: 'f', SSH_AUTH_SOCK: '/s', CWS_TOKEN: 'x', SOME_OTHER: 'v', OPENSHELL_GATEWAY: 'g', OPENSHELL_TOKEN: 'o',
  };

  it('keeps what a program needs to start and drops credentials and unknown variables', () => {
    const env = childEnv(source);
    assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LC_ALL', 'OPENSHELL_GATEWAY', 'OPENSHELL_TOKEN', 'PATH', 'Path', 'SystemRoot', 'TEMP', 'USERPROFILE']);
  });

  it('lets a caller name extra variables or prefixes on purpose, but prefixes still drop secrets', () => {
    const env = childEnv(source, { names: ['SSH_AUTH_SOCK', 'some_other'], prefixes: ['GIT_', 'CWS_'] });
    assert.equal(env.SSH_AUTH_SOCK, '/s');
    assert.equal(env.SOME_OTHER, 'v');
    assert.equal(env.CWS_TOKEN, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);
  });

  it('returns a new object and leaves the source untouched', () => {
    const copy = { ...source };
    const env = childEnv(source);
    env.PATH = 'changed';
    assert.deepEqual(source, copy);
  });

  it('runTool children never see parent secrets, even in lower-case form', async () => {
    process.env.GEMINI_API_KEY = 'canary-gemini';
    process.env.my_secret_token = 'canary-token';
    try {
      const result = await runTool(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))']);
      const names = (JSON.parse(result.stdout) as string[]).map((name) => name.toLowerCase());
      assert.ok(!names.includes('gemini_api_key'));
      assert.ok(!names.includes('my_secret_token'));
      assert.ok(names.includes('path'));
    } finally {
      delete process.env.GEMINI_API_KEY;
      delete process.env.my_secret_token;
    }
  });
});

describe('exec helpers', () => {
  it('clampTimeout keeps timers inside setTimeout range and falls back for junk', () => {
    assert.equal(clampTimeout(undefined, 30), 30);
    assert.equal(clampTimeout(Number.NaN, 30), 30);
    assert.equal(clampTimeout(0, 30), 1);
    assert.equal(clampTimeout(-5, 30), 1);
    assert.equal(clampTimeout(Infinity, 30), 2 ** 31 - 1);
    assert.equal(clampTimeout(2 ** 31, 30), 2 ** 31 - 1);
    assert.equal(clampTimeout(1500.9, 30), 1500);
  });

  it('systemToolPath is absolute under System32 on Windows and the bare name elsewhere', () => {
    assert.equal(systemToolPath('taskkill', 'win32', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\taskkill.exe');
    assert.equal(systemToolPath('clip', 'win32', {}), 'C:\\Windows\\System32\\clip.exe');
    assert.equal(systemToolPath('clip', 'linux', { SystemRoot: 'D:\\Win' }), 'clip');
  });

  it('findExecutable finds both `node` and `node.exe` on Windows', { skip: !isWin }, () => {
    assert.notEqual(findExecutable('node'), null);
    assert.notEqual(findExecutable('node.exe'), null);
    assert.equal(findExecutable('definitely-not-a-program.exe'), null);
  });

  it('runTool kills a runaway child at the timeout and reports it', async () => {
    const started = Date.now();
    const result = await runTool(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 10_000);
  });

  it('runInherited resolves with the exit code and kills a runaway child at the timeout', async () => {
    const quick = await runInherited(process.execPath, ['-e', 'process.exit(5)'], { timeoutMs: 20_000 });
    assert.deepEqual({ code: quick.code, timedOut: quick.timedOut }, { code: 5, timedOut: false });
    const slow = await runInherited(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 });
    assert.equal(slow.timedOut, true);
  });

  it('runInherited kills grandchildren too', async () => {
    const marker = path.join(tmp, 'grandchild-alive.txt');
    const grandchild = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 50)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setTimeout(() => {}, 20000)`;
    const result = await runInherited(process.execPath, ['-e', parent], { timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const first = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
    assert.equal(second, first, 'a grandchild kept running after the timeout');
  });
});

describe('safe-run runtime', () => {
  const ioFor = (cwd: string, errors: string[] = []): CliIO => ({
    cwd, stdout: () => {}, stderr: (text) => errors.push(text), isInteractive: false,
    ask: async () => '', readStdin: async () => '', challenge: () => '', copy: async () => false,
  });

  async function run(argv: string[], errors: string[] = [], cwd = tmp): Promise<number> {
    const program = new Command();
    program.exitOverride();
    registerSafety(program, { io: ioFor(cwd, errors) });
    try {
      await program.parseAsync(['safe-run', ...argv], { from: 'user' });
      return EXIT.OK;
    } catch (error: unknown) {
      if (error instanceof CliExit) return error.code;
      throw error;
    }
  }

  it('maps a failing child to exit 1, never to cws own 2 (NEEDS_HUMAN) or 3 (INTEGRITY), and prints the real code', async () => {
    const errors: string[] = [];
    // `git ls-remote --exit-code` exits 2 when no ref matches
    const exit = await run(['--', 'git', 'ls-remote', '--exit-code', repo, 'refs/heads/none'], errors, repo);
    assert.equal(exit, EXIT.ERROR);
    assert.match(errors.join(''), /failed \(exit code 2\)/);
  });

  it('passes a successful child through as exit 0', async () => {
    assert.equal(await run(['--', 'git', '--version'], [], repo), EXIT.OK);
  });

  it('rejects a bad --timeout and a blocked command', async () => {
    const errors: string[] = [];
    await assert.rejects(() => run(['--timeout', '0', '--', 'git', '--version'], errors));
    assert.equal(await run(['--', 'node', '-e', '1'], errors), EXIT.ERROR);
    assert.match(errors.join(''), /blocked/);
  });

  it('does not hand secrets to the child', { skip: findExecutable('printenv') === null }, async () => {
    process.env.GEMINI_API_KEY = 'canary-safe-run';
    try {
      // printenv exits 1 when the variable is not set in ITS environment
      assert.equal(await run(['--', 'printenv', 'GEMINI_API_KEY'], [], repo), EXIT.ERROR);
      assert.equal(await run(['--', 'printenv', 'PATH'], [], repo), EXIT.OK);
    } finally {
      delete process.env.GEMINI_API_KEY;
    }
  });
});
