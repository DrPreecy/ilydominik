import type { Command } from 'commander';
import { newId } from '../../domain/ids.ts';
import type { ClaimType, Risk } from '../../domain/types.ts';
import { FINDING_MARKER, FINDING_MARKER_RESERVED } from '../../findings/types.ts';
import { actorOf, confirmDecision, fail, openLog, requireHumanUnlessAgent, say, splitList, type ActorOpts, type Env } from '../human.ts';

interface AddClaimOpts extends ActorOpts {
  type: string;
  text: string;
  risk?: string;
  from?: string;
}

interface AddEvidenceOpts extends ActorOpts {
  claim: string;
  text: string;
  source?: string;
}

const AUTHORITATIVE_TYPES = new Set(['FACT', 'USER_STATEMENT']);

const isStdinMarker = (parts: string[]): boolean => parts.length === 0 || (parts.length === 1 && parts[0] === '-');

async function dump(env: Env, parts: string[], opts: ActorOpts): Promise<void> {
  requireHumanUnlessAgent(env, 'dump', opts);
  const text = isStdinMarker(parts) ? await env.io.readStdin() : parts.join(' ');
  if (text.trim() === '') fail(env, 'error: nothing to record — give some text, or pipe it in with `cws dump -`');
  const log = await openLog(env);
  const noteId = newId('n');
  await log.append({ type: 'NOTE_ADDED', actor: actorOf(opts), payload: { noteId, text } });
  say(env, `noted [${noteId}]`);
}

async function addClaim(env: Env, o: AddClaimOpts): Promise<void> {
  requireHumanUnlessAgent(env, 'claim add', o);
  if (o.text.trimStart().startsWith(FINDING_MARKER)) fail(env, FINDING_MARKER_RESERVED);
  const log = await openLog(env);
  if (!o.agent && AUTHORITATIVE_TYPES.has(o.type.toUpperCase())) await confirmDecision(env);
  const claimId = newId('c');
  const derivedFrom = splitList(o.from);
  const payload = {
    claimId,
    type: o.type.toUpperCase() as ClaimType,
    text: o.text,
    ...(o.risk ? { risk: o.risk.toUpperCase() as Risk } : {}),
    ...(derivedFrom.length > 0 ? { derivedFrom } : {}),
  };
  await log.append({ type: 'CLAIM_ADDED', actor: actorOf(o), payload });
  say(env, `claim added [${claimId}] ${payload.type}`);
}

async function addEvidence(env: Env, o: AddEvidenceOpts): Promise<void> {
  requireHumanUnlessAgent(env, 'evidence add', o);
  const log = await openLog(env);
  const evidenceId = newId('e');
  const payload = { evidenceId, claimId: o.claim, text: o.text, ...(o.source ? { source: o.source } : {}) };
  await log.append({ type: 'EVIDENCE_ADDED', actor: actorOf(o), payload });
  say(env, `evidence added [${evidenceId}] for ${o.claim}`);
}

export function registerCapture(program: Command, env: Env): void {
  program
    .command('dump [text...]')
    .description('save raw thoughts verbatim ("-" or no text reads stdin)')
    .option('--agent <name>', 'record as this AI agent')
    .option('--role <role>', 'the role the agent played')
    .action((t: string[], o: ActorOpts) => dump(env, t, o));

  const claim = program.command('claim').description('claims');
  claim
    .command('add')
    .description('add a claim')
    .requiredOption('--type <type>', 'USER_STATEMENT|FACT|INTERPRETATION|ASSUMPTION|HYPOTHESIS|UNKNOWN')
    .requiredOption('--text <text>', 'the claim')
    .option('--risk <risk>', 'LOW|MEDIUM|HIGH|FATAL')
    .option('--from <ids>', 'comma list of ids this derives from')
    .option('--agent <name>', 'record as this AI agent')
    .option('--role <role>', 'the role the agent played')
    .action((o: AddClaimOpts) => addClaim(env, o));

  const evidence = program.command('evidence').description('evidence');
  evidence
    .command('add')
    .description('attach evidence to a claim')
    .requiredOption('--claim <id>', 'claim id')
    .requiredOption('--text <text>', 'the evidence')
    .option('--source <source>', 'where it comes from')
    .option('--agent <name>', 'record as this AI agent')
    .option('--role <role>', 'the role the agent played')
    .action((o: AddEvidenceOpts) => addEvidence(env, o));
}
