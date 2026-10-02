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
