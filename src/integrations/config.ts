import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CWS_DIR } from '../store/event-log.ts';

export const INTEGRATIONS_FILE = 'integrations.json';

const SANDBOX_MODES = ['auto', 'off', 'local', 'wsl', 'remote'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/**
 * Programs cws runs can be pointed elsewhere only from the environment. A repository
 * file cannot choose them: cloning a repo and running `cws doctor` must not run its code.
 */
export const TOOL_ENV = {
  ocr: 'CWS_TOOL_OCR',
  openshell: 'CWS_TOOL_OPENSHELL',
  prover: 'CWS_TOOL_PROVER',
} as const;
export type ToolName = keyof typeof TOOL_ENV;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const DEFAULT_DAILY_LIMIT = 20;
export const DEFAULT_MAX_INPUT_CHARS = 100_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export interface GeminiConfig {
  model: string;
  dailyCallLimit: number;
  maxInputChars: number;
  maxOutputTokens: number;
}

const geminiSchema = z.object({
  model: z.string().min(1).optional(),
  dailyCallLimit: z.number().int().min(1).optional(),
  maxInputChars: z.number().int().min(100).optional(),
  maxOutputTokens: z.number().int().min(100).optional(),
});

const schema = z.object({
  version: z.literal(1),
  sandbox: z
    .object({
      mode: z.enum(SANDBOX_MODES).optional(),
      wslDistro: z.string().min(1).optional(),
      gateway: z.string().min(1).optional(),
    })
    .optional(),
  gemini: geminiSchema.optional(),
  /** accepted so older files still load, but never used */
  tools: z.record(z.string(), z.unknown()).optional(),
});

export interface IntegrationsConfig {
  version: 1;
  sandbox: { mode: SandboxMode; wslDistro?: string; gateway?: string };
  gemini: GeminiConfig;
}

export interface LoadedConfig {
  config: IntegrationsConfig;
  file: string;
  /** set when the file exists but could not be used; the defaults are in effect */
  problem?: string;
  /** settings the file carries that cws refuses to take from a repository */
  ignored?: string;
}

export function defaultConfig(): IntegrationsConfig {
  return {
    version: 1,
    sandbox: { mode: 'auto' },
    gemini: {
      model: DEFAULT_GEMINI_MODEL,
      dailyCallLimit: DEFAULT_DAILY_LIMIT,
      maxInputChars: DEFAULT_MAX_INPUT_CHARS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    },
  };
}

export function configPath(rootDir: string): string {
  return path.join(rootDir, CWS_DIR, INTEGRATIONS_FILE);
}

/** The program path set for `name` in the environment, if any. */
export function toolOverride(name: ToolName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[TOOL_ENV[name]]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function ignoredTools(tools: Record<string, unknown> | undefined): string | undefined {
  const keys = Object.keys(tools ?? {});
  if (keys.length === 0) return undefined;
  const vars = Object.values(TOOL_ENV).join(', ');
  return `${keys.map((key) => `tools.${key}`).join(', ')} ignored: a repository file cannot choose programs for cws to run; set ${vars} instead`;
}

export async function loadIntegrations(rootDir: string): Promise<LoadedConfig> {
  const file = configPath(rootDir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return { config: defaultConfig(), file };
    throw error;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { config: defaultConfig(), file, problem: 'not valid JSON; using defaults' };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { config: defaultConfig(), file, problem: `${issues}; using defaults` };
  }

  const data = parsed.data;
  const ignored = ignoredTools(data.tools);
  return {
    file,
    ...(ignored === undefined ? {} : { ignored }),
    config: {
      version: 1,
      sandbox: {
        mode: data.sandbox?.mode ?? 'auto',
        ...(data.sandbox?.wslDistro === undefined ? {} : { wslDistro: data.sandbox.wslDistro }),
        ...(data.sandbox?.gateway === undefined ? {} : { gateway: data.sandbox.gateway }),
      },
      gemini: {
        model: data.gemini?.model ?? DEFAULT_GEMINI_MODEL,
        dailyCallLimit: data.gemini?.dailyCallLimit ?? DEFAULT_DAILY_LIMIT,
        maxInputChars: data.gemini?.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS,
        maxOutputTokens: data.gemini?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      },
    },
  };
}
