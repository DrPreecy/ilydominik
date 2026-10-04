import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { scripts } = manifest;

test('root package is the canonical cws package', () => {
  assert.equal(manifest.name, 'cws');
  assert.deepEqual(manifest.bin, { cws: 'dist/cli/main.js' });
  assert.equal(manifest.files.includes('dist'), true);
  assert.equal(manifest.files.includes('prompts'), true);
});

test('root verification commands target root implementation directly', () => {
  assert.equal(scripts.build, 'tsc -p tsconfig.build.json');
  assert.equal(scripts.typecheck, 'tsc --noEmit');
  assert.equal(scripts.coverage, 'c8 --reporter=text --check-coverage --lines 80 --functions 80 --branches 75 npm test');
  assert.equal(
    scripts['verify:repo'],
    'node scripts/check-repo-structure.mjs && corepack pnpm@10.34.6 install --frozen-lockfile --lockfile-only',
  );
  assert.match(scripts.verify, /npm run verify:repo/);
});

test('root CLI launches source without nested package paths', () => {
  assert.equal(scripts.cws, 'node --import tsx src/cli/main.ts');
  for (const [name, command] of Object.entries(scripts)) {
    assert.equal(command.includes('npm --prefix'), false, name);
    assert.equal(command.includes('--dir'), false, name);
    assert.equal(command.includes('v2/'), false, name);
    assert.equal(command.includes('v2\\'), false, name);
  }
});
