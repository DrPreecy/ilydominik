import { randomUUID } from 'node:crypto';
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

function assertContained(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`agent install destination is outside the project: ${file}`);
  }
}

async function assertSafeDestination(root: string, file: string): Promise<void> {
  assertContained(root, file);
  const parts = path.relative(root, file).split(path.sep);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`agent install refuses symbolic link ancestry: ${current}`);
      assertContained(root, await fs.realpath(current));
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function writeFile(root: string, file: string, content: string): Promise<void> {
  await assertSafeDestination(root, file);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await assertSafeDestination(root, file);
  const temporary = path.join(path.dirname(file), `.cws-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await assertSafeDestination(root, file);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
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
  await assertSafeDestination(root, file);
  await writeFile(root, file, upsertBlock(await readIfExists(file), block));
  out.written.push(rel);
}

/** Wrapper files are ours only if they carry the marker; a hand-written file is never touched. */
async function writeWrapper(root: string, rel: string, content: string, out: InstallResult): Promise<void> {
  const file = path.join(root, rel);
  await assertSafeDestination(root, file);
  const existing = await readIfExists(file);
  if (existing !== null && !existing.includes(GENERATED_MARK)) {
    out.skipped.push(rel);
    return;
  }
  await writeFile(root, file, content);
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
  if ((await fs.lstat(rootDir)).isSymbolicLink()) throw new Error('agent install root must not be a symbolic link');
  const root = await fs.realpath(rootDir);
  const targets = new Set<AgentTarget>(opts.targets ?? AGENT_TARGETS);
  const infos = await purposeInfos();
  const out: InstallResult = { written: [], skipped: [] };
  const cws = (p: string): string => `cws-${p}.md`;

  if (targets.has('agents-md')) await writeBlockFile(root, 'AGENTS.md', agentsBlock(infos), out);
  if (targets.has('claude')) {
    await writeBlockFile(root, 'CLAUDE.md', claudeBlock(), out);
    await writeWrappers(root, infos, '.claude/commands', cws, claudeCommand, out);
  }
  if (targets.has('copilot')) {
    await writeWrappers(root, infos, '.github/prompts', (p) => `cws-${p}.prompt.md`, copilotPrompt, out);
  }
  if (targets.has('gemini')) {
    await writeBlockFile(root, 'GEMINI.md', geminiBlock(), out);
    await writeWrappers(root, infos, '.agent/workflows', cws, geminiWorkflow, out);
  }
  return out;
}
