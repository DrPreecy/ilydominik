// Red-team witnesses: ai-gemini (I2, I9, I16). RED = defect. The Gemini SDK is never called; a fake caller is injected.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runCli } from '../../../src/cli/app.ts';
import { EventLog } from '../../../src/store/event-log.ts';
import { checkAiUsage, hasGeminiConsent, readAiUsage, todayIsoDate, type GeminiCaller } from '../../../src/integrations/gemini.ts';
import { HUMAN, project, step } from '../../helpers.ts';
import { mkIO, tmp } from './harness.ts';

let dir: string;
beforeEach(async () => {
  dir = await tmp('gem');
  process.env.GEMINI_API_KEY = 'fake-key-for-tests';
});
afterEach(async () => {
  delete process.env.GEMINI_API_KEY;
  await fs.rm(dir, { recursive: true, force: true });
});

const caller = (reply: string | Error): GeminiCaller & { calls: number } => {
  const c = {
    calls: 0,
    generate: async () => {
      c.calls++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return c;
};
const decide = (s: ReturnType<typeof project>, title: string, selected: string) =>
  step(s, {
    type: 'DECISION_RECORDED',
    actor: HUMAN,
    payload: { decisionId: `d_${title.length}_${selected}`, title, options: ['yes', 'no'], selected, rationale: 'r' },
  });

async function setup(answers: string[] = []) {
  const io = mkIO(dir, true, answers);
  await runCli(['init', 'P'], io);
  io.out.length = 0;
  io.err.length = 0;
  io.asked.length = 0;
  return io;
}
async function runAi(reply: string | Error, answers: string[] = ['yes']) {
  const io = await setup(answers);
  const fake = caller(reply);
  const code = await runCli(['ai', 'explore'], io, { geminiCaller: fake });
  return { io, code, fake };
}
const readLog = async () => fs.readFile(path.join(dir, '.cws', 'events.jsonl'), 'utf8');
const writeUsage = async (content: string) => {
  await fs.mkdir(path.join(dir, '.cws'), { recursive: true });
  await fs.writeFile(path.join(dir, '.cws', 'ai-usage.json'), content);
};

describe('consent', () => {
  it('a later "no" decision revokes consent', () => {
    let s = decide(project(), 'Gemini privacy consent', 'yes');
    s = decide(s, 'Gemini privacy consent revoked', 'no');
    assert.equal(hasGeminiConsent(s), false);
  });
  it('consent is matched on exact title, not substring (an unrelated decision must not grant it)', () => {
    const s = decide(project(), 'Do not send anything to gemini; privacy review pending', 'yes');
    assert.equal(hasGeminiConsent(s), false);
  });
  it('consent is recorded only after the interactive challenge code is typed back', async () => {
    const { io } = await runAi(JSON.stringify({ notes: ['x'] }), ['yes']); // never types K7Q
    const log = await EventLog.open(dir);
    const consent = log.events.find((e) => e.type === 'DECISION_RECORDED');
    assert.equal(consent, undefined, `consent decision recorded with plain "yes"; prompts asked: ${JSON.stringify(io.asked)}`);
  });
  it("someone else's consent decision inside the log does not let a non-interactive run call Gemini", async () => {
    await setup();
    const log = await EventLog.open(dir);
    await log.append({
      type: 'DECISION_RECORDED',
      actor: HUMAN,
      payload: { decisionId: 'd_x', title: 'Gemini Free Tier Data Privacy Consent', options: ['yes', 'no'], selected: 'yes', rationale: 'someone else' },
    });
    const agent = mkIO(dir, false);
    const fake = caller(JSON.stringify({ notes: ['x'] }));
    await runCli(['ai', 'explore'], agent, { geminiCaller: fake });
    assert.equal(fake.calls, 0, 'prompt sent to Gemini on the strength of a consent this user never gave');
  });
});

describe('quota', () => {
  it('a call that fails at the API still counts', async () => {
    await runAi(new Error('503 upstream'));
    assert.equal((await readAiUsage(dir)).count, 1);
  });
  it('a call that returns invalid JSON still counts', async () => {
    await runAi('this is not json');
    assert.equal((await readAiUsage(dir)).count, 1);
  });
  it('a negative counter in the agent-editable file cannot grant unlimited calls', async () => {
    await writeUsage(JSON.stringify({ date: todayIsoDate(), count: -1_000_000 }));
    const r = await checkAiUsage(dir, 20);
    assert.ok(r.todayCount >= 0, `todayCount=${r.todayCount}`);
  });
  it('a corrupted counter fails closed, not open', async () => {
    await writeUsage('{garbage');
    const r = await checkAiUsage(dir, 20);
    assert.equal(r.ok, false);
  });
});

describe('output handling (I9, I2)', () => {
  it('Gemini output is redacted before it is stored in the log', async () => {
    const ghp = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const { code } = await runAi(
      JSON.stringify({ notes: [`leaked ${ghp}`], claims: [{ type: 'HYPOTHESIS', text: `key ${aws}` }] }),
    );
    assert.equal(code, 0);
    const raw = await readLog();
    assert.ok(!raw.includes(ghp), 'GitHub token stored verbatim');
    assert.ok(!raw.includes(aws), 'AWS key stored verbatim');
  });
  it('is all-or-nothing: a bad later item must not leave earlier notes committed', async () => {
    const reply = JSON.stringify({
      notes: ['n1', 'n2'],
      proposals: [{ kind: 'status', claimId: 'c_does_not_exist', status: 'SUPPORTED' }],
    });
    const { code } = await runAi(reply);
    const log = await EventLog.open(dir);
    const aiEvents = log.events.filter((e) => e.actor.kind === 'ai').length;
    assert.ok(code === 0 || aiEvents === 0, `exit ${code} but ${aiEvents} AI events were already committed (partial write)`);
  });
  it('model output is not echoed to the terminal with control characters', async () => {
    const { io } = await runAi(JSON.stringify({ summary: 'ok\u001b]0;pwned\u0007\u001b[2J', notes: [] }));
    assert.ok(!/\u001b/.test(io.out.join('\n')), 'ESC sequence reached stdout');
  });
});
