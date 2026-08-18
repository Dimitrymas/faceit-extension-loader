#!/usr/bin/env node

if (process.versions.electron) process.noAsar = true;

const { parseArgs } = require('node:util');
const {
  MOD_VERSION,
  inspectAsar,
  patchFaceitAsar,
  resolveAsarPath,
  restoreOriginalAsar,
} = require('../src/patcher');

async function main() {
  const args = parseArgs({
    allowPositionals: true,
    options: {
      target: { type: 'string', short: 't' },
      dryRun: { type: 'boolean' },
      force: { type: 'boolean', short: 'f' },
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
    },
  });

  const [command = 'patch', positionalTarget] = args.positionals;
  const target = args.values.target || positionalTarget;

  if (args.values.help) {
    printHelp();
    return;
  }

  if (command === 'version') {
    console.log(MOD_VERSION);
    return;
  }

  if (command === 'inspect') {
    const asarPath = resolveAsarPath(target);
    const inspection = inspectAsar(asarPath);
    if (args.values.json) {
      console.log(JSON.stringify(inspection, null, 2));
      return;
    }
    printInspection(inspection);
    return;
  }

  if (command === 'restore') {
    const result = restoreOriginalAsar({ target });
    for (const restored of result.restored || [result]) {
      console.log(`Restored ${restored.asarPath} from ${restored.backupPath}`);
    }
    return;
  }

  if (command !== 'patch') {
    throw new Error(`Unknown command: ${command}`);
  }

  const result = await patchFaceitAsar({
    target,
    dryRun: args.values.dryRun,
    force: args.values.force,
  });

  if (args.values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!result.changed) {
    console.log(`Already patched: ${result.asarPath}`);
    console.log(`Mod version: ${result.applied && result.applied.version ? result.applied.version : 'unknown'}`);
    return;
  }

  if (result.dryRun) {
    console.log(`Dry run OK: ${result.asarPath}`);
    console.log(`Would set package.json main to ${result.patchedMain}`);
    return;
  }

  console.log(`Patched: ${result.asarPath}`);
  console.log(`Backup:  ${result.backupPath}`);
  console.log(`Main:    ${result.originalMain} -> ${result.patchedMain}`);
}

function printInspection(inspection) {
  console.log(`asar:    ${inspection.asarPath}`);
  console.log(`name:    ${inspection.packageName || '(unknown)'}`);
  console.log(`version: ${inspection.packageVersion || '(unknown)'}`);
  console.log(`main:    ${inspection.main || '(unknown)'}`);
  if (inspection.applied) {
    console.log(`mod:     ${inspection.applied.name || 'faceit-extension-loader'} ${inspection.applied.version || '(unknown)'}`);
  } else {
    console.log('mod:     not applied');
  }
}

function printHelp() {
  console.log(`faceit-extension-loader ${MOD_VERSION}

Usage:
  faceit-extension-loader patch [target]
  faceit-extension-loader inspect [target]
  faceit-extension-loader restore [target]
  faceit-extension-loader version

Target may be:
  - FACEIT install root containing app-* directories
  - a specific app-* directory
  - a resources directory containing app.asar
  - an app.asar file

On Windows, if target is omitted, %LOCALAPPDATA%\\FACEIT is used.

Options:
  -t, --target <path>  Explicit target path
  -f, --force          Reapply even when the marker already exists
      --dryRun         Extract and validate without writing
      --json           Print machine-readable output
  -h, --help           Show this help
`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
