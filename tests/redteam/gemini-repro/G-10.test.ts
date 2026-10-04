import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
test('firebase web SDK is not a runtime dependency of the CLI package', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.ok(!pkg.dependencies?.firebase, 'firebase in dependencies');
});
