import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('root verification commands target the canonical implementation', () => {
  assert.equal(scripts.build, 'npm --prefix v2 run build');
  assert.equal(scripts.typecheck, 'npm --prefix v2 run typecheck');
  assert.equal(scripts.coverage, 'npm --prefix v2 run coverage');
  assert.equal(scripts.test, 'npm --prefix v2 test && node --test tests/entrypoint.test.mjs');
});

test('root CLI launches canonical source without changing the project directory', () => {
  assert.equal(scripts.cws, 'node --import tsx v2/src/cli/main.ts');
});

test('historical implementation remains explicitly buildable and testable', () => {
  assert.equal(scripts['legacy:build'], 'tsc');
  assert.equal(scripts['legacy:typecheck'], 'tsc --noEmit');
  assert.equal(scripts['legacy:test'], 'node --test --import tsx "tests/**/*.test.ts"');
});