import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { EventLog } from '../src/store/event-log.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
  copied: string[];
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-cli-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function human(answers: string[] = [], stdin = ''): FakeIO {
  const io: FakeIO = {
    cwd: dir,
    out: [],
    err: [],
    answers: [...answers],
    copied: [],
    isInteractive: true,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async () => io.answers.shift() ?? '',
    readStdin: async () => stdin,
    challenge: () => 'K7Q',
    copy: async (t) => {
      io.copied.push(t);
      return true;
    },
  };
  return io;
}

function agent(stdin = ''): FakeIO {
  return { ...human([], stdin), isInteractive: false, out: [], err: [], answers: [], copied: [] } as FakeIO;
}

/** fix the object-spread above: rebind closures to the agent object */
function mkAgent(stdin = ''): FakeIO {
  const io = human([], stdin);
  io.isInteractive = false;
  return io;
}

const text = (io: FakeIO) => io.out.join('\n');
const errText = (io: FakeIO) => io.err.join('\n');
const cli = (io: FakeIO, ...args: string[]) => runCli(args, io);
const state = async () => (await EventLog.open(dir)).state;

async function initProject() {
  assert.equal(await cli(human(), 'init', 'Garden', 'Planner'), EXIT.OK);
}

describe('cli: init / dump / session / status', () => {
  it('init creates a project and prints the next step', async () => {
    const io = human();
    assert.equal(await cli(io, 'init', 'Garden', 'Planner'), EXIT.OK);
    assert.equal((await state()).title, 'Garden Planner');
    assert.match(text(io), /cws dump/);
  });

  it('commands outside a project fail with a helpful message', async () => {
    const io = human();
    assert.equal(await cli(io, 'status'), EXIT.ERROR);
    assert.match(errText(io), /cws init/);
  });

  it('dump stores raw text verbatim; "-" or no text reads stdin', async () => {
    await initProject();
    await cli(human(), 'dump', 'I', 'want', 'tomatoes');
    await cli(human([], 'line one\nline two\n'), 'dump', '-');
    const notes = (await state()).notes;
    assert.equal(notes[0]!.text, 'I want tomatoes');
    assert.equal(notes[1]!.text, 'line one\nline two\n');
  });

  it('agent dump is attributed to the agent', async () => {
    await initProject();
    assert.equal(await cli(mkAgent(), 'dump', '--agent', 'copilot', 'user said X'), EXIT.OK);
    assert.deepEqual((await state()).notes[0]!.actor, { kind: 'ai', agent: 'copilot' });
  });

  it('session start/end; end prints what changed and writes a handoff file', async () => {
    await initProject();
    await cli(human(), 'session', 'start', 'Clarify', 'soil');
    await cli(human(), 'dump', 'clay soil');
    await cli(mkAgent(), 'claim', 'add', '--agent', 'claude', '--type', 'UNKNOWN', '--text', 'pH value?', '--risk', 'HIGH');
    const io = human();
    assert.equal(await cli(io, 'session', 'end', '--summary', 'learned soil type'), EXIT.OK);
    const s = await state();
    assert.equal(s.activeSessionId, undefined);
    assert.match(text(io), /clay soil/);
    assert.match(text(io), /pH value\?/);
    const handoff = await fs.readFile(path.join(dir, '.cws', 'sessions', `${s.sessions[0]!.id}.md`), 'utf8');
    assert.match(handoff, /Clarify soil/);
    assert.match(handoff, /pH value\?/);
    assert.match(handoff, /Next/i);
  });

  it('status shows title, phase, warnings and the top next step', async () => {
    await initProject();
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'Tomatoes grow in shade', '--risk', 'FATAL');
    const io = human();
    assert.equal(await cli(io, 'status'), EXIT.OK);
    const t = text(io);
    assert.match(t, /Garden Planner/);
    assert.match(t, /EXPLORATION/);
    assert.match(t, /UNTESTED_RISK|untested/i);
    assert.match(t, /cws prompt/);
  });
});

describe('cli: the human/agent boundary', () => {
  it('human-only commands refuse to run non-interactively and point agents to propose', async () => {
    await initProject();
    for (const args of [
      ['decide', '--title', 't', '--selected', 's', '--rationale', 'r'],
      ['phase', 'UNDERSTANDING', '--reason', 'r'],
      ['session', 'start', 'g'],
      ['dump', 'pretending to be the user'],
    ]) {
      const io = mkAgent();
      assert.equal(await cli(io, ...args), EXIT.NEEDS_HUMAN, args.join(' '));
      assert.match(errText(io), /cws propose --agent/);
    }
    assert.equal((await state()).decisions.length, 0);
  });

  it('decision-level commands require typing the challenge code', async () => {
    await initProject();
    const wrong = human(['nope']);
    assert.equal(await cli(wrong, 'decide', '--title', 'Bed', '--selected', 'raised', '--rationale', 'clay'), EXIT.NEEDS_HUMAN);
    assert.equal((await state()).decisions.length, 0);
    const right = human(['K7Q']);
    assert.equal(await cli(right, 'decide', '--title', 'Bed', '--options', 'raised,ground', '--selected', 'raised', '--rationale', 'clay soil'), EXIT.OK);
    const d = (await state()).decisions[0]!;
    assert.deepEqual(d.rejected, ['ground']);
  });

  it('agent claim add cannot create FACT or USER_STATEMENT', async () => {
    await initProject();
    const io = mkAgent();
    assert.equal(await cli(io, 'claim', 'add', '--agent', 'gemini', '--type', 'FACT', '--text', 'x'), EXIT.ERROR);
    assert.match(errText(io), /AI_CLAIM_TYPE_FORBIDDEN/);
  });

  it('propose accepts a single item, an array, or {proposals:[...]} from a file or stdin', async () => {
    await initProject();
    const file = path.join(dir, 'p.json');
    await fs.writeFile(file, JSON.stringify({ item: { kind: 'claim', type: 'FACT', text: 'Tomatoes need 6h sun' }, rationale: 'RHS guide' }));
    assert.equal(await cli(mkAgent(), 'propose', '--agent', 'claude', '--json', file), EXIT.OK);
    const arr = JSON.stringify([
      { item: { kind: 'claim', type: 'USER_STATEMENT', text: 'I have a north garden' } },
      { item: { kind: 'phase', to: 'UNDERSTANDING', reason: 'dump complete' } },
    ]);
    assert.equal(await cli(mkAgent(arr), 'propose', '--agent', 'claude', '--json', '-'), EXIT.OK);
    const wrapped = JSON.stringify({ proposals: [{ item: { kind: 'claim', type: 'HYPOTHESIS', text: 'h' } }] });
    assert.equal(await cli(mkAgent(wrapped), 'propose', '--agent', 'claude', '--json', '-'), EXIT.OK);
    assert.equal((await state()).proposals.length, 4);
  });

  it('propose validates everything before writing anything', async () => {
    await initProject();
    const bad = JSON.stringify([{ item: { kind: 'claim', type: 'FACT', text: 'ok' } }, { item: { kind: 'claim', type: 'GOSPEL', text: 'x' } }]);
    const io = mkAgent(bad);
    assert.equal(await cli(io, 'propose', '--agent', 'claude', '--json', '-'), EXIT.ERROR);
    assert.equal((await state()).proposals.length, 0);
    assert.equal(await cli(mkAgent('not json'), 'propose', '--agent', 'claude', '--json', '-'), EXIT.ERROR);
  });

  it('propose without --agent is refused (proposals are how agents speak)', async () => {
    await initProject();
    const io = human([], JSON.stringify({ item: { kind: 'claim', type: 'FACT', text: 'x' } }));
    assert.equal(await cli(io, 'propose', '--json', '-'), EXIT.ERROR);
    assert.match(errText(io), /--agent/);
  });

  it('inbox lists pending proposals and unconfirmed AI claims', async () => {
    await initProject();
    await cli(mkAgent(JSON.stringify({ item: { kind: 'claim', type: 'FACT', text: 'PROPOSED FACT' } })), 'propose', '--agent', 'claude', '--json', '-');
    await cli(mkAgent(), 'claim', 'add', '--agent', 'claude', '--type', 'INTERPRETATION', '--text', 'AI READING');
    const io = human();
    await cli(io, 'inbox');
    assert.match(text(io), /PROPOSED FACT/);
    assert.match(text(io), /AI READING/);
  });

  it('accept / reject / confirm / retire / mark work for the human', async () => {
    await initProject();
    await cli(mkAgent(JSON.stringify([{ item: { kind: 'claim', type: 'FACT', text: 'A' } }, { item: { kind: 'claim', type: 'FACT', text: 'B' } }])), 'propose', '--agent', 'claude', '--json', '-');
    await cli(mkAgent(), 'claim', 'add', '--agent', 'claude', '--type', 'ASSUMPTION', '--text', 'C', '--risk', 'HIGH');
    await cli(mkAgent(), 'claim', 'add', '--agent', 'claude', '--type', 'INTERPRETATION', '--text', 'D');
    let s = await state();
    const [p1, p2] = s.proposals.map((p) => p.id);
    const [c, d] = s.claims.map((x) => x.id);
    assert.equal(await cli(human(['K7Q']), 'accept', p1!), EXIT.OK);
    assert.equal(await cli(human(), 'reject', p2!, '--note', 'wrong'), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'confirm', c!), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'mark', c!, 'falsified', '--evidence', 'tested it'), EXIT.OK);
    assert.equal(await cli(human(), 'retire', d!, '--reason', 'irrelevant'), EXIT.OK);
    s = await state();
    assert.deepEqual(s.proposals.map((p) => p.status), ['ACCEPTED', 'REJECTED']);
    assert.equal(s.claims.find((x) => x.text === 'A')?.type, 'FACT');
    assert.equal(s.claims.find((x) => x.id === c)?.status, 'FALSIFIED');
    assert.equal(s.claims.find((x) => x.id === d)?.status, 'RETIRED');
  });

  it('accept --all accepts every pending proposal with one challenge', async () => {
    await initProject();
    await cli(mkAgent(JSON.stringify([{ item: { kind: 'claim', type: 'FACT', text: 'A' } }, { item: { kind: 'claim', type: 'HYPOTHESIS', text: 'B' } }])), 'propose', '--agent', 'claude', '--json', '-');
    assert.equal(await cli(human(['K7Q']), 'accept', '--all'), EXIT.OK);
    assert.equal((await state()).proposals.every((p) => p.status === 'ACCEPTED'), true);
  });

  it('review walks pending proposals interactively (a/r/s) after one challenge', async () => {
    await initProject();
    await cli(mkAgent(JSON.stringify([{ item: { kind: 'claim', type: 'FACT', text: 'A' } }, { item: { kind: 'claim', type: 'FACT', text: 'B' } }, { item: { kind: 'claim', type: 'FACT', text: 'C' } }])), 'propose', '--agent', 'claude', '--json', '-');
    assert.equal(await cli(human(['K7Q', 'a', 'r', 'because', 's']), 'review'), EXIT.OK);
    assert.deepEqual((await state()).proposals.map((p) => p.status), ['ACCEPTED', 'REJECTED', 'PENDING']);
  });
});

describe('cli: phases — warn, then record the override (§24)', () => {
  it('a risky forward move stops with warnings and asks for --accept-risk; nothing is written', async () => {
    await initProject();
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'Shade is fine', '--risk', 'FATAL');
    const io = human(['K7Q']);
    assert.equal(await cli(io, 'phase', 'implementation', '--reason', 'eager'), EXIT.NEEDS_HUMAN);
    assert.match(text(io) + errText(io), /--accept-risk/);
    assert.match(text(io) + errText(io), /Shade is fine/);
    assert.equal((await state()).phase, 'EXPLORATION');
  });

  it('with --accept-risk the human proceeds and a PROCEED_UNDER_UNCERTAINTY decision links the risks', async () => {
    await initProject();
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'Shade is fine', '--risk', 'FATAL');
    assert.equal(await cli(human(['K7Q']), 'phase', 'IMPLEMENTATION', '--reason', 'season starts', '--accept-risk', 'will test with one plant'), EXIT.OK);
    const s = await state();
    assert.equal(s.phase, 'IMPLEMENTATION');
    const d = s.decisions[0]!;
    assert.equal(d.kind, 'PROCEED_UNDER_UNCERTAINTY');
    assert.equal(d.rationale, 'will test with one plant');
    assert.deepEqual(d.links, [s.claims[0]!.id]);
  });

  it('moving backward needs no override and reports possibly affected items', async () => {
    await initProject();
    await cli(human(['K7Q']), 'phase', 'understanding', '--reason', 'r');
    await cli(human(['K7Q']), 'phase', 'synthesis', '--reason', 'r');
    await cli(human(['K7Q']), 'decide', '--title', 'Raised beds', '--selected', 'yes', '--rationale', 'clay');
    const io = human(['K7Q']);
    assert.equal(await cli(io, 'phase', 'exploration', '--reason', 'new idea'), EXIT.OK);
    assert.match(text(io), /Raised beds/);
  });
});

describe('cli: next / prompt / context / log / verify', () => {
  it('next lists numbered options; prompt N prints the full rendered prompt and can copy it', async () => {
    await initProject();
    await cli(human(), 'dump', 'idea about herbs');
    const n = human();
    assert.equal(await cli(n, 'next'), EXIT.OK);
    assert.match(text(n), /1\./);
    const p = human();
    assert.equal(await cli(p, 'prompt', '1', '--copy'), EXIT.OK);
    assert.match(text(p), /## How to record your results/);
    assert.equal(p.copied.length, 1);
  });

  it('context <purpose> works non-interactively for agents, with --focus', async () => {
    await initProject();
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'Basil likes sun', '--risk', 'HIGH');
    const id = (await state()).claims[0]!.id;
    const io = mkAgent();
    assert.equal(await cli(io, 'context', 'proof', '--focus', id), EXIT.OK);
    assert.match(text(io), /## Focus[\s\S]*Basil likes sun/);
    assert.equal(await cli(mkAgent(), 'context', 'nonsense'), EXIT.ERROR);
  });

  it('log prints events in human-readable form', async () => {
    await initProject();
    await cli(human(), 'dump', 'first thought');
    const io = human();
    await cli(io, 'log');
    assert.match(text(io), /NOTE_ADDED/);
    assert.match(text(io), /first thought/);
  });

  it('verify reports tampering with exit code 3, and status warns about it', async () => {
    await initProject();
    await cli(human(), 'dump', 'original words');
    await cli(human(), 'dump', 'later');
    const f = path.join(dir, '.cws', 'events.jsonl');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('original words', 'forged words'));
    const v = human();
    assert.equal(await cli(v, 'verify'), EXIT.INTEGRITY);
    const st = human();
    await cli(st, 'status');
    assert.match(text(st) + errText(st), /integrity|tamper/i);
  });

  it('unknown command → error with usage', async () => {
    const io = human();
    assert.equal(await cli(io, 'frobnicate'), EXIT.ERROR);
  });
});

void agent;
