import type { Claim, Proposal } from '../../domain/types.ts';
import type { EventLog } from '../../store/event-log.ts';
import { describeProposal } from '../describe.ts';
import { aiClaimLine, pendingProposals, unconfirmedAiClaims } from '../format.ts';
import { confirmDecision, openLog, requireHuman, say, type Env } from '../human.ts';
import { acceptWithRisk, guarded, printRisk, proposalRisk, rejectOne } from '../proposal-ops.ts';

const HUMAN = { kind: 'human' } as const;
const WHY_PROMPT = 'Why do you accept this risk? (empty = skip): ';

interface Tally {
  accepted: number;
  rejected: number;
  confirmed: number;
  retired: number;
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

async function reviewProposal(env: Env, log: EventLog, p: Proposal, tally: Tally): Promise<Verdict> {
  say(env, '', describeProposal(p, log.state));
  const key = (await env.io.ask('[a]ccept [r]eject [s]kip [q]uit: ')).trim().toLowerCase();
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

async function claimAction(log: EventLog, c: Claim, key: string, tally: Tally): Promise<void> {
  if (key === 'c') {
    await log.append({ type: 'CLAIM_CONFIRMED', actor: HUMAN, payload: { claimId: c.id } });
    tally.confirmed++;
  } else if (key === 'r') {
    await log.append({ type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: c.id, status: 'RETIRED' } });
    tally.retired++;
  } else {
    tally.skipped++;
  }
}

async function reviewClaim(env: Env, log: EventLog, c: Claim, tally: Tally): Promise<Verdict> {
  say(env, '', aiClaimLine(c));
  const key = (await env.io.ask('[c]onfirm [r]etire [s]kip [q]uit: ')).trim().toLowerCase();
  if (key === 'q') return 'quit';
  await guarded(env, c.id, () => claimAction(log, c, key, tally));
  return 'continue';
}

export async function review(env: Env): Promise<void> {
  requireHuman(env, 'review');
  const log = await openLog(env);
  if (pendingProposals(log.state).length === 0 && unconfirmedAiClaims(log.state).length === 0) return say(env, 'Inbox empty.');
  await confirmDecision(env);
  const tally: Tally = { accepted: 0, rejected: 0, confirmed: 0, retired: 0, skipped: 0 };
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
      `${tally.retired} retired, ${tally.skipped} skipped.`,
  );
}
