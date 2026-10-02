import { z } from 'zod';
import { CLAIM_STATUSES, CLAIM_TYPES, DomainError, PHASES, RISKS } from './types.ts';
import type { CwsEvent, EventInput } from './types.ts';

const text = z.string().refine((s) => s.trim().length > 0, 'must not be blank');
const optText = text.optional();
const phase = z.enum(PHASES);
const claimType = z.enum(CLAIM_TYPES);
const claimStatus = z.enum(CLAIM_STATUSES);
const risk = z.enum(RISKS);
const ids = z.array(text);

const actorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human') }),
  z.object({ kind: z.literal('ai'), agent: text, role: optText }),
]);

const proposedItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('claim'), type: claimType, text, risk: risk.optional(), derivedFrom: ids.optional() }),
  z.object({ kind: z.literal('status'), claimId: text, status: claimStatus, evidence: optText, answer: optText }),
  z.object({
    kind: z.literal('decision'),
    title: text,
    options: z.array(text),
    selected: text,
    rationale: text,
    links: ids.optional(),
  }),
  z.object({ kind: z.literal('phase'), to: phase, reason: text }),
]);

const payloads = {
  PROJECT_CREATED: z.object({ projectId: text, title: text }),
  NOTE_ADDED: z.object({ noteId: text, text }),
  SESSION_STARTED: z.object({ sessionId: text, goal: text }),
  SESSION_ENDED: z.object({ sessionId: text, summary: optText }),
  CLAIM_ADDED: z.object({ claimId: text, type: claimType, text, risk: risk.optional(), derivedFrom: ids.optional() }),
  CLAIM_CONFIRMED: z.object({ claimId: text, asType: claimType.optional() }),
  CLAIM_STATUS_CHANGED: z.object({ claimId: text, status: claimStatus, evidence: optText, answer: optText }),
  EVIDENCE_ADDED: z.object({ evidenceId: text, claimId: text, text, source: optText }),
  PROPOSAL_SUBMITTED: z.object({ proposalId: text, item: proposedItem, rationale: optText }),
  PROPOSAL_ACCEPTED: z.object({ proposalId: text, resultId: text, note: optText }),
  PROPOSAL_REJECTED: z.object({ proposalId: text, note: optText }),
  DECISION_RECORDED: z.object({
    decisionId: text,
    title: text,
    options: z.array(text),
    selected: text,
    rationale: text,
    links: ids.optional(),
    kind: z.enum(['NORMAL', 'PROCEED_UNDER_UNCERTAINTY']).optional(),
    supersedes: optText,
  }),
  PHASE_CHANGED: z.object({ to: phase, reason: text }),
};

const inputSchema = z.discriminatedUnion(
  'type',
  Object.entries(payloads).map(([type, payload]) =>
    z.object({ type: z.literal(type), actor: actorSchema, payload }),
  ) as unknown as [z.ZodObject<{ type: z.ZodLiteral<string> }>],
);

const envelope = z.object({
  v: z.literal(1),
  seq: z.number().int().min(0),
  id: text,
  at: text,
  sessionId: optText,
  prevHash: z.string(),
  hash: z.string(),
});

function summarize(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseWith<T>(schema: z.ZodType, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new DomainError('INVALID_EVENT', summarize(result.error));
  return result.data as T;
}

export function parseEventInput(raw: unknown): EventInput {
  return parseWith<EventInput>(inputSchema, raw);
}

export function parseStoredEvent(raw: unknown): CwsEvent {
  const env = parseWith<Record<string, unknown>>(envelope, raw);
  const input = parseEventInput(raw);
  return { ...input, ...env } as CwsEvent;
}
