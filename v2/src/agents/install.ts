import fs from 'node:fs/promises';
import path from 'node:path';
import { PURPOSES } from '../domain/types.ts';
import { loadPromptTemplate } from '../guidance/render.ts';
import {
  BLOCK_BEGIN,
  BLOCK_END,
  GENERATED_MARK,
  agentsBlock,
  claudeBlock,
  claudeCommand,
  copilotPrompt,
  geminiBlock,
  geminiWorkflow,
  type PurposeInfo,
} from './templates.ts';

export const AGENT_TARGETS = ['agents-md', 'claude', 'copilot', 'gemini'] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];

export interface InstallResult {
  written: string[];
  skipped: string[];
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

/** Insert or replace the cws block, keeping everything else the user wrote. */
export function upsertBlock(existing: string | null, block: string): string {
  if (existing === null || existing.trim() === '') return `${block}\n`;
  const start = existing.lastIndexOf(BLOCK_BEGIN);
  const end = start === -1 ? -1 : existing.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) return existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

async function writeBlockFile(root: string, rel: string, block: string, out: InstallResult): Promise<void> {
  const file = path.join(root, rel);
  await writeFile(file, upsertBlock(await readIfExists(file), block));
  out.written.push(rel);
}

/** Wrapper files are ours only if they carry the marker; a hand-written file is never touched. */
async function writeWrapper(root: string, rel: string, content: string, out: InstallResult): Promise<void> {
  const file = path.join(root, rel);
  const existing = await readIfExists(file);
  if (existing !== null && !existing.includes(GENERATED_MARK)) {
    out.skipped.push(rel);
    return;
  }
  await writeFile(file, content);
  out.written.push(rel);
}

async function purposeInfos(): Promise<PurposeInfo[]> {
  return Promise.all(
    PURPOSES.map(async (purpose) => ({ purpose, description: (await loadPromptTemplate(purpose)).description })),
  );
}

type Wrapper = (p: PurposeInfo) => string;

async function writeWrappers(root: string, infos: PurposeInfo[], dir: string, name: (p: string) => string, build: Wrapper, out: InstallResult): Promise<void> {
  for (const info of infos) await writeWrapper(root, `${dir}/${name(info.purpose)}`, build(info), out);
}

export async function installAgents(rootDir: string, opts: { targets?: AgentTarget[] } = {}): Promise<InstallResult> {
  const targets = new Set<AgentTarget>(opts.targets ?? AGENT_TARGETS);
  const infos = await purposeInfos();
  const out: InstallResult = { written: [], skipped: [] };
  const cws = (p: string): string => `cws-${p}.md`;

  if (targets.has('agents-md')) await writeBlockFile(rootDir, 'AGENTS.md', agentsBlock(infos), out);
  if (targets.has('claude')) {
    await writeBlockFile(rootDir, 'CLAUDE.md', claudeBlock(), out);
    await writeWrappers(rootDir, infos, '.claude/commands', cws, claudeCommand, out);
  }
  if (targets.has('copilot')) {
    await writeWrappers(rootDir, infos, '.github/prompts', (p) => `cws-${p}.prompt.md`, copilotPrompt, out);
  }
  if (targets.has('gemini')) {
    await writeBlockFile(rootDir, 'GEMINI.md', geminiBlock(), out);
    await writeWrappers(rootDir, infos, '.agent/workflows', cws, geminiWorkflow, out);
  }
  return out;
}
