#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const version = String(process.argv[2] || require('../package.json').version).replace(/^v/, '');
const changelog = fs.readFileSync(path.join(projectRoot, 'CHANGELOG.md'), 'utf8');
const headings = [...changelog.matchAll(/^## \[([^\]]+)\](?: - .+)?$/gm)];
const currentIndex = headings.findIndex((match) => match[1] === version);

if (currentIndex === -1) {
  throw new Error(`CHANGELOG.md does not contain a section for ${version}`);
}

const current = headings[currentIndex];
const next = headings[currentIndex + 1];
const notes = changelog.slice(current.index + current[0].length, next ? next.index : changelog.length).trim();

if (!notes) {
  throw new Error(`CHANGELOG.md contains an empty section for ${version}`);
}

process.stdout.write(`${notes}\n\n### Verification\n\n`);
process.stdout.write(`- [Code signing policy](https://github.com/AddonPort/faceit/blob/v${version}/docs/CODE_SIGNING_POLICY.md)\n`);
process.stdout.write(`- [Privacy](https://github.com/AddonPort/faceit/blob/v${version}/docs/PRIVACY.md)\n`);
