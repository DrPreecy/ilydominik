import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAgents, AGENT_TARGETS } from '../src/agents/install.ts';
import { PURPOSES } from '../src/domain/types.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cws-agents-')));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFile(path.join(dir, rel), 'utf8');
const exists = (rel: string) =>
  fs.access(path.join(dir, rel)).then(
    () => true,
    () => false,
  );

describe('install-agents (one source → Copilot, Claude Code, Gemini/Antigravity)', () => {
  it('exposes the four targets', () => {
    assert.deepEqual([...AGENT_TARGETS].sort(), ['agents-md', 'claude', 'copilot', 'gemini']);
  });

  it('writes AGENTS.md with the protocol and pointer files for Claude and Gemini', async () => {
    await installAgents(dir);
    const agents = await read('AGENTS.md');
    assert.match(agents, /cws status/);
    assert.match(agents, /cws context/);
    assert.match(agents, /--agent/);
    assert.match(agents, /cws safe-run --check/);
    assert.match(agents, /never/i);
    assert.match(agents, /run the agent-side `cws` commands yourself/i);
    assert.match(agents, /never ask the person to remember commands/i);
    assert.match(agents, /type `cws`/);
    assert.match(agents, /brain[\s\S]*worker/i);
    assert.match(await read('CLAUDE.md'), /@AGENTS\.md/);
    assert.match(await read('GEMINI.md'), /AGENTS\.md/);
  });

  it('writes one thin wrapper per purpose for each tool', async () => {
    await installAgents(dir);
    for (const p of PURPOSES) {
      const copilot = await read(`.github/prompts/cws-${p}.prompt.md`);
      assert.match(copilot, /^---\n[\s\S]*description:/);
      assert.match(copilot, /agent: agent/);
      assert.ok(copilot.includes(`cws context ${p}`), p);
      const claude = await read(`.claude/commands/cws-${p}.md`);
      assert.ok(claude.includes(`cws context ${p}`));
      assert.match(claude, /\$ARGUMENTS/);
      const gemini = await read(`.agent/workflows/cws-${p}.md`);
      assert.ok(gemini.includes(`cws context ${p}`));
      for (const f of [copilot, claude, gemini]) {
        assert.match(f, /cws-generated/);
        assert.ok(f.length < 12000, 'Antigravity caps workflow files at 12k chars');
      }
    }
  });

  it('wrappers are thin: the real instructions live in prompts/ and come via `cws context`', async () => {
    await installAgents(dir);
    const w = await read('.claude/commands/cws-proof.md');
    assert.ok(w.length < 1500);
  });

  it('preserves existing user content in AGENTS.md / CLAUDE.md and is idempotent', async () => {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# My rules\nUse tabs.\n');
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'Be terse.\n');
    await installAgents(dir);
    await installAgents(dir);
    const agents = await read('AGENTS.md');
    assert.ok(agents.startsWith('# My rules\nUse tabs.\n'));
    assert.equal(agents.split('<!-- cws:begin -->').length - 1, 1);
    assert.equal(agents.split('<!-- cws:end -->').length - 1, 1);
    assert.ok((await read('CLAUDE.md')).includes('Be terse.'));
  });

  it('never overwrites a same-named wrapper the user wrote by hand', async () => {
    await fs.mkdir(path.join(dir, '.claude', 'commands'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'commands', 'cws-plan.md'), 'my own plan command');
    const result = await installAgents(dir);
    assert.equal(await read('.claude/commands/cws-plan.md'), 'my own plan command');
    assert.ok(result.skipped.some((s) => s.includes('cws-plan.md')));
  });

  it('targets can be limited', async () => {
    const result = await installAgents(dir, { targets: ['copilot'] });
    assert.equal(await exists('.claude/commands/cws-plan.md'), false);
    assert.equal(await exists('.github/prompts/cws-plan.prompt.md'), true);
    assert.ok(result.written.length > 0);
  });

  it('rejects a linked AGENTS.md before reading or overwriting it', async (t) => {
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'external rules');
    const originalLstat = fs.lstat.bind(fs);
    t.mock.method(fs, 'lstat', async (target: Parameters<typeof fs.lstat>[0]) => {
      const stat = await originalLstat(target);
      if (String(target) === file) t.mock.method(stat, 'isSymbolicLink', () => true);
      return stat;
    });
    await assert.rejects(installAgents(dir, { targets: ['agents-md'] }), /symbolic link|symlink/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'external rules');
  });

  it('rejects an external junction in target ancestry without writing external wrappers', async () => {
    const root = path.join(dir, 'project');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, '.github'), 'junction');
    await assert.rejects(installAgents(root, { targets: ['copilot'] }), /symbolic link|symlink|outside/i);
    assert.deepEqual(await fs.readdir(outside), []);
  });

  it('rejects a destination whose real path is outside the canonical project root', async (t) => {
    const root = path.join(dir, 'project');
    const outside = path.join(dir, 'external.md');
    await fs.mkdir(root);
    const file = path.join(root, 'AGENTS.md');
    await fs.writeFile(file, 'local rules');
    await fs.writeFile(outside, 'external rules');
    const originalRealpath = fs.realpath.bind(fs);
    t.mock.method(fs, 'realpath', async (target: Parameters<typeof fs.realpath>[0]) => {
      if (String(target) === file) return outside;
      return originalRealpath(target);
    });
    await assert.rejects(installAgents(root, { targets: ['agents-md'] }), /outside the project/i);
    assert.equal(await fs.readFile(file, 'utf8'), 'local rules');
    assert.equal(await fs.readFile(outside, 'utf8'), 'external rules');
  });

  it('rejects an internal junction too rather than following linked target ancestry', async () => {
    const destination = path.join(dir, 'alternate');
    await fs.mkdir(destination);
    await fs.symlink(destination, path.join(dir, '.claude'), 'junction');
    await assert.rejects(installAgents(dir, { targets: ['claude'] }), /symbolic link|symlink/i);
    assert.deepEqual(await fs.readdir(destination), []);
  });
});
