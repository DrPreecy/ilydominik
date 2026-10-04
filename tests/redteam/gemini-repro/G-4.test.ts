import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTool } from '../../../src/integrations/exec.ts';
test('child env must not receive GEMINI_API_KEY from parent', async () => {
  process.env.GEMINI_API_KEY = 'SECRET-xyz';
  const r = await runTool('node', ['-e', 'console.log(process.env.GEMINI_API_KEY)']);
  assert.doesNotMatch(r.stdout, /SECRET-xyz/);
});
