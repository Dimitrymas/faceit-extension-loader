#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

for (const relative of ['dist', 'tmp', 'coverage']) {
  fs.rmSync(path.join(projectRoot, relative), { recursive: true, force: true });
}

console.log('Removed generated build and test artifacts.');
