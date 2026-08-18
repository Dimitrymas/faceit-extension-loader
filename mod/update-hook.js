'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const UPDATE_EVENT = 'update-downloaded';
const PATCH_TIMEOUT_MS = 120000;
const installedUpdaters = new WeakSet();

function installFaceitUpdateHook(options = {}) {
  const {
    autoUpdater,
    logger = console,
    platform = process.platform,
  } = options;

  if (platform !== 'win32' || !autoUpdater || typeof autoUpdater.prependListener !== 'function') {
    return false;
  }

  if (installedUpdaters.has(autoUpdater)) {
    return false;
  }

  installedUpdaters.add(autoUpdater);
  autoUpdater.prependListener(UPDATE_EVENT, () => {
    patchPendingFaceitUpdate({ ...options, logger, platform });
  });
  logger.info('registered event-driven FACEIT update patch hook');
  return true;
}

function patchPendingFaceitUpdate(options = {}) {
  const {
    env = process.env,
    execPath = process.execPath,
    fsApi = fs,
    logger = console,
    platform = process.platform,
    spawnSync = childProcess.spawnSync,
  } = options;

  if (platform !== 'win32') {
    return { attempted: false, reason: 'unsupported-platform' };
  }

  const paths = resolveUpdateHookPaths(env);
  if (!paths) {
    logger.warn('FACEIT update was downloaded, but LOCALAPPDATA is unavailable; run FACEIT Extension Loader Setup again');
    return { attempted: false, reason: 'local-app-data-unavailable' };
  }
  if (!fsApi.existsSync(paths.scriptPath)) {
    logger.warn(`FACEIT update was downloaded, but the local patch payload is missing: ${paths.scriptPath}`);
    return { attempted: false, reason: 'payload-missing', ...paths };
  }
  if (!fsApi.existsSync(paths.faceitRoot)) {
    logger.warn(`FACEIT update was downloaded, but its install root is missing: ${paths.faceitRoot}`);
    return { attempted: false, reason: 'faceit-root-missing', ...paths };
  }

  logger.info('FACEIT update downloaded; applying FACEIT Mods to the newest app version');
  let result;
  try {
    result = spawnSync(execPath, [paths.scriptPath, 'patch', paths.faceitRoot, '--json'], {
      cwd: paths.installRoot,
      encoding: 'utf8',
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: PATCH_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    logger.warn('FACEIT Mods could not start the update patch hook', error);
    return { attempted: true, patched: false, reason: 'spawn-failed', ...paths };
  }

  if (result.error || result.status !== 0) {
    const detail = compactOutput(result.stderr || result.stdout);
    logger.warn(`FACEIT Mods could not patch the downloaded update${detail ? `: ${detail}` : ''}`, result.error);
    return {
      attempted: true,
      patched: false,
      reason: result.error ? 'spawn-failed' : 'patch-failed',
      status: result.status,
      ...paths,
    };
  }

  logger.info(`FACEIT Mods applied to the downloaded update${compactOutput(result.stdout) ? `: ${compactOutput(result.stdout)}` : ''}`);
  return { attempted: true, patched: true, status: result.status, ...paths };
}

function resolveUpdateHookPaths(env = process.env) {
  const localAppData = String(env.LOCALAPPDATA || '').trim();
  if (!localAppData) return null;

  const installRoot = String(env.FACEIT_MODS_INSTALL_ROOT || '').trim()
    || path.join(localAppData, 'FACEIT Mods', 'current');
  const faceitRoot = String(env.FACEIT_MODS_FACEIT_ROOT || '').trim()
    || path.join(localAppData, 'FACEIT');
  return {
    faceitRoot,
    installRoot,
    scriptPath: path.join(installRoot, 'bin', 'faceit-extension-loader.js'),
  };
}

function compactOutput(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 800);
}

module.exports = {
  installFaceitUpdateHook,
  patchPendingFaceitUpdate,
  resolveUpdateHookPaths,
};
