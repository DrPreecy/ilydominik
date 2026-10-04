/**
 * Every human gate must have a test that fails when the gate is deleted (tribunal T-5..T-20).
 * Two angles per command: a non-interactive caller is refused (exit 2, nothing written), and a human who
 * types back a wrong, empty or partial confirmation code is refused (exit 2, nothing written).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventLog } from '../src/store/event-log.ts';
import { EXIT } from '../src/cli/io.ts';
import { all, human, localSandboxConfig, runHuman, stubOpenshell, tmpDir, tmpProject, type FakeIO } from './redteam/silent/harness.ts';

const WRONG_ANSWERS = ['', '   ', 'K7', 'K', 'K7QQ', 'XK7Q', 'no'];

function nonInteractive(cwd: string, stdin = ''): FakeIO {
  const io = human(cwd, [], stdin);
  io.isInteractive = false;
  return io;
}

interface Fixture { dir: string; claimId: string; proposalId: string }

/** A project with an AI claim, a pending claim proposal, and a running session. */
async function fixture(): Promise<Fixture> {
  const dir = await tmpProject();
  assert.equal(await runHuman(nonInteractive(dir), ['claim', 'add', '--agent', 'bot', '--type', 'HYPOTHESIS', '--text', 'ai claim']), 0);
  const body = JSON.stringify([{ item: { kind: 'claim', type: 'HYPOTHESIS', text: 'proposed claim' } }]);
  assert.equal(await runHuman(nonInteractive(dir, body), ['propose', '--agent', 'bot', '--json', '-']), 0);
  assert.equal(await runHuman(human(dir), ['session', 'start', 'goal']), 0);
  const state = (await EventLog.open(dir)).state;
  return { dir, claimId: state.claims[0]!.id, proposalId: state.proposals[0]!.id };
}

const count = async (dir: string): Promise<number> => (await EventLog.open(dir)).events.length;

interface Gated {
  name: string;
  args: (f: Fixture) => string[];
  /** needs the typed code (decision-level) */
  confirms: boolean;
  /** answers of a human who gets everything right */
  right?: string[];
}

const GATED: Gated[] = [
  { name: 'claim add (human)', args: () => ['claim', 'add', '--type', 'FACT', '--text', 'f'], confirms: true },
  { name: 'evidence add (human)', args: (f) => ['evidence', 'add', '--claim', f.claimId, '--text', 'e'], confirms: false },
  { name: 'confirm', args: (f) => ['confirm', f.claimId], confirms: true },
  { name: 'retire', args: (f) => ['retire', f.claimId], confirms: true },
  { name: 'mark', args: (f) => ['mark', f.claimId, 'SUPPORTED'], confirms: true },
  { name: 'decide', args: () => ['decide', '--title', 't', '--selected', 'a', '--rationale', 'r', '--options', 'a,b'], confirms: true },
  { name: 'phase', args: () => ['phase', 'UNDERSTANDING', '--reason', 'r'], confirms: true },
  { name: 'accept', args: (f) => ['accept', f.proposalId], confirms: true },
  { name: 'reject', args: (f) => ['reject', f.proposalId], confirms: true },
  { name: 'review', args: () => ['review'], confirms: true, right: ['k7q', 'a', 'q'] },
  { name: 'session end', args: () => ['session', 'end'], confirms: false },
];

describe('human gates: a non-interactive caller is refused and nothing is written', () => {
  for (const g of GATED) {
    it(g.name, async () => {
      const f = await fixture();
      const before = await count(f.dir);
      const io = nonInteractive(f.dir);
      const code = await runHuman(io, g.args(f));
      assert.equal(code, EXIT.NEEDS_HUMAN, all(io));
      assert.equal(await count(f.dir), before, 'the log changed although the caller was not a human');
    });
  }

  it('init', async () => {
    const dir = await tmpDir();
    const io = nonInteractive(dir);
    assert.equal(await runHuman(io, ['init', 'Idea']), EXIT.NEEDS_HUMAN, all(io));
    await assert.rejects(fs.stat(path.join(dir, '.cws')), 'init created .cws for a non-human');
  });

  it('claim add with --agent is the agent path and still works', async () => {
    const f = await fixture();
    const io = nonInteractive(f.dir);
    assert.equal(await runHuman(io, ['claim', 'add', '--agent', 'bot', '--type', 'ASSUMPTION', '--text', 'a']), 0, all(io));
  });

  it('evidence add with --agent is the agent path and still works', async () => {
    const f = await fixture();
    const io = nonInteractive(f.dir);
    assert.equal(await runHuman(io, ['evidence', 'add', '--agent', 'bot', '--claim', f.claimId, '--text', 'e']), 0, all(io));
  });
});

describe('human gates: a wrong, empty or partial confirmation code writes nothing', () => {
  for (const g of GATED.filter((x) => x.confirms)) {
    for (const wrong of WRONG_ANSWERS) {
      it(`${g.name} answered ${JSON.stringify(wrong)}`, async () => {
        const f = await fixture();
        const before = await count(f.dir);
        const io = human(f.dir, [wrong, wrong, wrong, wrong]);
        const code = await runHuman(io, g.args(f));
        assert.equal(code, EXIT.NEEDS_HUMAN, all(io));
        assert.equal(await count(f.dir), before, 'the log changed without the right code');
      });
    }

    it(`${g.name} proceeds with the right code (lower case is fine)`, async () => {
      const f = await fixture();
      const before = await count(f.dir);
      const io = human(f.dir, g.right ?? ['k7q', 'k7q', 'k7q']);
      const code = await runHuman(io, g.args(f));
      assert.equal(code, 0, all(io));
      assert.ok(await count(f.dir) > before, 'nothing written although the right code was typed');
    });
  }
});

describe('human gates: sandbox', () => {
  async function sandboxProject(): Promise<{ dir: string; stub: Awaited<ReturnType<typeof stubOpenshell>> }> {
    const dir = await tmpProject();
    await localSandboxConfig(dir);
    return { dir, stub: await stubOpenshell(dir) };
  }

  async function withStub<T>(script: string, fn: () => Promise<T>): Promise<T> {
    process.env.CWS_TOOL_OPENSHELL = script;
    try {
      return await fn();
    } finally {
      delete process.env.CWS_TOOL_OPENSHELL;
    }
  }

  const argsFor = {
    'up --provider': ['sandbox', 'up', '--provider', 'github'],
    'rules --approve': ['sandbox', 'rules', '--approve', 'chunk-a'],
    'rules --reject': ['sandbox', 'rules', '--reject', 'chunk-a'],
  } as const;

  for (const name of Object.keys(argsFor) as (keyof typeof argsFor)[]) {
    it(`sandbox ${name}: non-interactive is refused before openshell creates or changes anything`, async () => {
      const { dir, stub } = await sandboxProject();
      const io = nonInteractive(dir);
      const code = await withStub(stub.script, () => runHuman(io, [...argsFor[name]]));
      assert.equal(code, EXIT.NEEDS_HUMAN, all(io));
      const joined = (await stub.calls()).join('\n');
      assert.ok(!/approve|reject|create/.test(joined), `openshell was asked to change something: ${joined}`);
    });

    for (const wrong of ['', 'K7', 'K7QQ']) {
      it(`sandbox ${name}: answer ${JSON.stringify(wrong)} changes nothing`, async () => {
        const { dir, stub } = await sandboxProject();
        const before = await count(dir);
        const io = human(dir, [wrong]);
        const code = await withStub(stub.script, () => runHuman(io, [...argsFor[name]]));
        assert.equal(code, EXIT.NEEDS_HUMAN, all(io));
        const joined = (await stub.calls()).join('\n');
        assert.ok(!/approve|reject|create/.test(joined), joined);
        assert.equal(await count(dir), before);
      });
    }
  }

  it('sandbox policy --rule: non-interactive is refused and writes no rules', async () => {
    const { dir } = await sandboxProject();
    const io = nonInteractive(dir);
    assert.equal(await runHuman(io, ['sandbox', 'policy', '--rule', 'example.com:443']), EXIT.NEEDS_HUMAN, all(io));
    await assert.rejects(fs.stat(path.join(dir, '.cws', 'sandbox', 'rules.json')));
  });
});
