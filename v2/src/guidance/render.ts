import { readFile } from 'node:fs/promises';
import type { Purpose, ProjectState } from '../domain/types.ts';
import { buildContext } from './context-pack.ts';

const PROMPTS_DIR = new URL('../../prompts/', import.meta.url);
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface PromptTemplate {
  description: string;
  body: string;
}

function parseDescription(frontmatter: string): string {
  const line = frontmatter.split(/\r?\n/).find((l) => l.startsWith('description:'));
  if (!line) return '';
  return line.slice('description:'.length).trim().replace(/^(["'])(.*)\1$/, '$2');
}

export async function loadPromptTemplate(purpose: Purpose): Promise<PromptTemplate> {
  const url = new URL(`${purpose}.md`, PROMPTS_DIR);
  let raw: string;
  try {
    raw = await readFile(url, 'utf8');
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Prompt template for "${purpose}" could not be read (${url.pathname}): ${reason}`);
  }
  const match = FRONTMATTER.exec(raw);
  if (!match) return { description: '', body: raw.trim() };
  return { description: parseDescription(match[1] ?? ''), body: (match[2] ?? '').trim() };
}

export async function renderPrompt(state: ProjectState, purpose: Purpose, focusRefs: string[] = []): Promise<string> {
  const template = await loadPromptTemplate(purpose);
  return `${template.body}\n\n---\n\n${buildContext(state, purpose, { focusRefs })}`;
}
