#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || '');
const included = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'bin',
  'mod',
  'node_modules',
  'package-lock.json',
  'package.json',
  'src',
];

if (!process.argv[2]) {
  throw new Error('Pass the stable FACEIT Mods payload directory');
}
if (destination === projectRoot || destination.startsWith(`${projectRoot}${path.sep}`)) {
  throw new Error('The update-hook payload destination must be outside the source bundle');
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const relative of included) {
  const source = path.join(projectRoot, relative);
  const target = path.join(destination, relative);
  fs.cpSync(source, target, { recursive: true });
}

console.log(`Installed update-hook payload: ${destination}`);
