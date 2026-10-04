import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { incrementAiUsage, readAiUsage } from '../../../src/integrations/gemini.ts';
test('N concurrent increments must count N', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'g8-'));
  const N = 20;
  await Promise.all(Array.from({ length: N }, () => incrementAiUsage(dir)));
  assert.equal((await readAiUsage(dir)).count, N);
});
