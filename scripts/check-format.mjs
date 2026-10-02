#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const write = process.argv.includes('--write');
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', 'archive', '.cws', 'sessions']);
const textExts = new Set(['.js', '.mjs', '.ts', '.json', '.md', '.yml', '.yaml', '.toml']);
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!textExts.has(path.extname(entry.name))) continue;
    checkFile(full);
  }
}

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

walk(root);

if (failures.length) {
  console.error('Formatting issues found. Run `npm run format`.');
  for (const file of failures) console.error(`- ${file}`);
  process.exitCode = 1;
}
