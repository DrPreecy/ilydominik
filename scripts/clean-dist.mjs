#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const target = path.resolve(root, 'dist');

if (target !== path.join(root, 'dist')) {
  throw new Error(`Refusing to clean unexpected path: ${target}`);
}

fs.rmSync(target, { recursive: true, force: true });
