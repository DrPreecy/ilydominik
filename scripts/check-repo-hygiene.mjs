#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const canonicalDirectories = new Set([
  '.agents',
  '.devcontainer',
  '.github',
  '.vscode',
  'archive',
  'docs',
  'prompts',
  'scripts',
  'src',
  'tests',
  'web',
]);
const canonicalRootFiles = new Set([
  '.firebaserc',
  '.gitattributes',
  '.gitignore',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'firebase.json',
  'firestore.indexes.json',
  'firestore.rules',
  'package.json',
  'pnpm-lock.yaml',
  'starttoughts.md',
  'tsconfig.build.json',
  'tsconfig.json',
  'tsconfig.redteam.json',
]);

function gitFiles(args) {
  return execFileSync('git', ['ls-files', ...args, '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, '/'));
}

const trackedFiles = gitFiles(['--cached']);
for (const file of gitFiles(['--cached', '--ignored', '--exclude-standard'])) {
  failures.push(`tracked file matches .gitignore: ${file}`);
}

for (const file of trackedFiles) {
  const [topLevel] = file.split('/');
  if (file.includes('/') ? !canonicalDirectories.has(topLevel) : !canonicalRootFiles.has(file)) {
    failures.push(`tracked path is outside the canonical layout: ${file}`);
  }

  const segments = file.toLowerCase().split('/');
  const base = path.posix.basename(file).toLowerCase();
  if (
    /^(?:\.env.*|.*\.log)$/.test(base) ||
    base === 'firebase-debug.log' ||
    segments.some((segment) => ['coverage', 'dist', '.cws'].includes(segment))
  ) {
    failures.push(`generated or secret material is tracked: ${file}`);
  }

  if (file.startsWith('tests/') && !isTestOrSupport(file)) {
    failures.push(`test file has no test or helper/fixture purpose: ${file}`);
  }
}

function isTestOrSupport(file) {
  if (/\.test\.[^/]+$/.test(file)) return true;
  const parts = file.toLowerCase().split('/');
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '').toLowerCase();
  return parts.some((part) => /^(?:helpers?|fixtures?)$/.test(part)) ||
    /(?:^|[-_])(?:helpers?|fixtures?|harness|util|worker|data|env)(?:[-_.]|$)/.test(base);
}

if (failures.length) {
  console.error('Repo hygiene check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Repo hygiene check passed.');
