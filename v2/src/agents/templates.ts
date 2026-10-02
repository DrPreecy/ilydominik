import type { Purpose } from '../domain/types.ts';

export const BLOCK_BEGIN = '<!-- cws:begin -->';
export const BLOCK_END = '<!-- cws:end -->';
export const GENERATED_MARK = '<!-- cws-generated -->';

export interface PurposeInfo {
  purpose: Purpose;
  description: string;
}

/** The shared protocol, written once to AGENTS.md. */
export function agentsBlock(purposes: readonly PurposeInfo[]): string {
  const list = purposes.map((p) => `   - \`${p.purpose}\` — ${p.description}`).join('\n');
  return [
    BLOCK_BEGIN,
    '## Cognitive Work System (cws)',
    '',
    'This project uses CWS: a human-led, event-sourced memory of notes, claims, evidence and decisions.',
    'The human decides; you analyse, structure and recommend.',
    '',
    '### Protocol for any AI assistant',
    '',
    '1. Start with `cws status` to see the phase, open risks and next step.',
    '2. Before helping with thinking or project work, run `cws context <purpose>` and follow what it prints. Purposes:',
    list,
    '3. Record only through the commands that output lists, always with `--agent <your-name>` (copilot, claude, gemini, ...).',
    '4. You never record facts, user statements, decisions, status changes or phase changes directly.',
    '   Propose them instead: `cws propose --agent <your-name> --json -` (the human reviews with `cws review`).',
    '   Never run human commands (decide, accept, confirm, mark, phase, review, session); suggest them to the user.',
    '5. When the user shares raw thoughts, save them verbatim with `cws dump --agent <your-name>`.',
    BLOCK_END,
  ].join('\n');
}

export function claudeBlock(): string {
  return [BLOCK_BEGIN, '@AGENTS.md', BLOCK_END].join('\n');
}

export function geminiBlock(): string {
  return [BLOCK_BEGIN, 'This project uses CWS. Read and follow AGENTS.md.', BLOCK_END].join('\n');
}

function instruction(purpose: Purpose, agent: string): string {
  return (
    `Run \`cws context ${purpose}\` in the terminal and follow the instructions it prints, using that project context. ` +
    `Record results only with the commands it lists, with \`--agent ${agent}\`.`
  );
}

export function claudeCommand(p: PurposeInfo): string {
  return `---\ndescription: ${p.description}\n---\n${GENERATED_MARK}\n${instruction(p.purpose, 'claude')}\n\nUser input: $ARGUMENTS\n`;
}

export function copilotPrompt(p: PurposeInfo): string {
  const desc = p.description.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `---\ndescription: "${desc}"\nagent: agent\n---\n${GENERATED_MARK}\n${instruction(p.purpose, 'copilot')}\n\nUser input: \${input:topic}\n`;
}

export function geminiWorkflow(p: PurposeInfo): string {
  return `---\ndescription: ${p.description}\n---\n${GENERATED_MARK}\n${instruction(p.purpose, 'gemini')}\n`;
}
