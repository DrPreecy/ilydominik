import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import { CLAIM_STATUSES, CLAIM_TYPES, PHASES, type ClaimStatus, type ClaimType, type Phase, type ProjectState, type Warning } from '../../domain/types.ts';
import { phaseWarnings } from '../../guidance/warnings.ts';
import type { EventLog } from '../../store/event-log.ts';
import { oneLine, warningLine } from '../format.ts';
import { EXIT } from '../io.ts';
import { CliExit, confirmDecision, fail, openLog, requireClaim, requireHuman, say, splitList, type Env } from '../human.ts';

const HUMAN = { kind: 'human' } as const;

function oneOf<T extends string>(env: Env, value: string, allowed: readonly T[], what: string): T {
  const v = value.trim().toUpperCase().replace(/-/g, '_');
  if (!(allowed as readonly string[]).includes(v)) fail(env, `error: unknown ${what} "${value}" (choose from ${allowed.join(', ')})`);
  return v as T;
}

async function confirmClaim(env: Env, claimId: string, opts: { as?: string }): Promise<void> {
  requireHuman(env, 'confirm');
  const log = await openLog(env);
  requireClaim(env, log.state, claimId);
  const asType = opts.as ? oneOf<ClaimType>(env, opts.as, CLAIM_TYPES, 'claim type') : undefined;
  await confirmDecision(env);
  await log.append({ type: 'CLAIM_CONFIRMED', actor: HUMAN, payload: asType ? { claimId, asType } : { claimId } });
  say(env, `confirmed [${claimId}]${asType ? ` as ${asType}` : ''}`);
}

async function retire(env: Env, claimId: string, opts: { reason?: string }): Promise<void> {
  requireHuman(env, 'retire');
  const log = await openLog(env);
  requireClaim(env, log.state, claimId);
  const payload = { claimId, status: 'RETIRED' as const, ...(opts.reason ? { evidence: opts.reason } : {}) };
  await log.append({ type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload });
  say(env, `retired [${claimId}]`);
}

async function mark(env: Env, claimId: string, status: string, opts: { evidence?: string; answer?: string }): Promise<void> {
  requireHuman(env, 'mark');
  const log = await openLog(env);
  requireClaim(env, log.state, claimId);
  const next = oneOf<ClaimStatus>(env, status, CLAIM_STATUSES, 'status');
  await confirmDecision(env);
  const payload = {
    claimId,
    status: next,
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
    ...(opts.answer ? { answer: opts.answer } : {}),
  };
  await log.append({ type: 'CLAIM_STATUS_CHANGED', actor: HUMAN, payload });
  say(env, `marked [${claimId}] ${next}`);
}

interface DecideOpts {
  title: string;
  selected: string;
  rationale: string;
  options?: string;
  links?: string;
}

async function decide(env: Env, o: DecideOpts): Promise<void> {
  requireHuman(env, 'decide');
  const log = await openLog(env);
  await confirmDecision(env);
  const decisionId = newId('d');
  const links = splitList(o.links);
  const payload = {
    decisionId,
    title: o.title,
    options: splitList(o.options),
    selected: o.selected,
    rationale: o.rationale,
    ...(links.length > 0 ? { links } : {}),
  };
  await log.append({ type: 'DECISION_RECORDED', actor: HUMAN, payload });
  say(env, `decision recorded [${decisionId}] ${o.title} → ${o.selected}`);
}

// ---------------------------------------------------------------------------
// phase
// ---------------------------------------------------------------------------

const isRisky = (w: Warning): boolean => w.severity === 'caution' || w.severity === 'serious';

function printAffected(env: Env, state: ProjectState): void {
  const ids = state.phaseHistory.at(-1)?.possiblyAffected ?? [];
  if (ids.length === 0) return;
  const label = (id: string): string => {
    const claim = state.claims.find((c) => c.id === id);
    const decision = state.decisions.find((d) => d.id === id);
    return `  ${id} ${oneLine(claim?.text ?? decision?.title ?? '')}`;
  };
  say(env, 'Possibly affected (review, nothing was changed):', ...ids.map(label));
}

async function phase(env: Env, phaseArg: string, o: { reason: string; acceptRisk?: string }): Promise<void> {
  requireHuman(env, 'phase');
  const to = oneOf<Phase>(env, phaseArg, PHASES, 'phase');
  const log = await openLog(env);
  const warnings = phaseWarnings(log.state, to);
  const risky = warnings.some(isRisky);
  if (risky && !o.acceptRisk) {
    say(env, ...warnings.map(warningLine));
    say(env, `To proceed anyway, say why: cws phase ${to} --reason "..." --accept-risk "<why you accept this risk>"`);
    throw new CliExit(EXIT.NEEDS_HUMAN);
  }
  await confirmDecision(env);
  if (o.acceptRisk && warnings.length > 0) await recordOverride(log, to, o.acceptRisk, warnings);
  await log.append({ type: 'PHASE_CHANGED', actor: HUMAN, payload: { to, reason: o.reason } });
  say(env, `phase → ${to}`);
  printAffected(env, log.state);
}

async function recordOverride(log: EventLog, to: Phase, why: string, warnings: Warning[]): Promise<void> {
  const known = new Set(log.state.claims.map((c) => c.id));
  const links = [...new Set(warnings.flatMap((w) => w.refs).filter((r) => known.has(r)))];
  await log.append({
    type: 'DECISION_RECORDED',
    actor: HUMAN,
    payload: {
      decisionId: newId('d'),
      title: `Proceed to ${to} under uncertainty`,
      options: ['proceed', 'wait'],
      selected: 'proceed',
      rationale: why,
      links,
      kind: 'PROCEED_UNDER_UNCERTAINTY',
    },
  });
}

export function registerDecisions(program: Command, env: Env): void {
  program
    .command('confirm <claimId>')
    .description('confirm an AI-created claim (human)')
    .option('--as <type>', 'confirm it as this claim type')
    .action((id: string, o: { as?: string }) => confirmClaim(env, id, o));
  program
    .command('retire <claimId>')
    .description('retire a claim, keeping its history (human)')
    .option('--reason <text>', 'why')
    .action((id: string, o: { reason?: string }) => retire(env, id, o));
  program
    .command('mark <claimId> <status>')
    .description('set a claim status (human)')
    .option('--evidence <text>', 'what shows this')
    .option('--answer <text>', 'the answer, for an UNKNOWN')
    .action((id: string, s: string, o: { evidence?: string; answer?: string }) => mark(env, id, s, o));
  program
    .command('decide')
    .description('record a decision (human)')
    .requiredOption('--title <text>', 'what was decided')
    .requiredOption('--selected <text>', 'the chosen option')
    .requiredOption('--rationale <text>', 'why')
    .option('--options <list>', 'comma list of options considered')
    .option('--links <ids>', 'comma list of claim/decision ids this rests on')
    .action((o: DecideOpts) => decide(env, o));
  program
    .command('phase <phase>')
    .description('move to another phase (human)')
    .requiredOption('--reason <text>', 'why')
    .option('--accept-risk <why>', 'proceed despite warnings, and say why')
    .action((p: string, o: { reason: string; acceptRisk?: string }) => phase(env, p, o));
}
