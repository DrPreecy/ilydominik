#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const write = process.argv.includes('--write');
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', 'archive', '.cws', 'sessions']);
const textExts = new Set(['.js', '.mjs', '.ts', '.json', '.md', '.yml', '.yaml', '.toml']);
const failures = [];

function checkFile(file) {
  const original = fs.readFileSync(file, 'utf8');
  let next = original.replace(/[ \t]+(?=\r?\n)/g, '');
  if (next.length > 0 && !next.endsWith('\n')) next += '\n';
  if (next === original) return;
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (write) {
    fs.writeFileSync(file, next);
  } else {
    failures.push(rel);
  }
}

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

for (const rel of trackedFiles) {
  const normalized = rel.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => ignoredDirs.has(part))) continue;
  if (/^docs\/review\/.+\.json$/.test(normalized)) continue;
  if (!textExts.has(path.extname(normalized))) continue;
  checkFile(path.join(root, rel));
}

if (failures.length) {
  console.error('Formatting issues found. Run `npm run format`.');
  for (const file of failures) console.error(`- ${file}`);
  process.exitCode = 1;
}
