import assert from 'node:assert/strict';
import { beforeEach, afterEach, describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli/app.ts';
import { type CliIO } from '../src/cli/io.ts';
import { DomainError } from '../src/domain/types.ts';
import { reduce } from '../src/domain/reducer.ts';
import { EventLog } from '../src/store/event-log.ts';
import {
  checkAiUsage,
  geminiResponseSchema,
  hasGeminiConsent,
  incrementAiUsage,
  type GeminiCaller,
} from '../src/integrations/gemini.ts';
import { fakeSecret, stamp } from './helpers.ts';

interface FakeIO extends CliIO {
  out: string[];
  err: string[];
  answers: string[];
  copied: string[];
}

let dir: string;
let originalEnvKey: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cws-gemini-test-'));
  originalEnvKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

afterEach(async () => {
  if (originalEnvKey !== undefined) {
    process.env.GEMINI_API_KEY = originalEnvKey;
  } else {
    delete process.env.GEMINI_API_KEY;
  }
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
  const io: FakeIO = {
    cwd: dir,
    out: [],
    err: [],
    answers: [],
    copied: [],
    isInteractive: false,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async () => '',
    readStdin: async () => stdin,
    challenge: () => 'K7Q',
    copy: async (t) => {
      io.copied.push(t);
      return true;
    },
  };
  return io;
}

async function initProject(io: FakeIO, title = 'Test Project'): Promise<void> {
  await runCli(['init', title], io);
  io.out.length = 0;
  io.err.length = 0;
}

describe('cws ai integration', () => {
  it('cws ai --dry-run concept works offline without API key or consent', async () => {
    const io = human();
    await initProject(io);

    const code = await runCli(['ai', '--dry-run', 'concept'], io);
    assert.equal(code, 0);
    const output = io.out.join('\n');
    assert.match(output, /DRY RUN/i);
    assert.match(output, /Estimated tokens:/i);
    assert.match(output, /Concept/i);

    // No events appended
    const log = await EventLog.open(dir);
    assert.equal(log.events.length, 1); // only PROJECT_CREATED
  });

  it('fails clearly when GEMINI_API_KEY is missing and not dry-run', async () => {
    const io = human();
    await initProject(io);

    const code = await runCli(['ai', 'explore'], io);
    assert.notEqual(code, 0);
    assert.match(io.err.join('\n'), /GEMINI_API_KEY/i);
  });

  it('requires one-time privacy consent on interactive terminal', async () => {
    process.env.GEMINI_API_KEY = 'test-key-12345';
    // User answers "no" to consent
    const ioNo = human(['no']);
    await initProject(ioNo);

    const codeNo = await runCli(['ai', 'explore'], ioNo);
    assert.notEqual(codeNo, 0);
    assert.match(ioNo.out.join('\n'), /consent/i);
    assert.match(ioNo.err.join('\n'), /consent not granted/i);

    // Consent was not recorded
    let log = await EventLog.open(dir);
    assert.equal(hasGeminiConsent(log.state), false);

    // User answers "yes" to consent with mock caller
    const mockCaller: GeminiCaller = {
      generate: async () =>
        JSON.stringify({
          summary: 'Exploration results',
          notes: ['Interesting observation'],
          claims: [{ type: 'HYPOTHESIS', text: 'Feasible idea', risk: 'LOW' }],
          proposals: [
            {
              kind: 'decision',
              title: 'Architecture choice',
              options: ['Option A', 'Option B'],
              selected: 'Option A',
              rationale: 'Simpler implementation',
            },
          ],
        }),
    };
    const ioYes = human(['yes']);
    ioYes.cwd = dir;
    const codeYes = await runCli(['ai', 'explore'], ioYes, { geminiCaller: mockCaller });
    assert.equal(codeYes, 0);

    // Consent was recorded as a DECISION_RECORDED
    log = await EventLog.open(dir);
    assert.equal(hasGeminiConsent(log.state), true);

    // Verify AI actor events were recorded
    const aiEvents = log.events.filter((e) => e.actor.kind === 'ai');
    assert.equal(aiEvents.length, 3); // 1 NOTE_ADDED, 1 CLAIM_ADDED, 1 PROPOSAL_SUBMITTED
    const firstAi = aiEvents[0];
    assert.ok(firstAi);
    assert.equal((firstAi.actor as { kind: 'ai'; agent: string }).agent, 'gemini');
  });

  it('refuses outside an interactive terminal if consent does not exist', async () => {
    process.env.GEMINI_API_KEY = 'test-key-12345';
    const ioHuman = human();
    await initProject(ioHuman);

    const io = agent();
    io.cwd = dir;
    const code = await runCli(['ai', 'explore'], io);
    assert.notEqual(code, 0);
    assert.match(io.err.join('\n'), /consent/i);
  });

  it('tracks daily call limit and blocks when exceeded', async () => {
    await initProject(human());

    const usage0 = await checkAiUsage(dir, 2);
    assert.equal(usage0.ok, true);
    assert.equal(usage0.todayCount, 0);

    await incrementAiUsage(dir);
    await incrementAiUsage(dir);

    const usage2 = await checkAiUsage(dir, 2);
    assert.equal(usage2.ok, false);
    assert.equal(usage2.todayCount, 2);
  });

  it('validates Gemini response schema and rejects direct authoritative actions', () => {
    // Valid response
    const valid = geminiResponseSchema.safeParse({
      summary: 'Analysis complete',
      notes: ['Discovered something interesting'],
      claims: [
        { type: 'HYPOTHESIS', text: 'This might work', risk: 'MEDIUM' },
        { type: 'UNKNOWN', text: 'How will users react?' },
      ],
      proposals: [
        {
          kind: 'decision',
          title: 'Architecture choice',
          options: ['Option A', 'Option B'],
          selected: 'Option A',
          rationale: 'Simpler implementation',
        },
      ],
    });
    assert.equal(valid.success, true);

    // Invalid claim type for direct AI claims (e.g. FACT is not AI-allowed directly)
    const invalidClaim = geminiResponseSchema.safeParse({
      claims: [{ type: 'FACT', text: 'AI claiming a direct fact' }],
    });
    assert.equal(invalidClaim.success, false);
  });

  it('enforces that AI actors cannot decide or confirm in domain reducer', async () => {
    const io = human();
    await initProject(io);
    const log = await EventLog.open(dir);

    // Try to reduce a DECISION_RECORDED event with ai:gemini actor
    assert.throws(
      () => {
        reduce(
          log.state,
          stamp(log.state, {
            type: 'DECISION_RECORDED',
            actor: { kind: 'ai', agent: 'gemini' },
            payload: {
              decisionId: 'd-1',
              title: 'Unauthorized decision',
              options: ['yes', 'no'],
              selected: 'yes',
              rationale: 'AI deciding directly',
            },
          }),
        );
      },
      (err: unknown) => {
        return err instanceof DomainError && err.code === 'AI_NOT_AUTHORIZED';
      },
    );
  });

  it('handles rate limits (429), timeouts and invalid JSON gracefully', async () => {
    process.env.GEMINI_API_KEY = 'test-key-12345';
    const io = human(['yes']);
    await initProject(io);

    // 429 Rate limit
    const rateLimitCaller: GeminiCaller = {
      generate: async () => {
        throw new Error('Resource has been exhausted (e.g. check quota): 429');
      },
    };
    const codeRate = await runCli(['ai', 'explore'], io, { geminiCaller: rateLimitCaller });
    assert.notEqual(codeRate, 0);
    assert.match(io.err.join('\n'), /rate limit reached \(429\)/i);

    // Timeout
    io.err.length = 0;
    const timeoutCaller: GeminiCaller = {
      generate: async () => {
        throw new Error('Connection timeout exceeded');
      },
    };
    const codeTimeout = await runCli(['ai', 'explore'], io, { geminiCaller: timeoutCaller });
    assert.notEqual(codeTimeout, 0);
    assert.match(io.err.join('\n'), /timed out/i);

    // Invalid JSON
    io.err.length = 0;
    const badJsonCaller: GeminiCaller = {
      generate: async () => 'not json at all',
    };
    const codeBadJson = await runCli(['ai', 'explore'], io, { geminiCaller: badJsonCaller });
    assert.notEqual(codeBadJson, 0);
    assert.match(io.err.join('\n'), /invalid JSON/i);
  });

  it('masks secrets before sending prompt to Gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key-12345';
    const io = human(['yes']);
    await initProject(io);

    // Add a dump containing a sensitive token
    const secret = fakeSecret('ghp_~123456789012345678901234567890123456');
    await runCli(['dump', `my secret token is ${secret} and private notes`], io);

    let sentPrompt = '';
    const inspectCaller: GeminiCaller = {
      generate: async (prompt) => {
        sentPrompt = prompt;
        return JSON.stringify({
          summary: 'Scanned',
          notes: [],
          claims: [],
          proposals: [],
        });
      },
    };

    const code = await runCli(['ai', 'explore'], io, { geminiCaller: inspectCaller });
    assert.equal(code, 0);
    assert.equal(sentPrompt.includes(secret), false, 'Raw secret must not be sent to Gemini');
    assert.match(sentPrompt, /\[REDACTED/i, 'Secret must be masked');
  });

  it('cws doctor reports Gemini status without exposing key', async () => {
    const io = human();
    await initProject(io);

    // Without key
    delete process.env.GEMINI_API_KEY;
    await runCli(['doctor'], io);
    assert.match(io.out.join('\n'), /Gemini API:\s+key present: no/i);

    // With key
    io.out.length = 0;
    process.env.GEMINI_API_KEY = 'super-secret-gemini-key-123456';
    await runCli(['doctor'], io);
    const doctorOut = io.out.join('\n');
    assert.match(doctorOut, /Gemini API:\s+key present: yes/i);
    assert.equal(doctorOut.includes('super-secret-gemini-key-123456'), false, 'Key must NEVER be printed');
  });
});
