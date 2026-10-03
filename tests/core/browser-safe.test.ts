import assert from 'node:assert/strict';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';

const rootDir = process.cwd();
const coreEntry = path.join(rootDir, 'src', 'core', 'index.ts');

function resolveImport(sourceFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = path.dirname(sourceFile);
  let target = path.resolve(dir, specifier);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  if (!path.extname(target)) {
    for (const ext of ['.ts', '.js', '/index.ts', '/index.js']) {
      if (fs.existsSync(target + ext)) return target + ext;
    }
  }
  return target;
}

function extractImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const importPattern = /(?:import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  const specifiers: string[] = [];
  for (const match of content.matchAll(importPattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function collectDependencyFiles(entryFile: string): { files: Set<string>; importsByFile: Map<string, string[]> } {
  const visited = new Set<string>();
  const importsByFile = new Map<string, string[]>();

  function traverse(file: string) {
    if (visited.has(file)) return;
    visited.add(file);
    const specifiers = extractImports(file);
    importsByFile.set(file, specifiers);
    for (const specifier of specifiers) {
      const resolved = resolveImport(file, specifier);
      if (resolved && fs.existsSync(resolved)) {
        traverse(resolved);
      }
    }
  }

  traverse(entryFile);
  return { files: visited, importsByFile };
}

test('core entrypoint src/core/index.ts must exist', () => {
  assert.equal(fs.existsSync(coreEntry), true, 'src/core/index.ts must exist');
});

test('package.json exports "." and "./core"', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  assert.ok(pkg.exports, 'package.json must have exports field');
  assert.equal(pkg.exports['.'], './dist/cli/main.js');
  assert.equal(pkg.exports['./core'], './dist/core/index.js');
});

test('no file reachable from src/core/index.ts imports node builtins', () => {
  assert.equal(fs.existsSync(coreEntry), true, 'src/core/index.ts must exist before dependency scan');
  const { files, importsByFile } = collectDependencyFiles(coreEntry);
  assert.ok(files.size > 0, 'must have reachable files from core entry');

  const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const violations: { file: string; specifier: string }[] = [];

  for (const [file, specifiers] of importsByFile.entries()) {
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:') || nodeBuiltins.has(specifier)) {
        violations.push({ file: path.relative(rootDir, file).replace(/\\/g, '/'), specifier });
      }
    }
  }

  assert.deepEqual(violations, [], `Browser-safe core bundle must not import node builtins, but found: ${JSON.stringify(violations)}`);
});

test('newId generates format prefix_12hex without node:crypto', async () => {
  const { newId } = await import('../../src/domain/ids.ts');
  const id1 = newId('claim');
  const id2 = newId('claim');
  assert.match(id1, /^claim_[0-9a-f]{12}$/);
  assert.match(id2, /^claim_[0-9a-f]{12}$/);
  assert.notEqual(id1, id2);
});

test('core re-exports fold, reduce, schemas, assess, nextSteps, verifyChain, PHASES, and types', async () => {
  assert.equal(fs.existsSync(coreEntry), true, 'src/core/index.ts must exist');
  const core = await import('../../src/core/index.ts');
  assert.equal(typeof core.fold, 'function', 'core must export fold');
  assert.equal(typeof core.reduce, 'function', 'core must export reduce');
  assert.equal(typeof core.assess, 'function', 'core must export assess');
  assert.equal(typeof core.nextSteps, 'function', 'core must export nextSteps');
  assert.equal(typeof core.verifyChain, 'function', 'core must export verifyChain');
  assert.equal(Array.isArray(core.PHASES), true, 'core must export PHASES array');
  assert.equal(typeof core.parseEventInput, 'function', 'core must export parseEventInput');
  assert.equal(typeof core.parseStoredEvent, 'function', 'core must export parseStoredEvent');
});

test('verifyChain validates valid event chains and detects corruption', async () => {
  const { computeEventHash, verifyChain, GENESIS_HASH, canonicalEventString } = await import('../../src/domain/hash.ts');
  assert.equal(typeof verifyChain, 'function');
  assert.equal(typeof GENESIS_HASH, 'string');

  const emptyResult = await verifyChain([]);
  assert.deepEqual(emptyResult, { ok: true });

  const body0 = {
    v: 1 as const,
    seq: 0,
    id: 'ev_000000000001',
    at: '2026-10-03T12:00:00.000Z',
    type: 'PROJECT_CREATED' as const,
    actor: { kind: 'human' as const },
    payload: { projectId: 'prj_000000000001', title: 'Test Project' },
    prevHash: GENESIS_HASH,
  };
  const hash0 = await computeEventHash(body0);
  const ev0 = { ...body0, hash: hash0 };

  const body1 = {
    v: 1 as const,
    seq: 1,
    id: 'ev_000000000002',
    at: '2026-10-03T12:01:00.000Z',
    type: 'NOTE_ADDED' as const,
    actor: { kind: 'human' as const },
    payload: { noteId: 'note_000000000001', text: 'A note' },
    prevHash: hash0,
  };
  const hash1 = await computeEventHash(body1);
  const ev1 = { ...body1, hash: hash1 };

  const validResult = await verifyChain([ev0, ev1]);
  assert.deepEqual(validResult, { ok: true });

  // Tampered payload in ev1
  const tamperedPayload = [{ ...ev0 }, { ...ev1, payload: { noteId: 'note_000000000001', text: 'Tampered note' } }];
  const tamperedResult = await verifyChain(tamperedPayload);
  assert.deepEqual(tamperedResult, { ok: false, brokenAtSeq: 1 });

  // Tampered prevHash in ev1
  const tamperedPrev = [{ ...ev0 }, { ...ev1, prevHash: 'f'.repeat(64) }];
  const tamperedPrevResult = await verifyChain(tamperedPrev);
  assert.deepEqual(tamperedPrevResult, { ok: false, brokenAtSeq: 1 });

  // Canonical string is deterministic regardless of object key order
  const shuffledBody = {
    payload: body0.payload,
    prevHash: body0.prevHash,
    actor: body0.actor,
    type: body0.type,
    at: body0.at,
    id: body0.id,
    seq: body0.seq,
    v: body0.v,
  };
  assert.equal(canonicalEventString(shuffledBody), canonicalEventString(body0));
});
