import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { GoogleGenAI } from '@google/genai';
import { CWS_DIR } from '../store/event-log.ts';
import { PHASES, type ProjectState, type Risk } from '../domain/types.ts';

export const AI_USAGE_FILE = 'ai-usage.json';
export const CONSENT_DECISION_TITLE = 'Gemini Free Tier Data Privacy Consent';

export const AI_ALLOWED_CLAIM_TYPES = ['INTERPRETATION', 'ASSUMPTION', 'HYPOTHESIS', 'UNKNOWN'] as const;
export type AiAllowedClaimType = (typeof AI_ALLOWED_CLAIM_TYPES)[number];

const riskSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'FATAL']);
const text = z.string().min(1);

export const geminiClaimSchema = z.object({
  type: z.enum(AI_ALLOWED_CLAIM_TYPES),
  text,
  risk: riskSchema.optional(),
  derivedFrom: z.array(text).optional(),
});

export const geminiProposalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('claim'),
    type: z.enum(['FACT', 'USER_STATEMENT', 'INTERPRETATION', 'ASSUMPTION', 'HYPOTHESIS', 'UNKNOWN']),
    text,
    risk: riskSchema.optional(),
    derivedFrom: z.array(text).optional(),
  }),
  z.object({
    kind: z.literal('status'),
    claimId: text,
    status: z.enum(['OPEN', 'TESTING', 'SUPPORTED', 'FALSIFIED', 'ANSWERED', 'RETIRED']),
    evidence: text.optional(),
    answer: text.optional(),
  }),
  z.object({
    kind: z.literal('decision'),
    title: text,
    options: z.array(text).min(1),
    selected: text,
    rationale: text,
    links: z.array(text).optional(),
  }),
  z.object({
    kind: z.literal('phase'),
    to: z.enum(PHASES),
    reason: text,
  }),
]);

export const geminiResponseSchema = z.object({
  summary: z.string().optional(),
  notes: z.array(text).optional().default([]),
  claims: z.array(geminiClaimSchema).optional().default([]),
  proposals: z.array(geminiProposalSchema).optional().default([]),
});

export type GeminiResponse = z.infer<typeof geminiResponseSchema>;

export interface AiUsage {
  date: string;
  count: number;
}

export function getGeminiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.GEMINI_API_KEY?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function hasGeminiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return getGeminiKey(env) !== undefined;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function usageFilePath(rootDir: string): string {
  return path.join(rootDir, CWS_DIR, AI_USAGE_FILE);
}

export async function readAiUsage(rootDir: string): Promise<AiUsage> {
  const file = usageFilePath(rootDir);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AiUsage>;
    if (typeof parsed?.date === 'string' && typeof parsed?.count === 'number') {
      return { date: parsed.date, count: parsed.count };
    }
  } catch {
    // Missing or invalid, return fresh
  }
  return { date: todayIsoDate(), count: 0 };
}

export async function checkAiUsage(
  rootDir: string,
  dailyLimit: number,
): Promise<{ ok: boolean; todayCount: number; resetsAt: string }> {
  const today = todayIsoDate();
  const usage = await readAiUsage(rootDir);
  const count = usage.date === today ? usage.count : 0;
  return {
    ok: count < dailyLimit,
    todayCount: count,
    resetsAt: 'midnight UTC',
  };
}

export async function incrementAiUsage(rootDir: string): Promise<number> {
  const today = todayIsoDate();
  const usage = await readAiUsage(rootDir);
  const nextCount = usage.date === today ? usage.count + 1 : 1;
  const file = usageFilePath(rootDir);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ date: today, count: nextCount }, null, 2) + '\n');
  } catch {
    // best-effort write
  }
  return nextCount;
}

export function hasGeminiConsent(state: ProjectState | null): boolean {
  if (!state) return false;
  return Object.values(state.decisions).some(
    (d) =>
      d.title.toLowerCase().includes('gemini') &&
      d.title.toLowerCase().includes('privacy') &&
      d.selected.toLowerCase() === 'yes',
  );
}

export function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

export const GEMINI_SYSTEM_INSTRUCTION = `You are Gemini acting as actor "ai:gemini" inside the Cognitive Work System (CWS).
CWS enforces epistemic discipline and human authority:
1. You may propose or structure thoughts as "notes", unconfirmed "claims", or "proposals".
2. You can NEVER make authoritative decisions or alter project state directly.
3. For direct claims, use only: "INTERPRETATION", "ASSUMPTION", "HYPOTHESIS", or "UNKNOWN".
4. Any candidate decisions, status changes, or authoritative facts must be wrapped inside "proposals".
5. Return ONLY a valid JSON object matching this schema:
{
  "summary": string (optional concise overview of your findings),
  "notes": string[] (raw observations or thoughts),
  "claims": [
    { "type": "INTERPRETATION" | "ASSUMPTION" | "HYPOTHESIS" | "UNKNOWN", "text": string, "risk": "LOW" | "MEDIUM" | "HIGH" | "FATAL" (optional), "derivedFrom": string[] (optional) }
  ],
  "proposals": [
    { "kind": "claim", "type": "FACT" | "USER_STATEMENT" | "INTERPRETATION" | "ASSUMPTION" | "HYPOTHESIS" | "UNKNOWN", "text": string, "risk": string (optional), "derivedFrom": string[] (optional) }
    | { "kind": "status", "claimId": string, "status": "OPEN" | "TESTING" | "SUPPORTED" | "FALSIFIED" | "ANSWERED" | "RETIRED", "evidence": string (optional), "answer": string (optional) }
    | { "kind": "decision", "title": string, "options": string[], "selected": string, "rationale": string, "links": string[] (optional) }
    | { "kind": "phase", "to": string, "reason": string }
  ]
}`;

export interface GeminiCaller {
  generate(
    prompt: string,
    opts: { model: string; maxOutputTokens?: number; systemInstruction?: string },
  ): Promise<string>;
}

export class DefaultGeminiCaller implements GeminiCaller {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async generate(
    prompt: string,
    opts: { model: string; maxOutputTokens?: number; systemInstruction?: string },
  ): Promise<string> {
    const response = await this.client.models.generateContent({
      model: opts.model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        ...(opts.systemInstruction ? { systemInstruction: opts.systemInstruction } : {}),
        ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      },
    });
    return response.text ?? '';
  }
}
