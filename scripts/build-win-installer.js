#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageJson = require(path.join(projectRoot, 'package.json'));
const version = packageJson.version;
const bundleRoot = projectRoot;
const sourceRoot = path.join(projectRoot, 'native-installer');
const iconPath = path.join(sourceRoot, 'faceit-mods.ico');
const buildRoot = path.join(projectRoot, 'dist', `win-installer-build-${version}`);
const outputName = `FACEIT-Extension-Loader-Setup-${version}-x64.exe`;
const output = path.join(projectRoot, 'dist', outputName);
const currentOutput = path.join(projectRoot, 'dist', 'FACEIT-Extension-Loader-Setup-x64.exe');
const payloadHeader = path.join(buildRoot, 'payload_manifest.h');
const resourceScript = path.join(buildRoot, 'installer.rc');
const resourceObject = path.join(buildRoot, 'installer-resources.o');

main();

function main() {
  fs.rmSync(buildRoot, { recursive: true, force: true });
  fs.mkdirSync(buildRoot, { recursive: true });
  try {
    const files = listPayloadFiles(bundleRoot);
    writePayloadHeader(files);
    writeResourceScript(files);
    run('x86_64-w64-mingw32-windres', ['--codepage=65001', '-I', buildRoot, resourceScript, '-O', 'coff', '-o', resourceObject]);
    run('x86_64-w64-mingw32-gcc', [
      '-std=c11', '-Os', '-Wall', '-Wextra', '-Werror', '-municode', '-mwindows', '-static', '-s',
      ...(process.env.FACEIT_INSTALLER_CAPTURE === '1' ? ['-DFACEIT_INSTALLER_CAPTURE'] : []),
      '-I', buildRoot,
      path.join(sourceRoot, 'installer.c'), resourceObject,
      '-o', output,
      '-lcomctl32', '-ldwmapi', '-lshell32', '-lshlwapi', '-luxtheme', '-ladvapi32', '-lole32', '-lgdi32',
    ]);
    fs.copyFileSync(output, currentOutput);

    const digest = sha256(fs.readFileSync(output));
    fs.writeFileSync(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
    fs.writeFileSync(`${currentOutput}.sha256`, `${digest}  ${path.basename(currentOutput)}\n`);
    console.log(JSON.stringify({
      output,
      currentOutput,
      payloadFiles: files.length,
      sha256: digest,
      size: fs.statSync(output).size,
      version,
    }, null, 2));
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

function listPayloadFiles(root) {
  const includedRoots = new Set([
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.md',
    'bin',
    'mod',
    'node_modules',
    'package-lock.json',
    'package.json',
    'src',
  ]);
  const files = [];
  walk(root, '');
  return files.sort((left, right) => left.relative.localeCompare(right.relative));

  function walk(absolute, relative) {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const topLevel = childRelative.split(path.sep)[0];
      if (!includedRoots.has(topLevel)) continue;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isDirectory()) walk(childAbsolute, childRelative);
      else if (entry.isFile()) {
        files.push({ absolute: childAbsolute, relative: childRelative, size: fs.statSync(childAbsolute).size });
      }
    }
  }
}

function writePayloadHeader(files) {
  const entries = files.map((file, index) => {
    const resourceId = 1000 + index;
    return `  { ${resourceId}, L"${escapeCString(file.relative.split(path.sep).join('\\'))}", ${file.size}ULL },`;
  });
  fs.writeFileSync(payloadHeader, [
    '#pragma once',
    '',
    `#define APP_TITLE L"FACEIT Extension Loader Setup"`,
    `#define APP_VERSION L"${escapeCString(version)}"`,
    `#define PAYLOAD_COUNT ${files.length}`,
    '',
    'static const PayloadEntry PAYLOAD[PAYLOAD_COUNT] = {',
    ...entries,
    '};',
    '',
  ].join('\n'));
}

function writeResourceScript(files) {
  const numericVersion = getNumericVersion(version);
  const resources = files.map((file, index) => `${1000 + index} RCDATA "${escapeRcPath(file.absolute)}"`);
  const manifestPath = escapeRcPath(path.join(sourceRoot, 'installer.manifest'));
  fs.writeFileSync(resourceScript, [
    '#include <windows.h>',
    '',
    `1 RT_MANIFEST "${manifestPath}"`,
    `1 ICON "${escapeRcPath(iconPath)}"`,
    '1 VERSIONINFO',
    `FILEVERSION ${numericVersion.join(',')}`,
    `PRODUCTVERSION ${numericVersion.join(',')}`,
    'FILEFLAGSMASK 0x3fL',
    'FILEFLAGS 0x0L',
    'FILEOS 0x40004L',
    'FILETYPE 0x1L',
    'FILESUBTYPE 0x0L',
    'BEGIN',
    '  BLOCK "StringFileInfo"',
    '  BEGIN',
    '    BLOCK "040904b0"',
    '    BEGIN',
    '      VALUE "CompanyName", "Dimitrymas\\0"',
    '      VALUE "FileDescription", "FACEIT Extension Loader Setup (unofficial)\\0"',
    `      VALUE "FileVersion", "${version}\\0"`,
    '      VALUE "InternalName", "FACEITExtensionLoaderSetup\\0"',
    `      VALUE "OriginalFilename", "${path.basename(output)}\\0"`,
    '      VALUE "ProductName", "FACEIT Extension Loader Setup\\0"',
    `      VALUE "ProductVersion", "${version}\\0"`,
    '    END',
    '  END',
    '  BLOCK "VarFileInfo"',
    '  BEGIN',
    '    VALUE "Translation", 0x409, 1200',
    '  END',
    'END',
    '',
    ...resources,
    '',
  ].join('\n'));
}

function getNumericVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/);
  if (!match) throw new Error(`Unsupported installer version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] || 0)];
}

function escapeCString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRcPath(value) {
  return String(value).replace(/\\/g, '/').replace(/"/g, '\\"');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${result.stdout || ''}${result.stderr || ''}`);
  }
}
