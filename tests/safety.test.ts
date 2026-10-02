import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Command } from 'commander';
import { registerSafety } from '../src/cli/commands/safety.ts';
import { CliExit } from '../src/cli/human.ts';
import type { CliIO } from '../src/cli/io.ts';
import { assessCommandSafety } from '../src/safety/command-guard.ts';

const root = path.resolve(path.join(process.cwd(), 'tmp-safe-root'));
const cwd = path.join(root, 'app');

const assess = (args: string[]) => assessCommandSafety(args, { cwd, projectRoot: root });

describe('command safety guard', () => {
  it('allows ordinary non-shell commands', () => {
    const result = assess(['npm', 'test']);
    assert.equal(result.ok, true);
    assert.equal(result.destructive, false);
  });

  it('does not block everyday reads and uppercase rm flags', () => {
    for (const args of [['git', 'config', 'user.name'], ['git', 'config', '--get', 'user.email'], ['rm', '-Rf', 'dist']]) {
      assert.equal(assess(args).ok, true, args.join(' '));
    }
    assert.equal(assess(['git', 'config', 'user.name', 'x']).ok, false);
    assert.equal(assess(['git', 'config', '--global', 'alias.x', '!sh']).ok, false);
  });

  it('treats shred as a delete, limited to the project', () => {
    assert.equal(assess(['shred', '-u', 'dist/a']).ok, false);
    assert.equal(assess(['shred', '../../outside']).ok, false);
  });

  it('allows destructive cleanup only for explicit paths inside the project', () => {
    const result = assess(['rm', '-rf', 'dist']);
    assert.equal(result.ok, true);
    assert.equal(result.destructive, true);
    assert.deepEqual(result.targets, [path.join(cwd, 'dist')]);
  });

  it('blocks deletes outside the project root', () => {
    const outside = path.join(path.dirname(root), 'other-project');
    const result = assess(['Remove-Item', '-Recurse', '-Force', outside]);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /outside/i);
  });

  it('blocks deleting the project root itself', () => {
    const result = assess(['rm', '-rf', root]);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /project root/i);
  });

  it('blocks deleting a filesystem root or drive root', () => {
    const driveRoot = path.parse(root).root;
    const result = assess(['rm', '-rf', driveRoot]);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /filesystem root/i);
  });

  it('blocks broad wildcard deletes', () => {
    const result = assess(['rm', '-rf', 'dist/*']);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /wildcard/i);
  });

  it('blocks shell chains because the guard cannot prove every segment safe', () => {
    const result = assess(['npm', 'test', '&&', 'rm', '-rf', 'dist']);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /shell operator/i);
  });

  it('blocks shell interpreters with inline commands', () => {
    const result = assess(['powershell', '-Command', 'Remove-Item -Recurse C:\\Users']);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /shell/i);
  });

  it('blocks git cleanup commands that can erase untracked work broadly', () => {
    const result = assess(['git', 'clean', '-fdx']);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? '', /git clean/i);
  });

  it('assesses every operand including absolute POSIX paths', () => {
    for (const target of ['/', '/outside', path.join(path.dirname(root), 'outside')]) {
      const result = assess(['rm', '-rf', 'dist', target]);
      assert.equal(result.ok, false, target);
      assert.match(result.reason ?? '', /filesystem root|outside/i);
    }
    assert.deepEqual(assess(['rm', '-rf', 'dist', 'build']).targets,
      [path.join(cwd, 'dist'), path.join(cwd, 'build')]);
  });

  it('honors rm operand boundaries without interpreting later operands as flags', () => {
    const result = assess(['rm', '-rf', '--', '-cache', '--force']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.targets, [path.join(cwd, '-cache'), path.join(cwd, '--force')]);
    assert.equal(assess(['rm', '--', 'dist', '/outside']).ok, false);
  });

  it('refuses unsupported, value-taking, ambiguous and empty delete arguments', () => {
    for (const args of [
      ['rm', '--unknown', 'dist'], ['rm', '--interactive', 'never', 'dist'],
      ['rm', '-rfZ', 'dist'], ['rm', '-rf', ''], ['rm', '--'],
      ['rmdir', '-p', 'dist'], ['Remove-Item', '-Pa', 'dist'],
      ['Remove-Item', '-Path'], ['Remove-Item', '-Path', '-Force', 'dist'],
      ['del', '/unknown', 'dist'],
    ]) {
      assert.equal(assess(args).ok, false, args.join(' '));
    }
  });

  it('detects git clean after global options conservatively', () => {
    for (const args of [
      ['git', '-C', '.', 'clean', '-fdx'],
      ['git', '-c', 'color.ui=false', 'clean', '-fd'],
      ['git', '--work-tree=.', 'clean', '-fdx'],
    ]) {
      const result = assess(args);
      assert.equal(result.ok, false);
      assert.match(result.reason ?? '', /git clean/i);
    }
  });

  it('rejects shell-only deletion commands with actionable runtime guidance', () => {
    const commands = ['Remove-Item', 'ri', 'del', 'erase', 'rd',
      ...(process.platform === 'win32' ? ['rmdir'] : [])];
    for (const command of commands) {
      const result = assess([command, 'dist']);
      assert.equal(result.ok, false, command);
      assert.match(result.reason ?? '', /shell: false|shell-only/i);
      assert.match(result.reason ?? '', /executable|terminal/i);
    }
    assert.match(assess(['ri', '-LiteralPath:/outside']).reason ?? '', /outside/i);
    assert.match(assess(['del', '/q', '/outside']).reason ?? '', /option|outside/i);
  });

  it('resolves symlink and junction parents, including missing descendants and linked roots', (test) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cws-safety-'));
    test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const project = path.join(temporary, 'project');
    const outside = path.join(temporary, 'outside');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'victim'), 'keep');
    const link = path.join(project, 'link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const context = { cwd: project, projectRoot: project };
    for (const target of ['link/victim', 'link/missing/victim', 'link/', 'link/.',
      ...(process.platform !== 'win32' ? ['link/../victim'] : [])]) {
      const result = assessCommandSafety(['rm', '-rf', target], context);
      assert.equal(result.ok, false, target);
      assert.match(result.reason ?? '', /physical|symlink|outside/i);
    }
    assert.equal(assessCommandSafety(['rm', '-rf', 'link'], context).ok, true);
    const internal = path.join(project, 'internal');
    fs.mkdirSync(internal);
    fs.symlinkSync(internal, path.join(project, 'internal-link'),
      process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(assessCommandSafety(['rm', '-rf', 'internal-link/missing/victim'], context).ok, true);
    const dangling = path.join(project, 'dangling');
    fs.symlinkSync(path.join(outside, 'missing'), dangling,
      process.platform === 'win32' ? 'junction' : 'dir');
    const unverified = assessCommandSafety(['rm', '-rf', 'dangling/victim'], context);
    assert.equal(unverified.ok, false);
    assert.match(unverified.reason ?? '', /cannot verify physical/i);
    assert.equal(assessCommandSafety(['rm', '-rf', 'dangling'], context).ok, true);
    assert.equal(fs.readFileSync(path.join(outside, 'victim'), 'utf8'), 'keep');
    const alias = path.join(temporary, 'alias');
    fs.symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(assessCommandSafety(['rm', '-rf', 'dist'],
      { cwd: alias, projectRoot: alias }).ok, true);
    assert.equal(assessCommandSafety(['rm', '-rf', project],
      { cwd: alias, projectRoot: alias }).ok, false);
  });

  it('sees through Windows trailing dots, spaces and extensions on the command name', () => {
    for (const command of ['rm.', 'rm.exe.', 'rm.exe ', 'RM.EXE', 'rm.com', 'C:\\bin\\rm.exe.', 'rm.exe::$DATA']) {
      const result = assess([command, '-rf', '/outside']);
      assert.equal(result.ok, false, command);
      assert.match(result.reason ?? '', /outside|filesystem root/i, command);
    }
    for (const command of ['cmd.', 'cmd.exe ', 'bash.exe.']) {
      assert.match(assess([command, '/c', 'echo']).reason ?? '', /shell/i, command);
    }
    assert.match(assess(['git.', 'reset', '--hard']).reason ?? '', /reset --hard/i);
  });

  it('refuses drive-relative and alternate-data-stream delete targets', () => {
    for (const target of ['E:..\\..\\Dev', 'E:..', 'c:dist', 'src:stream', 'dist\\a.txt:hidden', 'dist::$DATA']) {
      const result = assess(['rm', '-rf', target]);
      assert.equal(result.ok, false, target);
      assert.match(result.reason ?? '', /drive-relative|colon|stream/i, target);
    }
  });

  it('protects .git and .cws and everything under them', () => {
    for (const target of ['.git', '.git/objects', '../.git', '../.cws', '../.cws/events.jsonl', '../.GIT/HEAD',
      ...(process.platform === 'win32' ? ['../.git.', '../.cws ', '..\\.git\\'] : [])]) {
      const result = assess(['rm', '-rf', target]);
      assert.equal(result.ok, false, target);
      assert.match(result.reason ?? '', /protected|\.git|\.cws|trailing/i, target);
    }
    assert.equal(assess(['rm', '-rf', 'dist/.gitkeep']).ok, true);
    assert.equal(assess(['rm', '-rf', '../.github-cache']).ok, true);
  });

  it('blocks destructive git forms, including abbreviated options', () => {
    for (const args of [
      ['git', 'reset', '--h'], ['git', 'reset', '--har', 'HEAD~1'],
      ['git', 'push', '--force'], ['git', 'push', '-f'], ['git', 'push', '-uf', 'origin', 'main'],
      ['git', 'push', '--forc'], ['git', 'push', '--force-with-lease=main'], ['git', 'push', '--mirror'],
      ['git', 'push', '--delete', 'origin', 'x'], ['git', 'push', 'origin', '+main'], ['git', 'push', 'origin', ':main'],
      ['git', 'checkout', '-f'], ['git', 'checkout', '--', 'src'], ['git', 'checkout', '.'],
      ['git', 'switch', '--discard-changes', 'main'], ['git', 'restore', 'src'],
      ['git', 'stash', 'drop'], ['git', 'stash', 'clear'], ['git', 'branch', '-D', 'x'],
      ['git', 'branch', '--delete', '--force', 'x'], ['git', 'clean', '-n'],
    ]) {
      const result = assess(args);
      assert.equal(result.ok, false, args.join(' '));
      assert.equal(result.destructive, true, args.join(' '));
    }
    for (const args of [['git', 'status'], ['git', 'push', 'origin', 'main'], ['git', 'checkout', 'main'],
      ['git', 'branch', '-d', 'merged'], ['git', 'stash', 'list'], ['git', 'config', '--get', 'user.name'], ['git', '--version']]) {
      assert.equal(assess(args).ok, true, args.join(' '));
    }
  });

  it('blocks git config injection, config writes and unknown subcommands that may be aliases', () => {
    for (const args of [
      ['git', '-c', 'alias.st=!rm -rf /', 'st'], ['git', '-calias.x=!sh', 'x'], ['git', '--config-env=core.pager=X', 'log'],
      ['git', '--exec-path=/tmp/evil', 'status'], ['git', 'config', 'alias.st', '!rm -rf /'],
      ['git', 'config', 'core.hooksPath', '/tmp'], ['git', 'nuke'], ['git', '-C', '.', 'my-alias'],
    ]) {
      const result = assess(args);
      assert.equal(result.ok, false, args.join(' '));
      assert.match(result.reason ?? '', /git/i, args.join(' '));
    }
  });

  it('blocks wrappers, interpreters and package runners that hide the real command', () => {
    for (const command of ['env', 'sudo', 'doas', 'xargs', 'busybox', 'wsl', 'wsl.exe', 'node', 'node.exe', 'deno', 'bun',
      'python', 'python3', 'python3.12', 'py', 'perl', 'ruby', 'npx', 'pnpx', 'bunx', 'dash', 'fish', 'ksh', 'zsh',
      'pwsh', 'pwsh-preview', 'powershell_ise', 'nohup', 'timeout']) {
      const result = assess([command, 'rm', '-rf', '/']);
      assert.equal(result.ok, false, command);
      assert.equal(result.destructive, true, command);
    }
    for (const args of [['npm', 'exec', 'rimraf', '/'], ['npm', 'x', 'rimraf'], ['pnpm', 'dlx', 'rimraf'], ['yarn', 'dlx', 'rimraf']]) {
      assert.equal(assess(args).ok, false, args.join(' '));
    }
    assert.equal(assess(['npm', 'run', 'build']).ok, true);
  });

  it('blocks find with actions and robocopy mirroring', () => {
    for (const args of [['find', '.', '-delete'], ['find', '.', '-name', 'x', '-exec', 'rm', '{}', '+'],
      ['find', '.', '-execdir', 'rm', '{}', '+'], ['find', '.', '-okdir', 'rm'],
      ['robocopy', 'empty', 'dist', '/MIR'], ['robocopy', 'a', 'b', '/purge'], ['robocopy.exe', 'a', 'b', '/MOVE']]) {
      const result = assess(args);
      assert.equal(result.ok, false, args.join(' '));
      assert.equal(result.destructive, true, args.join(' '));
    }
    assert.equal(assess(['find', '.', '-name', 'x.ts']).ok, true);
    assert.equal(assess(['robocopy', 'a', 'b', '/E']).ok, true);
  });

  it('blocks builtins in both CLI check and execution modes without spawning a shell', async () => {
    for (const check of [true, false]) {
      const errors: string[] = [];
      const io: CliIO = {
        cwd: process.cwd(), stdout: () => {}, stderr: (text) => errors.push(text),
        isInteractive: false, ask: async () => '', readStdin: async () => '',
        challenge: () => '', copy: async () => false,
      };
      const program = new Command();
      registerSafety(program, { io });
      await assert.rejects(program.parseAsync(['safe-run', ...(check ? ['--check'] : []),
        '--', 'Remove-Item', '-LiteralPath', 'dist'], { from: 'user' }), CliExit);
      assert.match(errors.join(''), /shell: false|shell-only/i);
    }
  });
});
