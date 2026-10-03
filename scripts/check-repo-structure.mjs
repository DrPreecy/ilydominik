#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const root = process.cwd();
const failures = [];
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', 'archive', '.cws', 'sessions']);
const required = [
  'AGENTS.md',
  'README.md',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.build.json',
  'src/cli/main.ts',
  'tests/entrypoint.test.mjs',
  'prompts/explore.md',
  'docs/spec.md',
  '.agents/skills/repo-structure-guardian/SKILL.md',
  '.vscode/tasks.json',
];

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

for (const rel of required) {
  if (!exists(rel)) failures.push(`missing required file: ${rel}`);
}

if (exists('v2')) failures.push('forbidden nested project directory exists: v2/');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (manifest.name !== 'cws') failures.push('package.json name must be "cws"');
if (manifest.bin?.cws !== 'dist/cli/main.js') failures.push('package.json bin.cws must point at dist/cli/main.js');

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const textFiles = [];

walk(root, (file) => {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const base = path.basename(file);
  if (base === 'package.json' && rel !== 'package.json') failures.push(`nested package manifest is not allowed: ${rel}`);
  if (/^(pnpm-lock|package-lock|yarn\.lock|bun\.lockb)$/.test(base) && rel !== 'pnpm-lock.yaml') {
    failures.push(`nested or duplicate lockfile is not allowed: ${rel}`);
  }
  if (/\.(ts|js|mjs|json|md|yml|yaml)$/.test(rel)) textFiles.push({ file, rel });
});

for (const { file, rel } of textFiles) {
  const text = fs.readFileSync(file, 'utf8');
  if (rel !== 'scripts/check-repo-structure.mjs' && isActiveConfig(rel) && /npm --prefix v2|--dir v2|v2[\\/]src|v2[\\/]tests|cd v2/.test(text)) {
    failures.push(`stale nested-project command reference: ${rel}`);
  }
  if (/\.(ts|js|mjs)$/.test(rel)) checkImports(rel, text);
}

function isActiveConfig(rel) {
  return rel === 'README.md' ||
    rel === 'package.json' ||
    rel.startsWith('.github/') ||
    rel.startsWith('scripts/') ||
    rel.startsWith('tests/') ||
    rel.startsWith('src/');
}

function checkImports(rel, text) {
  const importPattern = /(?:import\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?|export\s+[^'"]+\s+from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(importPattern)) {
    const specifier = match[1];
    if (specifier.startsWith('.') || specifier.startsWith('/') || builtins.has(specifier)) continue;
    const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    if (!declared.has(pkg)) failures.push(`${rel} imports undeclared package: ${pkg}`);
  }
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, visit);
    } else {
      visit(full);
    }
  }
}

if (failures.length) {
  console.error('Repo structure check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Repo structure check passed.');
