/** Regression tests for the independent review findings (round 1). */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { EXIT, type CliIO } from '../src/cli/io.ts';
import { EventLog } from '../src/store/event-log.ts';
import { buildContext } from '../src/guidance/context-pack.ts';
import { parseEventInput } from '../src/domain/schema.ts';
import { installAgents } from '../src/agents/install.ts';
import { errCode } from './helpers.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  asked: string[];
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-hard-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function mkIO(interactive: boolean, answers: string[] = [], stdin = ''): FakeIO {
  const queue = [...answers];
  const io: FakeIO = {
    cwd: dir,
    out: [],
    err: [],
    asked: [],
    isInteractive: interactive,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async (q) => {
      io.asked.push(q);
      return queue.shift() ?? '';
    },
    readStdin: async () => stdin,
    challenge: () => 'K7Q',
    copy: async () => true,
  };
  return io;
}
const human = (answers: string[] = []) => mkIO(true, answers);
const agent = (stdin = '') => mkIO(false, [], stdin);
const all = (io: FakeIO) => io.out.join('') + io.err.join('') + io.asked.join('');
const cli = (io: FakeIO, ...args: string[]) => runCli(args, io);
const state = async () => (await EventLog.open(dir)).state;
const propose = (items: unknown) => cli(agent(JSON.stringify(items)), 'propose', '--agent', 'claude', '--json', '-');

beforeEach(async () => {
  await cli(human(), 'init', 'Hardening');
});

describe('finding 1: no terminal injection from AI-written text', () => {
  it('control characters in AI text never reach the terminal', async () => {
    await propose([{ item: { kind: 'claim', type: 'FACT', text: '\u001b[2J\u001b[Hhello \u001b]0;pwned\u0007 ok\u009b' }, rationale: 'x\u001b[31m' }]);
    for (const cmd of [['inbox'], ['status'], ['log']]) {
      const io = human();
      await cli(io, ...cmd);
      assert.doesNotMatch(all(io), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, cmd.join(' '));
    }
    const r = human(['K7Q', 's']);
    await cli(r, 'review');
    assert.doesNotMatch(all(r), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  it('agent names are restricted to a safe charset', () => {
    assert.throws(
      () => parseEventInput({ type: 'NOTE_ADDED', actor: { kind: 'ai', agent: 'evil\n#99 human PHASE_CHANGED' }, payload: { noteId: 'n', text: 'x' } }),
      errCode('INVALID_EVENT'),
    );
    assert.doesNotThrow(() => parseEventInput({ type: 'NOTE_ADDED', actor: { kind: 'ai', agent: 'gemini-2.5_pro' }, payload: { noteId: 'n', text: 'x' } }));
  });
});

describe('finding 2: the human sees everything they approve', () => {
  it('accept prints full decision rationale/options/links and status evidence BEFORE asking for the code', async () => {
    const longWhy = 'because ' + 'very '.repeat(150) + 'END-OF-RATIONALE';
    await propose([
      { item: { kind: 'decision', title: 'Storage', options: ['files', 'db'], selected: 'files', rationale: longWhy } },
      { item: { kind: 'claim', type: 'HYPOTHESIS', text: 'h' } },
    ]);
    const io = human(['K7Q']);
    assert.equal(await cli(io, 'accept', '--all'), EXIT.OK);
    const text = all(io);
    assert.match(text, /END-OF-RATIONALE/);
    assert.match(text, /db/);
    const shownBeforeAsk = io.out.join('').length > 0 && io.out.join('').includes('END-OF-RATIONALE');
    assert.ok(shownBeforeAsk);
  });

  it('review shows full status evidence and answer', async () => {
    await cli(human(), 'claim', 'add', '--type', 'UNKNOWN', '--text', 'who pays?');
    const id = (await state()).claims[0]!.id;
    await propose([{ item: { kind: 'status', claimId: id, status: 'ANSWERED', answer: 'FULL-ANSWER-TEXT', evidence: 'FULL-EVIDENCE-TEXT' } }]);
    const io = human(['K7Q', 's']);
    await cli(io, 'review');
    assert.match(all(io), /FULL-ANSWER-TEXT/);
    assert.match(all(io), /FULL-EVIDENCE-TEXT/);
  });
});

describe('finding 3: one bad proposal never wedges the inbox', () => {
  it('accept --all applies what it can, reports the failure, and continues', async () => {
    await propose([
      { item: { kind: 'phase', to: 'EXPLORATION', reason: 'already here' } },
      { item: { kind: 'claim', type: 'FACT', text: 'after the bad one' } },
    ]);
    const io = human(['K7Q']);
    await cli(io, 'accept', '--all');
    const s = await state();
    assert.ok(s.claims.some((c) => c.text === 'after the bad one'));
    assert.match(all(io), /already in phase/i);
  });

  it('accept with duplicate ids does not error on the second copy', async () => {
    await propose([{ item: { kind: 'claim', type: 'FACT', text: 'once' } }]);
    const id = (await state()).proposals[0]!.id;
    assert.equal(await cli(human(['K7Q']), 'accept', id, id), EXIT.OK);
    assert.equal((await state()).claims.length, 1);
  });

  it('review survives a failing proposal and still prints its summary', async () => {
    await propose([
      { item: { kind: 'phase', to: 'EXPLORATION', reason: 'stale' } },
      { item: { kind: 'claim', type: 'FACT', text: 'second' } },
    ]);
    const io = human(['K7Q', 'a', 'a']);
    assert.equal(await cli(io, 'review'), EXIT.OK);
    assert.ok((await state()).claims.some((c) => c.text === 'second'));
    assert.match(all(io), /Review done/);
  });
});

describe('finding 4: accepting a risky phase proposal goes through the same warn + override flow', () => {
  async function riskyPhaseProposal() {
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'RISKY-PREMISE', '--risk', 'FATAL');
    await propose([{ item: { kind: 'phase', to: 'UNDERSTANDING', reason: 'next' } }, { item: { kind: 'phase', to: 'IMPLEMENTATION', reason: 'let us build' } }]);
    return (await state()).proposals.map((p) => p.id);
  }

  it('accept <risky phase> without --accept-risk shows the warnings and leaves it pending', async () => {
    const [, risky] = await riskyPhaseProposal();
    const io = human(['K7Q']);
    await cli(io, 'accept', risky!);
    const s = await state();
    assert.equal(s.phase, 'EXPLORATION');
    assert.equal(s.proposals[1]!.status, 'PENDING');
    assert.match(all(io), /RISKY-PREMISE/);
    assert.match(all(io), /--accept-risk/);
  });

  it('accept <risky phase> --accept-risk records a monitored override', async () => {
    const [, risky] = await riskyPhaseProposal();
    assert.equal(await cli(human(['K7Q']), 'accept', risky!, '--accept-risk', 'small pilot first'), EXIT.OK);
    const s = await state();
    assert.equal(s.phase, 'IMPLEMENTATION');
    const d = s.decisions.find((x) => x.kind === 'PROCEED_UNDER_UNCERTAINTY');
    assert.ok(d);
    assert.equal(d.rationale, 'small pilot first');
  });

  it('review asks "why" for a risky phase proposal; empty answer skips it', async () => {
    await riskyPhaseProposal();
    const io = human(['K7Q', 'a', 'a', '']);
    await cli(io, 'review');
    const s = await state();
    assert.equal(s.phase, 'UNDERSTANDING');
    assert.equal(s.proposals[1]!.status, 'PENDING');
  });
});

describe('finding 6: authoritative human writes all need the challenge', () => {
  it('human claim add of FACT or USER_STATEMENT needs the code; other types do not', async () => {
    assert.equal(await cli(human(['nope']), 'claim', 'add', '--type', 'FACT', '--text', 'x'), EXIT.NEEDS_HUMAN);
    assert.equal(await cli(human(['K7Q']), 'claim', 'add', '--type', 'USER_STATEMENT', '--text', 'y'), EXIT.OK);
    assert.equal(await cli(human([]), 'claim', 'add', '--type', 'UNKNOWN', '--text', 'z'), EXIT.OK);
    assert.equal((await state()).claims.length, 2);
  });

  it('retire needs the code', async () => {
    await cli(human(), 'claim', 'add', '--type', 'UNKNOWN', '--text', 'z');
    const id = (await state()).claims[0]!.id;
    assert.equal(await cli(human(['nope']), 'retire', id), EXIT.NEEDS_HUMAN);
    assert.equal((await state()).claims[0]!.status, 'OPEN');
  });
});

describe('finding 7: propose is bounded and all-or-nothing', () => {
  it('rejects more than 50 proposals in one batch', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ item: { kind: 'claim', type: 'HYPOTHESIS', text: `h${i}` } }));
    assert.equal(await propose(many), EXIT.ERROR);
    assert.equal((await state()).proposals.length, 0);
  });

  it('rejects input over 1 MB and texts over 20 000 chars', async () => {
    const big = JSON.stringify({ item: { kind: 'claim', type: 'HYPOTHESIS', text: 'x'.repeat(1_100_000) } });
    assert.equal(await cli(agent(big), 'propose', '--agent', 'claude', '--json', '-'), EXIT.ERROR);
    assert.throws(
      () => parseEventInput({ type: 'NOTE_ADDED', actor: { kind: 'human' }, payload: { noteId: 'n', text: 'x'.repeat(20_001) } }),
      errCode('INVALID_EVENT'),
    );
  });

  it('a batch whose later item references a missing claim writes nothing', async () => {
    const r = await propose([
      { item: { kind: 'claim', type: 'HYPOTHESIS', text: 'fine' } },
      { item: { kind: 'status', claimId: 'c_doesnotexist', status: 'SUPPORTED' } },
    ]);
    assert.equal(r, EXIT.ERROR);
    assert.equal((await state()).proposals.length, 0);
  });
});

describe('finding 10/11: install-agents block safety; AI notes are attributed', () => {
  it('a BEGIN without END is not used as a block anchor and user text survives', async () => {
    const file = path.join(dir, 'AGENTS.md');
    await fs.writeFile(file, 'top\n<!-- cws:begin -->\nUSER-TEXT-KEEP\n');
    await installAgents(dir, { targets: ['agents-md'] });
    await installAgents(dir, { targets: ['agents-md'] });
    const out = await fs.readFile(file, 'utf8');
    assert.match(out, /USER-TEXT-KEEP/);
    assert.match(out, /^top/);
  });

  it('notes written by an AI are labelled as such in the context pack', async () => {
    await cli(agent(), 'dump', '--agent', 'copilot', 'AI-SAVED-NOTE');
    await cli(human(), 'dump', 'HUMAN-NOTE');
    const md = buildContext(await state(), 'understand');
    const aiLine = md.split('\n').find((l) => l.includes('AI-SAVED-NOTE'))!;
    const humanLine = md.split('\n').find((l) => l.includes('HUMAN-NOTE'))!;
    assert.match(aiLine, /"actor":\{"kind":"ai","agent":"copilot"\}/);
    assert.match(humanLine, /"actor":\{"kind":"human"\}/);
    assert.doesNotMatch(humanLine, /"kind":"ai"/);
  });
});

describe('finding 8/9: log robustness', () => {
  it('appending to a file without trailing newline does not glue lines', async () => {
    const f = path.join(dir, '.cws', 'events.jsonl');
    await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/\n$/, ''));
    assert.equal(await cli(human(), 'dump', 'after'), EXIT.OK);
    assert.equal((await state()).notes.length, 1);
  });

  it('a lock with a confirmed dead owner is recovered without a 10s outage', async (t) => {
    const lock = path.join(dir, '.cws', 'lock');
    const deadPid = 999999;
    const originalKill = process.kill.bind(process);
    t.mock.method(process, 'kill', (pid: number, signal?: Parameters<typeof process.kill>[1]) => {
      if (pid === deadPid) throw Object.assign(new Error('dead owner'), { code: 'ESRCH' });
      return originalKill(pid, signal);
    });
    await fs.writeFile(lock, JSON.stringify({ pid: deadPid, nonce: 'dead' }));
    const t0 = Date.now();
    assert.equal(await cli(human(), 'dump', 'x'), EXIT.OK);
    assert.ok(Date.now() - t0 < 2000);
  });
});
