import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createHash } from 'node:crypto';
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

  it('session start records a brief; context shows it; the handoff asks whether done-when was reached', async () => {
    await initProject();
    const start = human();
    assert.equal(
      await cli(start, 'session', 'start', 'Build', 'login', '--done', 'I can sign in', '--not', 'visual design'),
      EXIT.OK,
    );
    assert.match(text(start), /done when: I can sign in/);
    const s = await state();
    assert.equal(s.sessions[0]!.goal, 'Build login');
    assert.equal(s.sessions[0]!.doneWhen, 'I can sign in');
    assert.equal(s.sessions[0]!.notTouching, 'visual design');
    const ctx = mkAgent();
    await cli(ctx, 'context', 'implement');
    assert.match(text(ctx), /I can sign in/);
    assert.match(text(ctx), /visual design/);
    await cli(human(), 'session', 'end');
    const handoff = await fs.readFile(path.join(dir, '.cws', 'sessions', `${s.sessions[0]!.id}.md`), 'utf8');
    assert.match(handoff, /## Brief/);
    assert.match(handoff, /Done when: I can sign in/);
    assert.match(handoff, /Not touching: visual design/);
    assert.match(handoff, /Done-when reached\?/);
  });

  it('session end rejects an unsafe legacy identifier before recording completion or writing outside the project', async () => {
    const root = path.join(dir, 'project');
    await fs.mkdir(root);
    const log = await EventLog.init(root, 'p');
    await log.append({ type: 'SESSION_STARTED', actor: { kind: 'human' }, payload: { sessionId: 'safe', goal: 'legacy' } });
    const file = path.join(root, '.cws', 'events.jsonl');
    const started = log.events.at(-1)!;
    const payload = { sessionId: '../../../audit-escape', goal: 'legacy' };
    const canonical = { v: started.v, seq: started.seq, id: started.id, at: started.at,
      type: started.type, actor: started.actor, payload, prevHash: started.prevHash };
    const unsafe = { ...started, payload, hash: createHash('sha256').update(started.prevHash + JSON.stringify(canonical)).digest('hex') };
    const raw = `${JSON.stringify(log.events[0])}\n${JSON.stringify(unsafe)}\n`;
    await fs.writeFile(file, raw);
    const io = human();
    io.cwd = root;
    assert.equal(await cli(io, 'session', 'end'), EXIT.ERROR);
    assert.match(errText(io), /session.*identifier/i);
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    await assert.rejects(fs.access(path.join(dir, 'audit-escape.md')), { code: 'ENOENT' });
    assert.doesNotMatch(text(io), /Session ended:/);
  });

  it('session handoff can be retried after an obstructed directory without another end event', async () => {
    await initProject();
    await cli(human(), 'session', 'start', 'Retry export');
    const sessions = path.join(dir, '.cws', 'sessions');
    await fs.writeFile(sessions, 'obstruction');
    const failed = human();
    assert.equal(await cli(failed, 'session', 'end', '--summary', 'persisted summary'), EXIT.ERROR);
    assert.doesNotMatch(text(failed), /Session ended:|Handoff written:/);
    assert.ok((await state()).activeSessionId, 'preflight failure must not record completion');
    await fs.unlink(sessions);
    const retry = human();
    assert.equal(await cli(retry, 'session', 'end', '--summary', 'persisted summary'), EXIT.OK);
    const log = await EventLog.open(dir);
    assert.equal(log.events.filter((event) => event.type === 'SESSION_ENDED').length, 1);
    assert.equal(log.state.activeSessionId, undefined);
    assert.match(await fs.readFile(path.join(sessions, `${log.state.sessions[0]!.id}.md`), 'utf8'), /persisted summary/);
    assert.match(text(retry), /Handoff written:/);
  });

  it('session handoff retries a failure after the end event using its recorded summary', async (t) => {
    await initProject();
    await cli(human(), 'session', 'start', 'Retry late export');
    const originalRename = fs.rename.bind(fs);
    t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]).endsWith('.md')) throw Object.assign(new Error('blocked export'), { code: 'EACCES' });
      return originalRename(...args);
    });
    const failed = human();
    assert.equal(await cli(failed, 'session', 'end', '--summary', 'recorded summary'), EXIT.ERROR);
    assert.equal((await state()).activeSessionId, undefined);
    assert.doesNotMatch(text(failed), /Session ended:|Handoff written:/);
    assert.deepEqual(await fs.readdir(path.join(dir, '.cws', 'sessions')), []);
    t.mock.restoreAll();
    const retry = human();
    assert.equal(await cli(retry, 'session', 'end'), EXIT.OK);
    const log = await EventLog.open(dir);
    assert.equal(log.events.filter((event) => event.type === 'SESSION_ENDED').length, 1);
    assert.match(await fs.readFile(path.join(dir, '.cws', 'sessions', `${log.state.sessions[0]!.id}.md`), 'utf8'), /recorded summary/);
  });

  it('session end refuses an external sessions junction before appending completion', async () => {
    const root = path.join(dir, 'project');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    const log = await EventLog.init(root, 'p');
    await log.append({ type: 'SESSION_STARTED', actor: { kind: 'human' }, payload: { sessionId: 'safe', goal: 'linked export' } });
    await fs.symlink(outside, path.join(root, '.cws', 'sessions'), 'junction');
    const io = human();
    io.cwd = root;
    assert.equal(await cli(io, 'session', 'end'), EXIT.ERROR);
    assert.equal((await EventLog.open(root)).state.activeSessionId, 'safe');
    assert.deepEqual(await fs.readdir(outside), []);
    assert.doesNotMatch(text(io), /Session ended:|Handoff written:/);
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
    assert.match(errText(io), /AI actors may not add FACT claims/);
    assert.doesNotMatch(errText(io), /AI_CLAIM_TYPE_FORBIDDEN/);
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
    assert.equal(await cli(human(['K7Q']), 'reject', p2!, '--note', 'wrong'), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'confirm', c!), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'mark', c!, 'falsified', '--evidence', 'tested it'), EXIT.OK);
    assert.equal(await cli(human(['K7Q']), 'retire', d!, '--reason', 'irrelevant'), EXIT.OK);
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
    assert.equal(await cli(human(['K7Q', 'a', 'r', 'because', 'k']), 'review'), EXIT.OK);
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

describe('cli: guided menu (`cws` with no arguments)', () => {
  it('prints help without asking anything when not at a terminal', async () => {
    const io = mkAgent();
    assert.equal(await cli(io), EXIT.OK);
    assert.match(text(io) + errText(io), /Usage: cws/);
  });

  it('offers to start a project when there is none, then quits on Enter', async () => {
    const io = human(['1', 'Garden Planner']);
    assert.equal(await cli(io), EXIT.OK);
    assert.equal((await state()).title, 'Garden Planner');
    assert.match(text(io), /No project here yet/);
  });

  it('shows where you are, and starts a session with a brief', async () => {
    await initProject();
    const io = human(['1', 'Build login', 'I can sign in', 'visual design']);
    assert.equal(await cli(io), EXIT.OK);
    assert.match(text(io), /Garden Planner/);
    assert.match(text(io), /Stage 1 of 9: Explore/);
    const session = (await state()).sessions[0]!;
    assert.equal(session.goal, 'Build login');
    assert.equal(session.doneWhen, 'I can sign in');
    assert.equal(session.notTouching, 'visual design');
  });

  it('writes down a thought, shows the next options and copies the chosen prompt', async () => {
    await initProject();
    const io = human(['2', 'clay soil everywhere', '3', '1']);
    assert.equal(await cli(io), EXIT.OK);
    assert.equal((await state()).notes[0]!.text, 'clay soil everywhere');
    assert.equal(io.copied.length, 1);
    assert.match(io.copied[0]!, /# Project context/);
  });

  it('says when nothing is waiting for review', async () => {
    await initProject();
    const io = human(['4']);
    assert.equal(await cli(io), EXIT.OK);
    assert.match(text(io), /Nothing is waiting for your review/);
  });

  it('moves to another stage with a reason and the typed code', async () => {
    await initProject();
    const io = human(['5', '2', 'notes are done', 'K7Q']);
    assert.equal(await cli(io), EXIT.OK);
    assert.equal((await state()).phase, 'UNDERSTANDING');
  });

  it('records typed text verbatim even when it looks like a command flag', async () => {
    await initProject();
    const io = human(['2', '--agent codex fix the soil', '1', '-fast prototype', '', '']);
    assert.equal(await cli(io), EXIT.OK);
    const s = await state();
    assert.equal(s.notes[0]!.text, '--agent codex fix the soil');
    assert.deepEqual(s.notes[0]!.actor, { kind: 'human' });
    assert.equal(s.sessions[0]!.goal, '-fast prototype');
  });

  it('only accepts an option number when copying a prompt', async () => {
    await initProject();
    const io = human(['3', '--help']);
    assert.equal(await cli(io), EXIT.OK);
    assert.equal(io.copied.length, 0);
    assert.match(errText(io), /Type an option number/);
  });

  it('a mistyped confirmation code changes nothing and is not mistaken for open risks', async () => {
    await initProject();
    // If the menu mistook the failed code for open risks, it would use the next two answers
    // as an override reason and a fresh code, and record a bogus PROCEED_UNDER_UNCERTAINTY decision.
    const io = human(['5', '2', 'notes are done', 'WRONG', 'some reason', 'K7Q']);
    assert.equal(await cli(io), EXIT.OK);
    const s = await state();
    assert.equal(s.phase, 'EXPLORATION');
    assert.equal(s.decisions.length, 0);
  });

  it('a risky move asks why first and records the override decision', async () => {
    await initProject();
    const io = human(['5', '7', 'season starts', 'will test with one plant', 'K7Q']);
    assert.equal(await cli(io), EXIT.OK);
    const s = await state();
    assert.equal(s.phase, 'IMPLEMENTATION');
    assert.equal(s.decisions[0]!.kind, 'PROCEED_UNDER_UNCERTAINTY');
    assert.match(text(io), /open risks/i);
  });

  it('a risky move is cancelled when no reason is given', async () => {
    await initProject();
    const io = human(['5', '7', 'season starts', '']);
    assert.equal(await cli(io), EXIT.OK);
    assert.equal((await state()).phase, 'EXPLORATION');
  });

  it('keeps the menu running when one choice fails', async () => {
    await initProject();
    const io = human(['5', '99', '9', '2', 'still here']);
    assert.equal(await cli(io), EXIT.OK);
    assert.match(text(io) + errText(io), /not a stage number/i);
    assert.match(text(io) + errText(io), /choose 1-5/i);
    assert.equal((await state()).notes[0]!.text, 'still here');
  });

  it('ends the active session with a summary and writes the handoff', async () => {
    await initProject();
    await cli(human(), 'session', 'start', 'Clarify', 'soil', '--done', 'pH known');
    const io = human(['1', 'learned soil type']);
    assert.equal(await cli(io), EXIT.OK);
    const s = await state();
    assert.equal(s.activeSessionId, undefined);
    assert.equal(s.sessions[0]!.summary, 'learned soil type');
    assert.match(text(io), /Handoff written/);
  });
});

describe('cli: safe-run guard', () => {
  it('checks ordinary commands without executing them', async () => {
    const io = mkAgent();
    assert.equal(await cli(io, 'safe-run', '--check', '--', 'npm', 'test'), EXIT.OK);
    assert.match(text(io), /allowed command/);
  });

  it('checks project-contained deletes without executing them', async () => {
    const io = mkAgent();
    assert.equal(await cli(io, 'safe-run', '--check', '--', 'rm', '-rf', 'dist'), EXIT.OK);
    assert.match(text(io), /allowed destructive command/);
    assert.match(text(io), /dist/);
  });

  it('blocks dangerous deletes outside the current project boundary', async () => {
    const io = mkAgent();
    const outside = path.dirname(dir);
    assert.equal(await cli(io, 'safe-run', '--check', '--', 'rm', '-rf', outside), EXIT.ERROR);
    assert.match(errText(io), /blocked:/);
  });
});

describe('cli: owned fix regressions', () => {
  for (const command of ['accept', 'review']) {
    it(`records a linked risk override with successful ${command} acceptance`, async () => {
      await initProject();
      await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'critical premise', '--risk', 'FATAL');
      await cli(mkAgent(JSON.stringify({ item: { kind: 'phase', to: 'IMPLEMENTATION', reason: 'deadline' } })), 'propose', '--agent', 'copilot', '--json', '-');
      const before = await state();
      const proposalId = before.proposals[0]!.id;
      const io = human(command === 'review' ? ['K7Q', 'a', 'test later'] : ['K7Q']);
      const args = command === 'review' ? ['review'] : ['accept', proposalId, '--accept-risk', 'test later'];
      assert.equal(await cli(io, ...args), EXIT.OK);
      const log = await EventLog.open(dir);
      assert.deepEqual(log.events.slice(-2).map((event) => event.type), ['DECISION_RECORDED', 'PROPOSAL_ACCEPTED']);
      assert.equal(log.state.phase, 'IMPLEMENTATION');
      assert.equal(log.state.proposals[0]!.status, 'ACCEPTED');
      assert.equal(log.state.decisions[0]!.kind, 'PROCEED_UNDER_UNCERTAINTY');
      assert.equal(log.state.decisions[0]!.rationale, 'test later');
      assert.deepEqual(log.state.decisions[0]!.links, [before.claims[0]!.id]);
      assert.equal(await cli(human(), 'verify'), EXIT.OK);
    });
  }

  it('keeps risk acknowledgement atomic with phase, acceptance and review on failure', async () => {
    await initProject();
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'critical premise', '--risk', 'FATAL');
    await cli(mkAgent(JSON.stringify({ item: { kind: 'phase', to: 'IMPLEMENTATION', reason: 'deadline' } })), 'propose', '--agent', 'copilot', '--json', '-');
    const before = await state();
    const original = EventLog.prototype.appendBatch;
    const stub = mock.method(EventLog.prototype, 'appendBatch', async function (this: EventLog, inputs: Parameters<typeof original>[0]) {
      if (inputs.some((input) => input.type === 'PHASE_CHANGED' || input.type === 'PROPOSAL_ACCEPTED')) throw new Error('injected transaction failure');
      return original.call(this, inputs);
    });
    try {
      for (const [args, answers] of [
        [['phase', 'IMPLEMENTATION', '--reason', 'deadline', '--accept-risk', 'test later'], ['K7Q']],
        [['accept', before.proposals[0]!.id, '--accept-risk', 'test later'], ['K7Q']],
        [['review'], ['K7Q', 'a', 'test later']],
      ] as [string[], string[]][]) {
        assert.equal(await cli(human(answers), ...args), EXIT.ERROR);
        assert.deepEqual(await state(), before, args.join(' '));
      }
    } finally {
      stub.mock.restore();
    }
  });

  it('shows the full claim and provenance before confirming in review', async () => {
    await initProject();
    await cli(human(), 'session', 'start', 'inspect claim');
    const fullText = 'visible prefix '.repeat(20) + '\nHIDDEN SUFFIX THAT MUST BE REVIEWED';
    await cli(mkAgent(), 'claim', 'add', '--agent', 'copilot', '--role', 'analyst', '--type', 'ASSUMPTION', '--text', fullText, '--risk', 'FATAL');
    const claim = (await state()).claims[0]!;
    await cli(mkAgent(), 'evidence', 'add', '--agent', 'copilot', '--claim', claim.id, '--text', 'FULL CLAIM EVIDENCE', '--source', 'REVIEW SOURCE');
    const io = human(['K7Q', 'c']);
    const ask = io.ask;
    io.ask = async (question) => {
      if (question.startsWith('[c]onfirm')) {
        assert.ok(text(io).includes(fullText));
        for (const value of ['copilot', 'analyst', 'FATAL', 'FULL CLAIM EVIDENCE', 'REVIEW SOURCE', claim.sessionId!, claim.at]) assert.ok(text(io).includes(value), value);
      }
      return ask(question);
    };
    assert.equal(await cli(io, 'review'), EXIT.OK);
    assert.equal((await state()).claims[0]!.confirmed, true);
  });

  it('sanitizes generic errors, thrown values and Commander output', async () => {
    await initProject();
    const unsafe = 'bad\u001b[2J\u0007\u009bmessage';
    for (const failure of [new Error(unsafe), unsafe]) {
      const io = mkAgent();
      io.readStdin = async () => { throw failure; };
      assert.equal(await cli(io, 'dump', '--agent', 'copilot', '-'), EXIT.ERROR);
      assert.doesNotMatch(errText(io), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
      assert.match(errText(io), /message/);
    }
    for (const args of [[unsafe], ['--' + unsafe], ['claim', unsafe]]) {
      const io = human();
      assert.equal(await cli(io, ...args), EXIT.ERROR);
      assert.doesNotMatch(text(io) + errText(io), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    }
  });

  it('prompt 2 corresponds to next --limit 2', async () => {
    await initProject();
    await cli(human(), 'claim', 'add', '--type', 'ASSUMPTION', '--text', 'critical premise', '--risk', 'FATAL');
    await cli(mkAgent(JSON.stringify({ item: { kind: 'claim', type: 'FACT', text: 'pending' } })), 'propose', '--agent', 'copilot', '--json', '-');
    const next = human();
    assert.equal(await cli(next, 'next', '--limit', '2'), EXIT.OK);
    assert.match(text(next), /2\. \[proof\]/);
    const prompt = human();
    assert.equal(await cli(prompt, 'prompt', '2'), EXIT.OK);
    assert.match(text(prompt), /Reality Tester/);
  });
});

describe('cli: review fixes', () => {
  it('an unknown command says so; with no arguments the menu still runs', async () => {
    const io = human();
    assert.equal(await cli(io, 'bogus'), EXIT.ERROR);
    assert.match(errText(io), /unknown command 'bogus'/);
  });

  it('--version prints the package version and exits 0', async () => {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const io = human();
    assert.equal(await cli(io, '--version'), EXIT.OK);
    assert.equal(text(io).trim(), pkg.version);
  });

  it('the menu records a project title that looks like a flag', async () => {
    const io = human(['1', '--agent x']);
    assert.equal(await cli(io), EXIT.OK);
    assert.equal((await state()).title, '--agent x');
  });

  it('end of input at the session summary cancels instead of ending the session', async () => {
    await initProject();
    await cli(human(), 'session', 'start', 'Clarify');
    // The fake io answers '' once the answers run out, as Ctrl+D does.
    assert.equal(await cli(human(['1'])), EXIT.OK);
    assert.notEqual((await state()).activeSessionId, undefined);
    assert.equal(await cli(human(['1', '', 'y'])), EXIT.OK);
    assert.equal((await state()).activeSessionId, undefined);
  });

  it('review can mark an AI hypothesis falsified or supported, with the typed code', async () => {
    await initProject();
    await cli(mkAgent(), 'claim', 'add', '--agent', 'copilot', '--type', 'HYPOTHESIS', '--text', 'H1');
    await cli(mkAgent(), 'claim', 'add', '--agent', 'copilot', '--type', 'HYPOTHESIS', '--text', 'H2');
    await cli(mkAgent(), 'claim', 'add', '--agent', 'copilot', '--type', 'HYPOTHESIS', '--text', 'H3');
    const io = human(['K7Q', 'f', 'not reproducible', 'K7Q', 's', 'saw it fail', 'K7Q', 's', '', 'WRONG']);
    assert.equal(await cli(io, 'review'), EXIT.OK);
    const s = await state();
    const status = (t: string) => s.claims.find((c) => c.text === t)?.status;
    assert.equal(status('H1'), 'FALSIFIED');
    assert.equal(status('H2'), 'SUPPORTED');
    assert.equal(status('H3'), 'OPEN');
    assert.equal(s.claims.find((c) => c.text === 'H1')?.evidence[0]?.text, 'not reproducible');
    assert.match(text(io), /1 falsified, 1 supported/);
    // A human verdict counts as reviewed: the inbox no longer lists it.
    const inbox = human();
    await cli(inbox, 'inbox');
    assert.doesNotMatch(text(inbox), /H1|H2/);
  });
});

void agent;
