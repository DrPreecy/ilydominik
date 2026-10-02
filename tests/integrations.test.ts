import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runCli } from '../src/cli/app.ts';
import { doctor, hostKind, probeAll, probesFor, reportLines, resolveSandboxMode, PROBES } from '../src/cli/commands/doctor.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { defaultConfig, loadIntegrations, toolOverride } from '../src/integrations/config.ts';
import { rulesArgs } from '../src/integrations/ocr.ts';
import {
  findExecutable,
  firstLine,
  isBatchShim,
  resolveToolCommand,
  runTool,
  runToolJson,
  toolVersion,
  ToolError,
  type RunResult,
} from '../src/integrations/exec.ts';
import { isWslUncPath, windowsToWslPath, wslArgs } from '../src/integrations/wsl.ts';

const NODE = process.execPath;
const isWindows = process.platform === 'win32';

let base: string;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-integrations-'));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

function fakeResult(ok: boolean): RunResult {
  return {
    command: 'x',
    args: [],
    ok,
    code: ok ? 0 : 1,
    signal: null,
    timedOut: false,
    truncated: false,
    durationMs: 1,
    stdout: '',
    stderr: '',
  };
}

describe('findExecutable', () => {
  it('finds a program on PATH and reports nothing for an unknown name', async () => {
    const bin = path.join(base, 'bin');
    await fs.mkdir(bin);
    const name = isWindows ? 'cws-probe-test.exe' : 'cws-probe-test';
    await fs.writeFile(path.join(bin, name), '');
    const env = { PATH: bin, PATHEXT: '.exe;.cmd' };
    assert.equal(findExecutable('cws-probe-test', { env, platform: process.platform }), path.join(bin, name));
    assert.equal(findExecutable('cws-not-here', { env, platform: process.platform }), null);
    assert.equal(findExecutable('', { env, platform: process.platform }), null);
  });

  it('prefers a real executable over a batch shim on Windows', async () => {
    const bin = path.join(base, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'tool.CMD'), '');
    await fs.writeFile(path.join(bin, 'tool.EXE'), '');
    const found = findExecutable('tool', { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32' });
    assert.equal(path.basename(found ?? '').toLowerCase(), 'tool.exe');
  });

  it('falls back to the shim when no executable has that name, and accepts an explicit path', async () => {
    const bin = path.join(base, 'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'only.CMD'), '');
    const shim = findExecutable('only', { env: { PATH: bin, PATHEXT: '.CMD' }, platform: 'win32' });
    assert.equal(path.basename(shim ?? '').toLowerCase(), 'only.cmd');
    assert.equal(findExecutable(path.join(bin, 'only.CMD')), path.join(bin, 'only.CMD'));
    assert.equal(findExecutable(path.join(bin, 'gone')), null);
  });

  it('recognizes batch shims', () => {
    assert.equal(isBatchShim('C:/npm/ocr.cmd'), true);
    assert.equal(isBatchShim('C:/npm/ocr.BAT'), true);
    assert.equal(isBatchShim('/usr/bin/ocr'), false);
  });
});

describe('runTool', () => {
  it('runs a command and collects its output', async () => {
    const result = await runTool(NODE, ['-e', "process.stdout.write('hi')"]);
    assert.equal(result.ok, true);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'hi');
    assert.equal(result.timedOut, false);
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await runTool(NODE, ['-e', 'process.exit(3)']);
    assert.equal(result.ok, false);
    assert.equal(result.code, 3);
  });

  it('kills a command that runs past its timeout', async () => {
    const result = await runTool(NODE, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 400 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
  });

  it('caps output and marks it truncated', async () => {
    const result = await runTool(NODE, ['-e', "process.stdout.write('x'.repeat(5000))"], { maxOutputBytes: 128 });
    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 128);
  });

  it('reports a missing program instead of throwing', async () => {
    const result = await runTool('cws-absent-program-xyz', []);
    assert.equal(result.ok, false);
    assert.ok(result.stderr.length > 0);
  });

  it('refuses an empty command and arguments with line breaks', async () => {
    assert.equal((await runTool('', [])).ok, false);
    const result = await runTool(NODE, ['-e', 'a\nb']);
    assert.equal(result.ok, false);
    assert.match(result.stderr, /NUL or line break/);
  });

  it('resolves instead of rejecting when spawn throws synchronously', async () => {
    const result = await runTool(NODE, ['-e', ''], { env: { BAD: 'a\0b' } });
    assert.equal(result.ok, false);
    assert.ok(result.stderr.length > 0);
  });

  it('kills the whole process tree on timeout', async () => {
    const script = "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); console.log(c.pid); setTimeout(() => {}, 30000);";
    const result = await runTool(NODE, ['-e', script], { timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    const grandchild = Number(result.stdout.trim());
    assert.ok(grandchild > 0, result.stdout);
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let tries = 0; tries < 40 && alive(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(), false);
  });

  it('passes shell-looking arguments through untouched', async () => {
    const result = await runTool(NODE, ['-e', "process.stdout.write(process.argv[1])", 'a; rm -rf /']);
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'a; rm -rf /');
  });
});

describe('tool commands', () => {
  it('runs a script override through node and finds plain programs on PATH', async () => {
    const script = path.join(base, 'stub.mjs');
    await fs.writeFile(script, '');
    assert.deepEqual(resolveToolCommand(script), { file: NODE, prefix: [script] });
    assert.equal(resolveToolCommand(path.join(base, 'missing.mjs')), null);
    assert.deepEqual(resolveToolCommand(NODE), { file: NODE, prefix: [] });
  });

  it('puts ocr flags before the -- that ends options, so a file name cannot become a flag', () => {
    assert.deepEqual(rulesArgs(['--repo=/tmp/evil', 'a.go'], { from: 'main' }), [
      'delegate', 'rule', '--format', 'json', '--from', 'main', '--', '--repo=/tmp/evil', 'a.go',
    ]);
  });
});

describe('toolVersion and json helpers', () => {
  it('reads a version from a program and gives up quietly on a failure', async () => {
    const version = await toolVersion(NODE, ['--version']);
    assert.notEqual(version, null);
    assert.equal(await toolVersion('cws-absent-program-xyz'), null);
  });

  it('keeps only the first meaningful line', () => {
    assert.equal(firstLine('\n\u001b[1m  v1.2.3  \u001b[0m\nsecond'), 'v1.2.3');
    assert.equal(firstLine('   '), '');
  });

  it('parses JSON output and rejects anything else', async () => {
    const schema = z.object({ a: z.number() });
    const ok = await runToolJson(NODE, ['-e', "process.stdout.write('{\"a\":1}')"], schema);
    assert.deepEqual(ok, { a: 1 });

    await assert.rejects(
      runToolJson(NODE, ['-e', "process.stdout.write('nope')"], schema),
      (error: unknown) => error instanceof ToolError && /did not print JSON/.test(error.message),
    );
    await assert.rejects(
      runToolJson(NODE, ['-e', "process.stdout.write('{\"a\":\"x\"}')"], schema),
      (error: unknown) => error instanceof ToolError && /unexpected JSON/.test(error.message),
    );
    await assert.rejects(
      runToolJson(NODE, ['-e', 'process.exit(2)'], schema),
      (error: unknown) => error instanceof ToolError && /exit 2/.test(error.message),
    );
  });
});

describe('wsl path bridge', () => {
  it('maps Windows paths into a WSL mount', () => {
    assert.equal(windowsToWslPath('E:\\Dev\\ILYDOMINIK'), '/mnt/e/Dev/ILYDOMINIK');
    assert.equal(windowsToWslPath('C:/temp/x'), '/mnt/c/temp/x');
    assert.equal(windowsToWslPath('D:\\'), '/mnt/d');
    assert.equal(windowsToWslPath('D:'), null);
    assert.equal(windowsToWslPath('relative\\path'), null);
    assert.equal(windowsToWslPath(''), null);
  });

  it('maps WSL UNC paths and detects them', () => {
    assert.equal(windowsToWslPath('\\\\wsl$\\Ubuntu\\home\\me\\proj'), '/home/me/proj');
    assert.equal(windowsToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me'), '/home/me');
    assert.equal(isWslUncPath('\\\\wsl$\\Ubuntu\\home'), true);
    assert.equal(isWslUncPath('C:\\temp'), false);
  });

  it('builds wsl.exe argument lists', () => {
    assert.deepEqual(wslArgs({}, 'ocr', ['review']), ['-e', 'ocr', 'review']);
    assert.deepEqual(wslArgs({ distro: 'Ubuntu', cwd: '/mnt/e/p' }, 'ocr'), ['-d', 'Ubuntu', '--cd', '/mnt/e/p', '-e', 'ocr']);
  });
});

describe('integrations config', () => {
  it('falls back to defaults when the file is missing', async () => {
    const loaded = await loadIntegrations(base);
    assert.deepEqual(loaded.config, defaultConfig());
    assert.equal(loaded.problem, undefined);
  });

  it('reads a valid file but never takes tool paths from the repository', async () => {
    await fs.mkdir(path.join(base, '.cws'));
    await fs.writeFile(
      path.join(base, '.cws', 'integrations.json'),
      JSON.stringify({ version: 1, sandbox: { mode: 'wsl', wslDistro: 'Ubuntu' }, tools: { ocr: '/tmp/evil', openshell: '/tmp/evil' } }),
    );
    const loaded = await loadIntegrations(base);
    assert.equal(loaded.config.sandbox.mode, 'wsl');
    assert.equal(loaded.config.sandbox.wslDistro, 'Ubuntu');
    assert.equal('tools' in loaded.config, false);
    assert.equal(loaded.problem, undefined);
    assert.match(loaded.ignored ?? '', /tools\.ocr, tools\.openshell/);
    assert.match(loaded.ignored ?? '', /CWS_TOOL_OCR/);
  });

  it('takes tool overrides from environment variables only', () => {
    assert.equal(toolOverride('ocr', { CWS_TOOL_OCR: '/opt/ocr' }), '/opt/ocr');
    assert.equal(toolOverride('openshell', { CWS_TOOL_OPENSHELL: '  ' }), undefined);
    assert.equal(toolOverride('prover', {}), undefined);
  });

  it('reports a problem and uses defaults for broken files', async () => {
    await fs.mkdir(path.join(base, '.cws'));
    const file = path.join(base, '.cws', 'integrations.json');
    await fs.writeFile(file, '{ not json');
    assert.match((await loadIntegrations(base)).problem ?? '', /not valid JSON/);
    await fs.writeFile(file, JSON.stringify({ version: 1, sandbox: { mode: 'teleport' } }));
    assert.match((await loadIntegrations(base)).problem ?? '', /sandbox\.mode/);
  });
});

function quietIO(cwd: string): CliIO {
  return {
    cwd,
    isInteractive: false,
    stdout: () => undefined,
    stderr: () => undefined,
    ask: async () => '',
    readStdin: async () => '',
    challenge: () => 'CODE',
    copy: async () => false,
  };
}

describe('doctor', () => {
  it('detects the kind of host it runs on', () => {
    assert.equal(hostKind({ CODESPACES: 'true' }, 'linux'), 'codespace');
    assert.equal(hostKind({ WSL_DISTRO_NAME: 'Ubuntu' }, 'linux'), 'wsl');
    assert.equal(hostKind({}, 'win32'), 'windows');
    assert.equal(hostKind({}, 'darwin'), 'macos');
    assert.equal(hostKind({}, 'linux'), 'linux');
    assert.equal(hostKind({}, 'freebsd'), 'unknown');
  });

  it('resolves the sandbox mode from what is available', () => {
    const config = defaultConfig();
    const none = { docker: false, podman: false, wsl: false, openshell: false, gateway: false };
    assert.equal(resolveSandboxMode(config, 'codespace', { ...none, docker: true, openshell: true }), 'local');
    assert.equal(resolveSandboxMode(config, 'windows', { ...none, wsl: true, openshell: true }), 'wsl');
    assert.equal(resolveSandboxMode(config, 'linux', { ...none, gateway: true }), 'remote');
    assert.equal(resolveSandboxMode(config, 'linux', none), 'off');
    assert.equal(resolveSandboxMode({ ...config, sandbox: { mode: 'off' } }, 'codespace', { ...none, docker: true }), 'off');
  });

  it('lets an environment variable override a tool path', () => {
    const probes = probesFor({ CWS_TOOL_OCR: '/opt/ocr' });
    assert.equal(probes.find((p) => p.name === 'ocr')?.command, '/opt/ocr');
    assert.equal(probes.find((p) => p.name === 'openshell-prover')?.command, 'openshell-prover');
    assert.equal(probesFor({ CWS_TOOL_PROVER: '/opt/prover' }).find((p) => p.name === 'openshell-prover')?.command, '/opt/prover');
  });

  it('never runs a tool path planted in the repository config', async () => {
    assert.equal(await runCli(['init', 'Planted'], { ...quietIO(base), isInteractive: true }), EXIT.OK);
    const planted = path.join(base, 'planted-ocr.exe');
    await fs.writeFile(planted, '');
    await fs.writeFile(path.join(base, '.cws', 'integrations.json'), JSON.stringify({ version: 1, tools: { ocr: planted } }));
    const out: string[] = [];
    assert.equal(await runCli(['doctor'], { ...quietIO(base), stdout: (text) => void out.push(text) }), EXIT.OK);
    assert.doesNotMatch(out.join(''), /planted-ocr/);
    assert.match(out.join(''), /Ignored: .*tools\.ocr.*CWS_TOOL_OCR/);
  });

  it('probes tools and notes whether a service answers', async () => {
    const probes = [
      { name: 'node', command: 'node', purpose: 'runs cws', required: true },
      { name: 'docker', command: 'docker', purpose: 'sandbox', hint: 'install docker', daemonArgs: ['info'] },
      { name: 'ocr', command: 'ocr', purpose: 'review', hint: 'install ocr' },
    ];
    const results = await probeAll(
      {
        find: (command) => (command === 'ocr' ? null : `/bin/${command}`),
        version: async () => 'v1.0.0',
        run: async () => fakeResult(true),
      },
      probes,
    );
    assert.equal(results[0]?.file, '/bin/node');
    assert.equal(results[1]?.detail, 'service reachable');
    assert.equal(results[2]?.file, null);

    const lines = reportLines(results, { host: 'codespace', configFile: '/p/.cws/integrations.json', mode: 'local', project: true });
    const text = lines.join('\n');
    assert.match(text, /CWS doctor {2}\(host: codespace\)/);
    assert.match(text, /Sandbox mode: {4}local/);
    assert.match(text, /ok {2} node {2,}v1\.0\.0 {2}\/bin\/node/);
    assert.match(text, /ok {2} docker {2,}v1\.0\.0 {2}\[service reachable\]/);
    assert.match(text, /not found — review \(install ocr\)/);
  });

  it('runs through the CLI and always exits cleanly', async () => {
    const io: CliIO = {
      cwd: base,
      isInteractive: false,
      stdout: () => undefined,
      stderr: () => undefined,
      ask: async () => '',
      readStdin: async () => '',
      challenge: () => 'CODE',
      copy: async () => false,
    };
    const out: string[] = [];
    const code = await runCli(['doctor'], { ...io, stdout: (text) => void out.push(text) });
    assert.equal(code, EXIT.OK);
    assert.match(out.join(''), /CWS doctor/);
    assert.match(out.join(''), /Required/);
    assert.equal(PROBES.length > 5, true);
  });

  it('reports a missing project instead of failing', async () => {
    const lines: string[] = [];
    const env = {
      io: {
        cwd: base,
        isInteractive: false,
        stdout: (text: string) => void lines.push(text),
        stderr: () => undefined,
        ask: async () => '',
        readStdin: async () => '',
        challenge: () => 'CODE',
        copy: async () => false,
      } satisfies CliIO,
    };
    const code = await doctor(env);
    assert.equal(code, EXIT.OK);
    assert.match(lines.join(''), /no project here/);
  });
});
