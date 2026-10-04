import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessCommandSafety } from '../src/safety/command-guard.ts';

let tmp = '';
let root = '';

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cws-guard-rules-')));
  root = path.join(tmp, 'project');
  for (const d of ['.git/hooks', '.cws', 'src']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const verdict = (argv: string[], runsWithoutShell = true) => assessCommandSafety(argv, { cwd: root, projectRoot: root, runsWithoutShell });
const blocked = (list: string[][], runsWithoutShell = true): string[] =>
  list.filter((argv) => verdict(argv, runsWithoutShell).ok).map((argv) => argv.join(' '));
const allowed = (list: string[][], runsWithoutShell = true): string[] =>
  list.filter((argv) => !verdict(argv, runsWithoutShell).ok).map((argv) => `${argv.join(' ')} -> ${verdict(argv, runsWithoutShell).reason}`);

describe('guard: shell metacharacters in --check mode fail closed', () => {
  it('refuses every separator, substitution and escape a retyped shell would act on', () => {
    const notBlocked = blocked([
      ['git', 'log', '--format=x & calc'], ['git', 'log', '--format=x\nrm -rf src'], ['git', 'log', '--format=x\r\ncalc'],
      ['echo', '`id`'], ['echo', '$(id)'], ['echo', 'x ^& calc'], ['echo', 'a;b'], ['echo', 'a|b'], ['echo', 'a>b'], ['echo', 'a<b'],
    ], false);
    assert.deepEqual(notBlocked, []);
  });

  it('refuses ~, $VAR, ${VAR} and %VAR% because a shell turns them into other paths', () => {
    const notBlocked = blocked([
      ['rm', '-rf', '~'], ['rm', '-rf', '~/x'], ['rm', '-rf', '$HOME/x'], ['rm', '-rf', '${HOME}'], ['rm', '-rf', '%USERPROFILE%\\x'],
      ['cp', 'a', '--target-directory=~'], ['ls', 'PATH=~/bin'],
    ], false);
    assert.deepEqual(notBlocked, []);
  });

  it('keeps plain text through when cws runs the argv itself, and still refuses a bare operator argument', () => {
    assert.deepEqual(allowed([['git', 'commit', '-m', 'a; b | c & d `e` $(f) ^g'], ['rm', '-rf', 'src/~old']]), []);
    assert.deepEqual(blocked([['git', 'log', '&'], ['git', 'log', ';']]), []);
  });

  it('does not mistake ordinary revisions and formats for expansion', () => {
    assert.deepEqual(allowed([['git', 'show', 'HEAD~2'], ['git', 'log', '--format=%h %s'], ['git', 'diff', 'a..b']], false), []);
  });
});

describe('guard: git forms that run programs or destroy work', () => {
  it('blocks the program-running forms', () => {
    assert.deepEqual(blocked([
      ['git', 'rebase', '-x', 'calc', 'main'], ['git', 'rebase', '--exec', 'calc', 'main'], ['git', 'rebase', '--exe=calc'],
      ['git', 'bisect', 'run', 'calc'], ['git', 'submodule', 'foreach', '--recursive', 'calc'],
      ['git', 'fetch', '--upload-pack=calc'], ['git', 'fetch', '--upload-p=calc'], ['git', 'clone', '-u', 'calc', 'a', 'b'],
      ['git', 'push', '--receive-pack=calc'], ['git', 'push', '--exec=calc'], ['git', 'ls-remote', 'ext::calc'],
      ['git', 'remote', 'add', 'x', 'fd::3'], ['git', 'grep', '-O', 'calc', 'x'], ['git', 'grep', '--open-files-in-pager=calc'],
      ['git', 'diff', '--ext-diff'], ['git', 'init', '--template=../hooks'], ['git', 'merge', '-s', 'evil', 'x'],
      ['git', 'pull', '--strategy=evil'], ['git', 'commit', '--no-verify', '-m', 'x'], ['git', 'commit', '-nm', 'x'],
      ['git', 'push', '--no-verify'], ['git', '-c', 'core.hooksPath=/x', 'status'], ['git', '-c', 'core.sshCommand=calc', 'fetch'],
      ['git', '-ccore.pager=calc', 'log'], ['git', '--config-env=core.sshCommand=X', 'fetch'], ['git', '--exec-path=/x', 'status'],
      ['git', 'clone', '-c', 'core.sshCommand=calc', 'u'], ['git', 'clone', '--config=core.fsmonitor=calc', 'u'],
      ['git', 'constructor'], ['git', 'toString'],
    ]), []);
  });

  it('blocks the forms that discard work or history', () => {
    assert.deepEqual(blocked([
      ['git', 'clean', '-fdx'], ['git', 'gc', '--prune=now'], ['git', 'gc', '--prune'], ['git', 'reflog', 'expire', '--all'],
      ['git', 'reflog', 'delete', 'HEAD@{1}'], ['git', 'worktree', 'remove', '-f', 'x'], ['git', 'worktree', 'remove', 'x'],
      ['git', 'worktree', 'prune'], ['git', 'rm', '-r', 'src'], ['git', 'rm', '-f', 'src/a.ts'], ['git', 'rm', '.git/config'],
      ['git', 'checkout', 'HEAD', 'src/a.ts'], ['git', 'checkout', 'main', '--', 'src'], ['git', 'checkout', '-B', 'main'],
      ['git', 'checkout', '--ours', 'x'], ['git', 'checkout', '-p'], ['git', 'switch', '-C', 'main'], ['git', 'switch', '--force-create', 'x'],
      ['git', 'branch', '-f', 'main', 'HEAD~3'], ['git', 'branch', '-M', 'x'], ['git', 'tag', '-d', 'v1'], ['git', 'tag', '-f', 'v1'],
      ['git', 'remote', 'remove', 'origin'], ['git', 'stash', 'drop'], ['git', 'stash', '--quiet', 'clear'], ['git', 'reset', '--hard'],
      ['git', 'reset', '--ha'], ['git', 'push', '--force'], ['git', 'push', 'origin', ':main'], ['git', 'update-ref', '-d', 'x'],
    ]), []);
  });

  it('keeps git writes and repo retargeting inside the project', () => {
    assert.deepEqual(blocked([
      ['git', '-C', '../..', 'status'], ['git', '-C', '/', 'status'], ['git', '--work-tree=/', 'status'], ['git', '--work-tree', '/', 'status'],
      ['git', '--git-dir=../../other/.git', 'log'], ['git', 'log', '--output=src/a.ts'], ['git', 'diff', '--output', 'x'],
      ['git', 'archive', '-o', 'src/a.ts', 'HEAD'], ['git', 'archive', '--output=x.tar', 'HEAD'], ['git', 'format-patch', '-o', 'out', 'HEAD~1'],
      ['git', 'format-patch', '--output-directory=out', 'HEAD~1'], ['git', 'clone', 'u', '../../outside'], ['git', 'clone', 'u', '.git/x'],
      ['git', 'bundle', 'create', '../../b.bundle', 'HEAD'], ['git', 'mv', 'a', '../../x'], ['git', 'init', '--separate-git-dir=../../x'],
    ]), []);
  });

  it('still allows the everyday git commands', () => {
    assert.deepEqual(allowed([
      ['git', 'status'], ['git', 'log', '--oneline', '-5'], ['git', '-C', 'src', 'status'], ['git', '-C', '.', 'log'],
      ['git', '--git-dir=.git', 'status'], ['git', 'checkout', 'main'], ['git', 'checkout', '-b', 'x'], ['git', 'checkout', '-b', 'x', 'main'],
      ['git', 'switch', '-c', 'x'], ['git', 'branch', '-d', 'merged'], ['git', 'branch', '-a'], ['git', 'tag', 'v1'], ['git', 'tag'],
      ['git', 'commit', '-m', 'msg', '--amend'], ['git', 'commit', '-am', 'msg'], ['git', 'push', '-u', 'origin', 'x'],
      ['git', 'push'], ['git', 'merge', '-s', 'ours', 'x'], ['git', 'pull', '--rebase'],
      ['git', 'rebase', 'main'], ['git', 'rebase', '--onto', 'a', 'b'], ['git', 'cherry-pick', '-x', 'abc'], ['git', 'stash', 'pop'],
      ['git', 'remote', 'add', 'origin', 'https://example.com/x.git'], ['git', 'clone', 'https://example.com/x.git', 'copy'],
      ['git', 'rm', 'src/a.ts'], ['git', 'rm', '--cached', 'src/a.ts'], ['git', 'worktree', 'add', 'wt', 'main'], ['git', 'reflog'],
      ['git', 'gc'], ['git', 'diff', '--stat'], ['git', 'format-patch', '-1'], ['git', 'grep', '-n', 'x'], ['git', 'submodule', 'status'],
      ['git', 'bisect', 'start'], ['git', 'bisect', 'good'], ['git', 'log', '--output-indicator-new=+'],
    ]), []);
  });
});

describe('guard: writers cannot touch .cws, .git, outside the project, or an existing file', () => {
  it('blocks writes to protected paths', () => {
    assert.deepEqual(blocked([
      ['truncate', '-s', '0', '.cws/events.jsonl'], ['cp', 'x', '.cws/events.jsonl'], ['cp', 'evil', '.git/hooks/pre-commit'],
      ['cp', '-t', '.git/hooks', 'evil'], ['install', 'evil', '.git/hooks/pre-commit'], ['dd', 'if=x', 'of=.cws/events.jsonl'],
      ['dd', 'if=x', 'of=.git/config'], ['sed', '-i', 's/a/b/', '.cws/events.jsonl'], ['sed', '--in-place=.bak', 's/a/b/', 'x'],
      ['sed', '-ni', 'p', 'x'], ['tee', '.git/hooks/pre-commit'], ['tee', '-a', '.cws/events.jsonl'], ['ln', '-s', 'x', '.git/hooks/pre-commit'],
      ['rsync', '-a', '--delete', 'e/', '.cws/'], ['rsync', '-a', 'e/', '.git/hooks/'], ['rsync', '-a', '--remove-source-files', 'a', 'b'],
      ['rsync', '-e', 'calc', 'a', 'b'], ['tar', '--remove-files', '-cf', 'a.tar', 'src'], ['tar', '-xf', 'a.tar', '-C', '.git'],
      ['tar', '-cf', '.cws/a.tar', 'src'], ['tar', 'cf', '.git/a.tar', 'src'], ['tar', '--to-command=calc', '-xf', 'a.tar'],
      ['curl', '-o', '.git/config', 'http://x'], ['curl', '-sSLo', '.cws/x', 'http://x'], ['curl', '--output=.cws/x', 'http://x'],
      ['curl', '--output-dir', '.git/hooks', '-O', 'http://x'], ['wget', '-O', '.git/config', 'http://x'], ['wget', '-P', '.git/hooks', 'http://x'],
      ['xcopy', 'a', '.git\\hooks', '/Y'], ['robocopy', 'a', '.cws', '/E'], ['robocopy', 'a', 'b', '-mir'], ['shred', '-u', '.cws/events.jsonl'],
      ['unlink', '.cws/events.jsonl'], ['trash', '.git'],
    ]), []);
  });

  it('blocks writes outside the project', () => {
    assert.deepEqual(blocked([
      ['cp', 'src/a.ts', '../../outside'], ['cp', '-t', '/tmp', 'src/a.ts'], ['dd', 'if=src/a.ts', 'of=../../outside/b'], ['dd', 'if=x', 'of=/dev/sda'],
      ['tee', '../../outside/x'], ['curl', '-o', '../../outside/x', 'http://x'], ['wget', '-O', '/tmp/x', 'http://x'],
      ['tar', '-cf', '../../a.tar', 'src'], ['tar', '-xf', 'a.tar', '--directory=..'], ['rsync', '-a', 'src/', 'host:/backup'],
      ['rsync', '-a', 'src/', '../../other'], ['ln', '-s', 'x', '../../link'], ['xcopy', 'a', '..\\..\\x'],
    ]), []);
  });

  it('refuses to overwrite a file that already exists, but allows new files and -n', () => {
    assert.deepEqual(blocked([['cp', 'x', 'src/a.ts'], ['cp', '-f', 'x', 'src/a.ts'], ['dd', 'if=x', 'of=src/a.ts'], ['tee', 'src/a.ts'],
      ['curl', '-o', 'src/a.ts', 'http://x'], ['wget', '-O', 'src/a.ts', 'http://x'], ['ln', '-sf', 'x', 'src/a.ts']]), []);
    assert.deepEqual(allowed([['cp', 'src/a.ts', 'src/b.ts'], ['cp', '-n', 'x', 'src/a.ts'], ['cp', 'x', 'src'], ['cp', '-r', 'src', 'copy'],
      ['tee', '-a', 'src/a.ts'], ['dd', 'if=x', 'of=src/new.bin'], ['curl', '-o', 'src/new.json', 'http://x'], ['curl', '-s', 'http://x'],
      ['wget', '-O', 'src/new.html', 'http://x'], ['ln', '-s', 'a.ts', 'src/link'], ['rsync', '-a', 'src/', 'backup/'], ['tar', '-cf', 'a.tar', 'src'],
      ['tar', 'cf', 'b.tar', 'src'], ['tar', '-tf', 'a.tar'], ['sed', 's/a/b/', 'src/a.ts'], ['sed', '-n', '1p', 'src/a.ts'],
      ['xcopy', 'a', 'b', '/E'], ['robocopy', 'a', 'b', '/E'], ['chmod', '644', 'src/a.ts']]), []);
  });
});

describe('guard: programs that run other programs', () => {
  it('blocks interpreters, launchers, build tools and package scripts', () => {
    assert.deepEqual(blocked([
      ['tsx', 'x.ts'], ['ts-node', 'x.ts'], ['node22', 'x.js'], ['node20.exe', 'x'], ['nodejs18', 'x'], ['python3.12', '-c', 'x'], ['java', '-jar', 'x'],
      ['dotnet', 'x.dll'], ['ssh', 'h', 'x'], ['awk', 'BEGIN{}'], ['gawk', 'x'], ['vim', 'x'], ['less', 'x'], ['man', 'x'], ['make'], ['gmake', 'clean'],
      ['msbuild', 'x'], ['just', 'x'], ['corepack', 'pnpm', 'dlx', 'x'], ['npx', 'x'], ['bunx', 'x'], ['bun', 'x'], ['expect', 'x'], ['gdb', 'x'],
      ['npm', 'run', 'x'], ['npm', 'test'], ['npm', 'start'], ['npm', 'exec', 'x'], ['npm', 'x', 'y'], ['npm', 'init', 'x'], ['npm', 'create', 'x'],
      ['npm', 'explore', 'x', '--', 'calc'], ['npm', '--prefix', 'x', 'run', 'y'], ['pnpm', 'dlx', 'x'], ['pnpm', 'run', 'x'], ['pnpm', 'create', 'x'],
      ['pnpm', 'build'], ['pnpm', '-r', 'exec', 'x'], ['yarn', 'build'], ['yarn', 'run', 'x'], ['yarn', 'dlx', 'x'], ['yarn', 'create', 'x'],
      ['cargo', 'run'], ['cargo', 'clean'], ['go', 'run', 'x.go'], ['go', 'generate'], ['gradle', 'clean'], ['mvn', 'clean'], ['cmake', '-P', 'x'],
      ['fd', '-x', 'rm'], ['fd', '--exec', 'rm'], ['fd', '-X', 'rm'], ['rg', '--pre', 'calc', 'x'], ['rg', '--pre=calc', 'x'],
      ['certutil', '-urlcache', '-f', 'http://x', 'a'], ['bitsadmin', '/transfer', 'x'], ['regsvr32', '/s', 'x'], ['forfiles', '/c', 'x'], ['wmic', 'x'],
      ['start', 'x'], ['reg', 'delete', 'HKCU\\x'], ['reg', 'add', 'x'], ['format', 'D:'], ['cipher', '/w:C:'], ['mkfs.ext4', '/dev/sda'],
      ['kubectl', 'delete', 'ns', 'x'], ['kubectl', '-n', 'x', 'apply', '-f', 'y'], ['docker', 'run', 'x'], ['docker', 'rm', 'x'], ['docker', 'system', 'prune'],
      ['docker', 'volume', 'rm', 'x'], ['chmod', '-R', '777', '.'], ['rm2', 'x'], ['mv_old', 'a', 'b'], ['/bin/rm-real', 'x'],
    ]), []);
  });

  it('only the subcommand of a package manager counts, never a package name', () => {
    assert.deepEqual(allowed([
      ['npm', 'ls', 'exec'], ['npm', 'view', 'x', 'version'], ['pnpm', 'add', 'dlx'], ['pnpm', 'install'], ['npm', 'ci'], ['yarn', 'install'], ['yarn'],
      ['pnpm', 'list'], ['pnpm', 'outdated'], ['npm', 'audit'], ['npm', '--version'], ['pnpm', '--filter', 'web', 'install'],
      ['kubectl', 'get', 'pods'], ['kubectl', '-n', 'x', 'get', 'pods'], ['docker', 'ps'], ['docker', 'image', 'ls'], ['docker', 'images'],
      ['reg', 'query', 'HKCU\\x'], ['certutil', '-hashfile', 'a', 'SHA256'], ['cargo', 'build'], ['cargo', 'test'], ['go', 'build', './...'], ['go', 'test', './...'],
      ['grm', '-rf', 'src/old'],
    ]), []);
  });

  it('treats unlink and trash as deletes limited to the project', () => {
    assert.deepEqual(blocked([['unlink', '../../outside/x'], ['trash', '../../outside/x'], ['trash-put', '.git']]), []);
    assert.equal(verdict(['unlink', 'src/new.txt']).ok, true);
  });

  it('refuses a PowerShell comma list as a delete target', () => {
    assert.deepEqual(blocked([
      ['remove-item', '-Path', 'a.txt,C:\\Windows'], ['Remove-Item', '-LiteralPath:a,b'], ['del', 'a,b'], ['ri', 'a.txt,.git'],
    ]), []);
  });
});
