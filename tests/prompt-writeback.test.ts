import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentsBlock, claudeCommand, copilotPrompt } from '../src/agents/templates.ts';
import { PURPOSES } from '../src/domain/types.ts';
import { loadPromptTemplate } from '../src/guidance/render.ts';

describe('prompt write-back shell safety', () => {
  it('uses stdin for note and proposal text, never quoted dynamic shell arguments', async () => {
    const purposes = PURPOSES.map((purpose) => ({ purpose, description: purpose }));
    const corpus = [
      agentsBlock(purposes),
      ...purposes.flatMap((purpose) => [claudeCommand(purpose), copilotPrompt(purpose)]),
      ...(await Promise.all(PURPOSES.map(async (purpose) => (await loadPromptTemplate(purpose)).body))),
    ].join('\n');

    assert.match(corpus, /cws dump --agent <your-name> -/);
    assert.match(corpus, /cws propose --agent <your-name> --json -/);
    assert.match(corpus, /quoted heredoc/);
    assert.doesNotMatch(corpus, /cws dump[^\n`]*"<(?:exact words|the user's exact words)>"/);
    assert.doesNotMatch(corpus, /cws (?:claim add|evidence add)[^\n`]*--text\s+"/);
    assert.doesNotMatch(corpus, /"[^"\n]*\$(?:ARGUMENTS|\{input:topic\})[^"\n]*"/);
  });
});
