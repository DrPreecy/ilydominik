/** Red-team witnesses for src/agents/install.ts (agents-prompts). RED = defect. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { upsertBlock } from '../../../src/agents/install.ts';
import { BLOCK_BEGIN, BLOCK_END } from '../../../src/agents/templates.ts';

const block = (body: string): string => [BLOCK_BEGIN, body, BLOCK_END].join('\n');

describe('upsertBlock', () => {
  it('is idempotent', () => {
    const once = upsertBlock('# mine\n', block('v1'));
    assert.equal(upsertBlock(once, block('v1')), once);
  });

  it('a BEGIN marker whose END was deleted does not leave a second cws block behind', () => {
    const damaged = `# mine\n\n${BLOCK_BEGIN}\nold rules\n`;
    const out = upsertBlock(damaged, block('new'));
    assert.equal(out.split(BLOCK_BEGIN).length - 1, 1, 'two BEGIN markers: the stale protocol text stays and agents read both');
  });

  it('a user paragraph that quotes the END marker before the block is not swallowed', () => {
    const existing = `${BLOCK_END} quoted in prose\n\n${block('old')}\n\nuser tail\n`;
    const out = upsertBlock(existing, block('new'));
    assert.ok(out.includes('user tail'));
    assert.ok(out.startsWith(`${BLOCK_END} quoted in prose`));
  });

  it('a quoted BEGIN marker later in the file does not hijack the replacement', () => {
    const existing = `${block('old')}\n\nDocs: wrap rules in ${BLOCK_BEGIN} ... ${BLOCK_END}\n`;
    const out = upsertBlock(existing, block('new'));
    assert.ok(!out.includes('old'), 'the real block was left stale: lastIndexOf matched the BEGIN text quoted in the docs line instead');
  });
});
