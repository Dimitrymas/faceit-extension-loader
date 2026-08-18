#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const packageJson = require(path.join(projectRoot, 'package.json'));
const bundleName = 'faceit-extension-loader-win-portable';
const versionedStagingRoot = path.join(distRoot, `win-portable-staging-${packageJson.version}`);
const versionedBundle = path.join(versionedStagingRoot, bundleName);
const currentStagingRoot = path.join(distRoot, 'win-portable-staging');
const currentBundle = path.join(currentStagingRoot, bundleName);
const versionedZip = path.join(distRoot, `${bundleName}-${packageJson.version}.zip`);
const currentZip = path.join(distRoot, `${bundleName}.zip`);

const directorySources = ['bin', 'examples', 'mod', 'node_modules', 'scripts', 'src', 'test'];
const fileSources = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json'];

main();

function main() {
  fs.mkdirSync(distRoot, { recursive: true });
  try {
    prepareBundle(versionedBundle);
    replaceDirectory(currentBundle, versionedBundle);
    createZip(versionedStagingRoot, versionedZip);
    fs.copyFileSync(versionedZip, currentZip);

    console.log(JSON.stringify({
      version: packageJson.version,
      zip: versionedZip,
      currentZip,
    }, null, 2));
  } finally {
    fs.rmSync(versionedStagingRoot, { recursive: true, force: true });
    fs.rmSync(currentStagingRoot, { recursive: true, force: true });
  }
}

function prepareBundle(destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  for (const directory of directorySources) {
    fs.cpSync(path.join(projectRoot, directory), path.join(destination, directory), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.git${path.sep}`),
    });
  }
  for (const file of fileSources) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(destination, file));
  }

  fs.copyFileSync(
    path.join(projectRoot, 'windows-portable', 'README-WINDOWS.txt'),
    path.join(destination, 'README-WINDOWS.txt'),
  );
  for (const entry of fs.readdirSync(path.join(projectRoot, 'windows-portable'))) {
    if (entry.toLowerCase().endsWith('.bat')) {
      fs.copyFileSync(path.join(projectRoot, 'windows-portable', entry), path.join(destination, entry));
    }
  }

  const nodeDir = path.join(destination, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  installNodeExecutable(nodeDir);
  copyNodeLicense(nodeDir);
}

function copyNodeLicense(nodeDir) {
  const archives = fs.readdirSync(path.join(projectRoot, 'downloads'))
    .filter((entry) => /^node-v.*-win-x64\.zip$/i.test(entry))
    .sort()
    .reverse();
  const archive = archives[0] && path.join(projectRoot, 'downloads', archives[0]);
  if (!archive) throw new Error('The Node.js Windows archive was not found under downloads');
  const listing = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`Could not inspect the Node.js archive: ${listing.stderr || listing.stdout}`);
  const licenseEntry = listing.stdout.split(/\r?\n/).find((entry) => /^[^/]+\/LICENSE$/.test(entry));
  if (!licenseEntry) throw new Error('The Node.js archive does not contain its root LICENSE file');
  const license = spawnSync('unzip', ['-p', archive, licenseEntry]);
  if (license.status !== 0) throw new Error('Could not extract the Node.js LICENSE file');
  fs.writeFileSync(path.join(nodeDir, 'LICENSE'), license.stdout);
}

function replaceDirectory(destination, source) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function installNodeExecutable(nodeDir) {
  const explicit = process.env.FACEIT_LOADER_NODE_EXE;
  if (explicit && fs.existsSync(explicit)) {
    fs.copyFileSync(explicit, path.join(nodeDir, 'node.exe'));
    return;
  }
  const archive = findNodeArchive();
  const listing = spawnSync('unzip', ['-Z1', archive], { encoding: 'utf8' });
  if (listing.status !== 0) throw new Error(`Could not inspect the Node.js archive: ${listing.stderr || listing.stdout}`);
  const nodeEntry = listing.stdout.split(/\r?\n/).find((entry) => /^[^/]+\/node\.exe$/i.test(entry));
  if (!nodeEntry) throw new Error('The Node.js archive does not contain its root node.exe');
  const extraction = spawnSync('unzip', ['-p', archive, nodeEntry], {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (extraction.status !== 0) throw new Error('Could not extract node.exe from the Node.js archive');
  fs.writeFileSync(path.join(nodeDir, 'node.exe'), extraction.stdout);
}

function findNodeArchive() {
  const downloadsRoot = path.join(projectRoot, 'downloads');
  const archives = fs.readdirSync(downloadsRoot)
    .filter((entry) => /^node-v.*-win-x64\.zip$/i.test(entry))
    .sort()
    .reverse();
  if (!archives[0]) {
    throw new Error('A Node.js Windows archive was not found under downloads');
  }
  return path.join(downloadsRoot, archives[0]);
}

function createZip(stagingRoot, destination) {
  fs.rmSync(destination, { force: true });
  const result = spawnSync('zip', ['-qr', destination, bundleName], {
    cwd: stagingRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
}
