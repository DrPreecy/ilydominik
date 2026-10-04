import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const workflow = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
const regularPatterns = [...packageJson.scripts.test.matchAll(/"(tests\/[^"]+\.test\.(?:ts|mjs))"/g)]
  .map((match) => match[1]);
const witnessPatterns = [...workflow.matchAll(/'(tests\/[^']+\.test\.(?:ts|mjs))'/g)]
  .map((match) => match[1]);

function listTests(directory = 'tests') {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return listTests(relative);
    return /\.test\.(?:ts|mjs)$/.test(entry.name) ? [relative] : [];
  });
}

test('every test file is included in the regular suite or the witness job', () => {
  const uncovered = listTests().filter((file) => {
    const patterns = file.startsWith('tests/redteam')
      ? witnessPatterns
      : regularPatterns;
    return !patterns.some((pattern) => path.matchesGlob(file, pattern));
  });

  assert.deepEqual(uncovered, [], `test files are not run by CI: ${uncovered.join(', ')}`);
  assert.ok(regularPatterns.length > 0, 'regular test command must declare test-file globs');
  assert.ok(witnessPatterns.length > 0, 'witness job must declare test-file globs');
});
