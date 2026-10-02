import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import { parseEventInput } from '../../domain/schema.ts';
import type { Claim, EventInput, Proposal } from '../../domain/types.ts';
import type { EventLog } from '../../store/event-log.ts';
import { actorLabel, claimLine, oneLine, pendingProposals, summarizeItem, unconfirmedAiClaims } from '../format.ts';
import { actorOf, confirmDecision, fail, openLog, requireHuman, say, type Env } from '../human.ts';

const HUMAN = { kind: 'human' } as const;
const REVIEW_HINT = 'The human reviews with `cws review`.';

/** Id of the thing a proposal turns into once accepted. */
function resultIdFor(p: Proposal): string {
  switch (p.item.kind) {
    case 'claim': return newId('c');
    case 'decision': return newId('d');
    case 'status': return p.item.claimId;
    case 'phase': return p.id;
  }
}

async function acceptOne(log: EventLog, p: Proposal): Promise<string> {
  const resultId = resultIdFor(p);
  await log.append({ type: 'PROPOSAL_ACCEPTED', actor: HUMAN, payload: { proposalId: p.id, resultId } });
  return resultId;
}

async function rejectOne(log: EventLog, p: Proposal, note?: string): Promise<void> {
  const payload = note ? { proposalId: p.id, note } : { proposalId: p.id };
  await log.append({ type: 'PROPOSAL_REJECTED', actor: HUMAN, payload });
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function entriesOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (isRecord(parsed) && Array.isArray(parsed.proposals)) return parsed.proposals;
  return [parsed];
}

function toInput(env: Env, entry: unknown, index: number, agent: string): EventInput {
  if (!isRecord(entry) || !isRecord(entry.item)) fail(env, `error: proposal #${index + 1} needs an "item" object`);
  const rationale = typeof entry.rationale === 'string' && entry.rationale.trim() !== '' ? entry.rationale : undefined;
  const payload = { proposalId: newId('pr'), item: entry.item, ...(rationale ? { rationale } : {}) };
  try {
    return parseEventInput({ type: 'PROPOSAL_SUBMITTED', actor: actorOf({ agent }), payload });
  } catch (error: unknown) {
    fail(env, `error: proposal #${index + 1} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJson(env: Env, source: string): Promise<unknown> {
  const raw = source === '-' ? await env.io.readStdin() : await fs.readFile(source, 'utf8');
  try {
    return JSON.parse(raw);
  } catch {
    return fail(env, 'error: the proposal input is not valid JSON');
  }
}

async function propose(env: Env, opts: { agent?: string; role?: string; json?: string }): Promise<void> {
  if (!opts.agent) fail(env, 'error: --agent <name> is required — proposals are how AI agents speak (e.g. --agent copilot)');
  if (!opts.json) fail(env, 'error: --json <file|-> is required');
  const { agent } = opts;
  const inputs = entriesOf(await readJson(env, opts.json)).map((e, i) => toInput(env, e, i, agent));
  if (inputs.length === 0) fail(env, 'error: no proposals found in the input');
  const log = await openLog(env);
  for (const input of inputs) {
    const event = await log.append(input);
    if (event.type === 'PROPOSAL_SUBMITTED') say(env, `proposed [${event.payload.proposalId}] ${summarizeItem(event.payload.item)}`);
  }
  say(env, REVIEW_HINT);
}

// ---------------------------------------------------------------------------
// inbox / accept / reject
// ---------------------------------------------------------------------------

function proposalLines(p: Proposal): string[] {
  return [
    `${p.id} [${p.item.kind}] ${summarizeItem(p.item)} — by ${actorLabel(p.actor)}`,
    ...(p.rationale ? [`    why: ${oneLine(p.rationale, 200)}`] : []),
  ];
}

function aiClaimLine(c: Claim): string {
  return `${claimLine(c)} — by ${actorLabel(c.createdBy)}`;
}

async function inbox(env: Env): Promise<void> {
  const state = (await openLog(env)).state;
  const proposals = pendingProposals(state);
  const claims = unconfirmedAiClaims(state);
  if (proposals.length === 0 && claims.length === 0) return say(env, 'Inbox empty.');
  if (proposals.length > 0) say(env, 'Pending proposals:', ...proposals.flatMap(proposalLines));
  if (claims.length > 0) say(env, 'Unconfirmed AI claims:', ...claims.map(aiClaimLine));
  say(env, 'Review them with `cws review`.');
}

async function accept(env: Env, ids: string[], opts: { all?: boolean }): Promise<void> {
  requireHuman(env, 'accept');
  const log = await openLog(env);
  const pending = pendingProposals(log.state);
  if (ids.length === 0 && !opts.all) fail(env, 'error: give proposal ids, or --all');
  const chosen = opts.all ? pending : ids.map((id) => pending.find((p) => p.id === id) ?? fail(env, `error: no pending proposal ${id}`));
  if (chosen.length === 0) return say(env, 'Nothing pending.');
  await confirmDecision(env);
  for (const p of chosen) say(env, `accepted [${p.id}] → ${await acceptOne(log, p)}`);
}

async function reject(env: Env, id: string, opts: { note?: string }): Promise<void> {
  requireHuman(env, 'reject');
  const log = await openLog(env);
  const p = pendingProposals(log.state).find((x) => x.id === id);
  if (!p) fail(env, `error: no pending proposal ${id}`);
  await rejectOne(log, p, opts.note);
  say(env, `rejected [${id}]`);
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

interface Tally {
  accepted: number;
  rejected: number;
  confirmed: number;
  retired: number;
  skipped: number;
}

type Verdict = 'quit' | 'continue';

async function reviewProposal(env: Env, log: EventLog, p: Proposal, tally: Tally): Promise<Verdict> {
  say(env, '', ...proposalLines(p));
  const key = (await env.io.ask('[a]ccept [r]eject [s]kip [q]uit: ')).trim().toLowerCase();
  if (key === 'q') return 'quit';
  if (key === 'a') {
    await acceptOne(log, p);
    tally.accepted++;
  } else if (key === 'r') {
    await rejectOne(log, p, (await env.io.ask('Reason (optional): ')).trim() || undefined);
    tally.rejected++;
  } else {
    tally.skipped++;
  }
  return 'continue';
}

async function reviewClaim(env: Env, log: EventLog, c: Claim, tally: Tally): Promise<Verdict> {
  say(env, '', aiClaimLine(c));
  const key = (await env.io.ask('[c]onfirm [r]etire [s]kip [q]uit: ')).trim().toLowerCase();
  if (key === 'q') return 'quit';
  if (key === 'c') {
    await log.append({ type: 'CLAIM_CONFIRMED', actor: HUMAN, payload: { claimId: c.id } });
    tally.confirmed++;
  } else if (key === 'r') {
    await log.append({ type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload: { claimId: c.id, status: 'RETIRED' } });
    tally.retired++;
  } else {
    tally.skipped++;
  }
  return 'continue';
}

async function review(env: Env): Promise<void> {
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

export function registerProposals(program: Command, env: Env): void {
  program
    .command('propose')
    .description('AI agents: submit suggestions for the human to review')
    .option('--agent <name>', 'your agent name (required)')
    .option('--role <role>', 'the role you played')
    .option('--json <file|->', 'proposals as JSON (file path or - for stdin)')
    .action((o: { agent?: string; role?: string; json?: string }) => propose(env, o));
  program.command('inbox').description('what is waiting for your review').action(() => inbox(env));
  program
    .command('accept [ids...]')
    .description('accept proposals (human)')
    .option('--all', 'accept every pending proposal')
    .action((ids: string[], o: { all?: boolean }) => accept(env, ids, o));
  program
    .command('reject <id>')
    .description('reject a proposal (human)')
    .option('--note <text>', 'why')
    .action((id: string, o: { note?: string }) => reject(env, id, o));
  program.command('review').description('walk through the inbox (human)').action(() => review(env));
}
