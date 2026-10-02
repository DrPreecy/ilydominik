import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installAgents, AGENT_TARGETS } from '../src/agents/install.ts';
import { PURPOSES } from '../src/domain/types.ts';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-agents-'));
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
    assert.match(agents, /never/i);
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
});
