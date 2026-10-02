import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import { parseEventInput } from '../../domain/schema.ts';
import type { EventInput, Proposal } from '../../domain/types.ts';
import { describeProposal } from '../describe.ts';
import { actorLabel, aiClaimLine, oneLine, pendingProposals, summarizeItem, unconfirmedAiClaims } from '../format.ts';
import { actorOf, confirmDecision, fail, openLog, requireHuman, say, type Env } from '../human.ts';
import { acceptWithRisk, guarded, printRisk, proposalRisk, rejectOne } from '../proposal-ops.ts';
import { review } from './review.ts';
import type { EventLog } from '../../store/event-log.ts';
const REVIEW_HINT = 'The human reviews with `cws review`.';
const MAX_INPUT_CHARS = 1_000_000;
const MAX_BATCH = 50;

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

async function readRaw(env: Env, source: string): Promise<string> {
  if (source !== '-') {
    const { size } = await fs.stat(source);
    if (size > MAX_INPUT_CHARS * 4) fail(env, 'error: the proposal input is too large (limit 1 MB)');
  }
  const raw = source === '-' ? await env.io.readStdin() : await fs.readFile(source, 'utf8');
  if (raw.length > MAX_INPUT_CHARS) fail(env, 'error: the proposal input is too large (limit 1 MB)');
  return raw;
}

async function readJson(env: Env, source: string): Promise<unknown> {
  try {
    return JSON.parse(await readRaw(env, source));
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return fail(env, 'error: the proposal input is not valid JSON');
    throw error;
  }
}

async function propose(env: Env, opts: { agent?: string; role?: string; json?: string }): Promise<void> {
  if (!opts.agent) fail(env, 'error: --agent <name> is required — proposals are how AI agents speak (e.g. --agent copilot)');
  if (!opts.json) fail(env, 'error: --json <file|-> is required');
  const { agent } = opts;
  const entries = entriesOf(await readJson(env, opts.json));
  if (entries.length > MAX_BATCH) fail(env, `error: too many proposals (${entries.length}); the limit is ${MAX_BATCH} per batch`);
  const inputs = entries.map((e, i) => toInput(env, e, i, agent));
  if (inputs.length === 0) fail(env, 'error: no proposals found in the input');
  const log = await openLog(env);
  for (const event of await log.appendBatch(inputs)) {
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

async function inbox(env: Env): Promise<void> {
  const state = (await openLog(env)).state;
  const proposals = pendingProposals(state);
  const claims = unconfirmedAiClaims(state);
  if (proposals.length === 0 && claims.length === 0) return say(env, 'Inbox empty.');
  if (proposals.length > 0) say(env, 'Pending proposals:', ...proposals.flatMap(proposalLines));
  if (claims.length > 0) say(env, 'Unconfirmed AI claims:', ...claims.map(aiClaimLine));
  say(env, 'Review them with `cws review`.');
}

async function acceptStep(env: Env, log: EventLog, p: Proposal, acceptRisk?: string): Promise<void> {
  const warnings = proposalRisk(log, p);
  if (warnings.length > 0 && !acceptRisk) {
    say(env, `[${p.id}] has warnings and was NOT accepted:`);
    printRisk(env, warnings);
    say(env, `To accept anyway: cws accept ${p.id} --accept-risk "<why you accept this risk>"`);
    return;
  }
  say(env, `accepted [${p.id}] → ${await acceptWithRisk(log, p, warnings, acceptRisk)}`);
}

async function accept(env: Env, ids: string[], opts: { all?: boolean; acceptRisk?: string }): Promise<void> {
  requireHuman(env, 'accept');
  const log = await openLog(env);
  const pending = pendingProposals(log.state);
  if (ids.length === 0 && !opts.all) fail(env, 'error: give proposal ids, or --all');
  const unique = [...new Set(ids)];
  const chosen = opts.all ? pending : unique.map((id) => pending.find((p) => p.id === id) ?? fail(env, `error: no pending proposal ${id}`));
  if (chosen.length === 0) return say(env, 'Nothing pending.');
  say(env, ...chosen.map((p) => describeProposal(p, log.state)));
  await confirmDecision(env);
  for (const p of chosen) await guarded(env, p.id, () => acceptStep(env, log, p, opts.acceptRisk));
}

async function reject(env: Env, id: string, opts: { note?: string }): Promise<void> {
  requireHuman(env, 'reject');
  const log = await openLog(env);
  const p = pendingProposals(log.state).find((x) => x.id === id);
  if (!p) fail(env, `error: no pending proposal ${id}`);
  await rejectOne(log, p, opts.note);
  say(env, `rejected [${id}]`);
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
    .option('--accept-risk <why>', 'accept a phase proposal despite warnings, and say why')
    .action((ids: string[], o: { all?: boolean; acceptRisk?: string }) => accept(env, ids, o));
  program
    .command('reject <id>')
    .description('reject a proposal (human)')
    .option('--note <text>', 'why')
    .action((id: string, o: { note?: string }) => reject(env, id, o));
  program.command('review').description('walk through the inbox (human)').action(() => review(env));
}
