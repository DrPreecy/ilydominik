import type { Claim, Proposal } from '../../domain/types.ts';
import type { EventLog } from '../../store/event-log.ts';
import { describeClaim, describeProposal } from '../describe.ts';
import { pendingProposals, unconfirmedAiClaims } from '../format.ts';
import { confirmDecision, openLog, requireHuman, say, warn, type Env } from '../human.ts';
import { acceptWithRisk, guarded, printRisk, proposalRisk, rejectOne } from '../proposal-ops.ts';

const HUMAN = { kind: 'human' } as const;
const WHY_PROMPT = 'Why do you accept this risk? (empty = skip): ';

interface Tally {
  accepted: number;
  rejected: number;
  confirmed: number;
  retired: number;
  falsified: number;
  supported: number;
  skipped: number;
}

type Verdict = 'quit' | 'continue';

/** Accept in the review loop; a risky phase change needs a stated reason. */
async function acceptInReview(env: Env, log: EventLog, p: Proposal, tally: Tally): Promise<void> {
  const warnings = proposalRisk(log, p);
  let why: string | undefined;
  if (warnings.length > 0) {
    printRisk(env, warnings);
    why = (await env.io.ask(WHY_PROMPT)).trim();
    if (why === '') {
      tally.skipped++;
      return;
    }
  }
  await acceptWithRisk(log, p, warnings, why);
  tally.accepted++;
}

/** Skip is `k` (or Enter); `s` is reserved for "supported" on claims and never means skip. */
const PROPOSAL_KEYS = new Set(['a', 'r', 'k', 'q', '']);
const CLAIM_KEYS = new Set(['c', 'r', 'k', 'q', '']);
const TESTABLE_CLAIM_KEYS = new Set([...CLAIM_KEYS, 'f', 's']);

/** One key from `allowed`; anything else is said out loud and asked again, never read as another key. */
async function askKey(env: Env, question: string, allowed: ReadonlySet<string>): Promise<string> {
  for (;;) {
    const key = (await env.io.ask(question)).trim().toLowerCase();
    if (allowed.has(key)) return key;
    warn(env, `"${key}" is not one of the choices here.`);
  }
}

async function reviewProposal(env: Env, log: EventLog, p: Proposal, tally: Tally): Promise<Verdict> {
  say(env, '', describeProposal(p, log.state));
  const key = await askKey(env, '[a]ccept [r]eject [k] skip [q]uit: ', PROPOSAL_KEYS);
  if (key === 'q') return 'quit';
  if (key === 'a') {
    await guarded(env, p.id, () => acceptInReview(env, log, p, tally));
  } else if (key === 'r') {
    const note = (await env.io.ask('Reason (optional): ')).trim() || undefined;
    await guarded(env, p.id, async () => {
      await rejectOne(log, p, note);
      tally.rejected++;
    });
  } else {
    tally.skipped++;
  }
  return 'continue';
}

/** Claim types that can be tested, so the human can give a verdict on them (as `cws mark` does). */
const TESTABLE = new Set<Claim['type']>(['HYPOTHESIS', 'ASSUMPTION']);
const VERDICTS = { f: 'FALSIFIED', s: 'SUPPORTED' } as const;

/** A verdict is a decision of its own: like `cws mark`, it takes the typed code; a wrong code skips the claim. */
async function verdict(env: Env, log: EventLog, c: Claim, status: 'FALSIFIED' | 'SUPPORTED', tally: Tally): Promise<void> {
  const evidence = (await env.io.ask('What shows it? (optional): ')).trim();
  const code = env.io.challenge();
  const answer = await env.io.ask(`Type ${code} to mark it ${status.toLowerCase()}: `);
  if (answer.trim().toUpperCase() !== code.toUpperCase()) {
    warn(env, 'Not confirmed; skipped.');
    tally.skipped++;
    return;
  }
  await log.append({ type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: c.id, status, ...(evidence ? { evidence } : {}) } });
  if (status === 'FALSIFIED') tally.falsified++;
  else tally.supported++;
}

async function claimAction(env: Env, log: EventLog, c: Claim, key: string, tally: Tally): Promise<void> {
  if (key === 'c') {
    await log.append({ type: 'CLAIM_CONFIRMED', actor: HUMAN, payload: { claimId: c.id } });
    tally.confirmed++;
  } else if (key === 'r') {
    await log.append({ type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: c.id, status: 'RETIRED' } });
    tally.retired++;
  } else if (TESTABLE.has(c.type) && (key === 'f' || key === 's')) {
    await verdict(env, log, c, VERDICTS[key], tally);
  } else {
    tally.skipped++;
  }
}

async function reviewClaim(env: Env, log: EventLog, c: Claim, tally: Tally): Promise<Verdict> {
  say(env, '', describeClaim(c, log.state));
  const keys = TESTABLE.has(c.type)
    ? '[c]onfirm [f]alsified [s]upported [r]etire [k] skip [q]uit: '
    : '[c]onfirm [r]etire [k] skip [q]uit: ';
  const key = await askKey(env, keys, TESTABLE.has(c.type) ? TESTABLE_CLAIM_KEYS : CLAIM_KEYS);
  if (key === 'q') return 'quit';
  await guarded(env, c.id, () => claimAction(env, log, c, key, tally));
  return 'continue';
}

export async function review(env: Env): Promise<void> {
  requireHuman(env, 'review');
  const log = await openLog(env);
  if (pendingProposals(log.state).length === 0 && unconfirmedAiClaims(log.state).length === 0) return say(env, 'Inbox empty.');
  await confirmDecision(env);
  const tally: Tally = { accepted: 0, rejected: 0, confirmed: 0, retired: 0, falsified: 0, supported: 0, skipped: 0 };
  let verdict: Verdict = 'continue';
  for (const p of pendingProposals(log.state)) {
    verdict = await reviewProposal(env, log, p, tally);
    if (verdict === 'quit') break;
  }
  for (const c of verdict === 'quit' ? [] : unconfirmedAiClaims(log.state)) {
    verdict = await reviewClaim(env, log, c, tally);
    if (verdict === 'quit') break;
  }
  say(
    env,
    '',
    `Review done: ${tally.accepted} accepted, ${tally.rejected} rejected, ${tally.confirmed} confirmed, ` +
      `${tally.retired} retired, ${tally.falsified} falsified, ${tally.supported} supported, ${tally.skipped} skipped.`,
  );
}
