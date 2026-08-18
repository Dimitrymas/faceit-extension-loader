const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const {
  createPackageWithOptions,
  extractAll,
  extractFile,
  statFile,
  uncache,
} = require('@electron/asar');

const projectPackage = require('../../package.json');

const MOD_VERSION = projectPackage.version;
const PATCHED_MAIN = 'mod/bootstrap.js';
const DEFAULT_ORIGINAL_MAIN = 'main.js';
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_MOD_SOURCE = path.join(PROJECT_ROOT, 'mod');
const RUNTIME_PACKAGES = ['electron-chrome-extensions', 'yauzl'];
const NATIVE_UNPACK_GLOB = '{**/*.node,**/*.dll,**/*.exe}';

function resolveAsarPath(target) {
  return resolveAsarPaths(target)[0];
}

function resolveAsarPaths(target) {
  const resolvedTarget = target ? path.resolve(target) : defaultFaceitInstallRoot();
  if (!fs.existsSync(resolvedTarget)) {
    throw new Error(`Target does not exist: ${resolvedTarget}`);
  }

  const stat = fs.statSync(resolvedTarget);
  if (stat.isFile()) {
    if (path.basename(resolvedTarget).toLowerCase() !== 'app.asar') {
      throw new Error(`Target file is not app.asar: ${resolvedTarget}`);
    }
    return [resolvedTarget];
  }

  const directCandidates = [
    path.join(resolvedTarget, 'app.asar'),
    path.join(resolvedTarget, 'resources', 'app.asar'),
  ];

  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate)) {
      return [candidate];
    }
  }

  const appDirs = fs.readdirSync(resolvedTarget, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^app-\d/i.test(entry.name))
    .map((entry) => {
      const appDir = path.join(resolvedTarget, entry.name);
      return {
        appDir,
        asarPath: path.join(appDir, 'resources', 'app.asar'),
        mtimeMs: fs.statSync(appDir).mtimeMs,
        version: entry.name.replace(/^app-/i, ''),
      };
    })
    .filter((candidate) => fs.existsSync(candidate.asarPath))
    .sort(compareAppCandidates);

  if (appDirs.length === 0) {
    throw new Error(`Could not find resources/app.asar under: ${resolvedTarget}`);
  }

  return appDirs.map((candidate) => candidate.asarPath);
}

function defaultFaceitInstallRoot() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'FACEIT');
  }
  throw new Error('No target was provided. Pass a FACEIT install root, app-* directory, resources directory, or app.asar path.');
}

function compareAppCandidates(a, b) {
  const versionResult = compareVersionsDescending(a.version, b.version);
  if (versionResult !== 0) {
    return versionResult;
  }
  return b.mtimeMs - a.mtimeMs;
}

function compareVersionsDescending(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;
    if (leftPart !== rightPart) {
      return rightPart - leftPart;
    }
  }
  return 0;
}

function parseVersion(version) {
  return String(version)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((part) => Number(part));
}

function inspectAsar(asarPathOrTarget) {
  const asarPath = resolveAsarPath(asarPathOrTarget);
  uncacheAsar(asarPath);
  const packageJson = readAsarJson(asarPath, 'package.json');
  const applied = readAsarJson(asarPath, 'mod/.applied');
  return {
    asarPath,
    packageName: packageJson && packageJson.name,
    packageVersion: packageJson && packageJson.version,
    main: packageJson && packageJson.main,
    patched: Boolean(packageJson && packageJson.main === PATCHED_MAIN && applied),
    applied,
  };
}

async function patchFaceitAsar(options = {}) {
  const {
    target,
    dryRun = false,
    force = false,
    logger = console,
    modSourceDir = DEFAULT_MOD_SOURCE,
  } = options;

  const asarPath = resolveAsarPath(target);
  const preflight = inspectAsar(asarPath);

  if (preflight.main === PATCHED_MAIN && preflight.applied && preflight.applied.version === MOD_VERSION && !force) {
    return {
      changed: false,
      dryRun,
      asarPath,
      backupPath: backupPathFor(asarPath),
      applied: preflight.applied,
    };
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faceit-extension-loader-'));
  const extractedAppDir = path.join(tempRoot, 'app');
  const outputAsarPath = path.join(tempRoot, 'app.asar');

  try {
    extractAll(asarPath, extractedAppDir);
    const packagePath = path.join(extractedAppDir, 'package.json');
    const packageJson = readJson(packagePath);
    const originalMain = resolveOriginalMain(packageJson);

    validatePatchTarget({
      appDir: extractedAppDir,
      packageJson,
      originalMain,
      force,
    });

    if (dryRun) {
      return {
        changed: true,
        dryRun: true,
        asarPath,
        backupPath: backupPathFor(asarPath),
        originalMain,
        patchedMain: PATCHED_MAIN,
      };
    }

    ensureBackup(asarPath, logger);
    packageJson.main = PATCHED_MAIN;
    packageJson.faceitExtensionLoader = {
      name: 'faceit-extension-loader',
      version: MOD_VERSION,
      originalMain,
    };
    writeJson(packagePath, packageJson);

    installModFiles({
      appDir: extractedAppDir,
      modSourceDir,
      originalMain,
      sourceAsarPath: asarPath,
    });

    await createAsarPackage(extractedAppDir, outputAsarPath, {
      dot: true,
      unpack: NATIVE_UNPACK_GLOB,
    });
    replaceAsarFromFile(outputAsarPath, asarPath);
    uncacheAsar(asarPath);

    return {
      changed: true,
      dryRun: false,
      asarPath,
      backupPath: backupPathFor(asarPath),
      originalMain,
      patchedMain: PATCHED_MAIN,
      applied: readAsarJson(asarPath, 'mod/.applied'),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function validatePatchTarget({ appDir, packageJson, originalMain, force }) {
  if (!force && packageJson.main !== DEFAULT_ORIGINAL_MAIN && packageJson.main !== PATCHED_MAIN) {
    throw new Error(`Refusing to patch unexpected package.json main "${packageJson.main}". Use --force only after checking this client version.`);
  }

  const originalMainPath = path.join(appDir, originalMain);
  if (!fs.existsSync(originalMainPath)) {
    throw new Error(`Original main entry does not exist in extracted asar: ${originalMain}`);
  }

  const originalMainStat = fs.statSync(originalMainPath);
  if (!originalMainStat.isFile()) {
    throw new Error(`Original main entry is not a file: ${originalMain}`);
  }
}

function resolveOriginalMain(packageJson) {
  const stored = packageJson.faceitExtensionLoader && packageJson.faceitExtensionLoader.originalMain;
  if (typeof stored === 'string' && stored.length > 0) {
    return sanitizeRelativeArchivePath(stored);
  }
  if (packageJson.main === PATCHED_MAIN) {
    return DEFAULT_ORIGINAL_MAIN;
  }
  return sanitizeRelativeArchivePath(packageJson.main || DEFAULT_ORIGINAL_MAIN);
}

function sanitizeRelativeArchivePath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error(`Unsafe archive path: ${value}`);
  }
  return normalized;
}

function installModFiles({ appDir, modSourceDir, originalMain, sourceAsarPath }) {
  const modDest = path.join(appDir, 'mod');
  if (!fs.existsSync(modSourceDir)) {
    throw new Error(`Mod source directory does not exist: ${modSourceDir}`);
  }

  fs.rmSync(modDest, { recursive: true, force: true });
  fs.cpSync(modSourceDir, modDest, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
  });

  const nodeModulesDest = path.join(modDest, 'node_modules');
  fs.mkdirSync(nodeModulesDest, { recursive: true });
  copyRuntimeDependencies(nodeModulesDest);
  installPatchedChromeExtensionPreload({ modDest, nodeModulesDest });

  writeJson(path.join(modDest, '.applied'), {
    name: 'faceit-extension-loader',
    version: MOD_VERSION,
    appliedAt: new Date().toISOString(),
    originalMain,
    sourceAsarPath,
  });
}

function installPatchedChromeExtensionPreload({ modDest, nodeModulesDest }) {
  const source = path.join(modDest, 'dist', 'chrome-extension-api.preload.js');
  const destination = path.join(
    nodeModulesDest,
    'electron-chrome-extensions',
    'dist',
    'chrome-extension-api.preload.js',
  );
  if (!fs.existsSync(source)) {
    throw new Error(`Patched extension API preload is missing: ${source}`);
  }
  if (!fs.existsSync(path.dirname(destination))) {
    throw new Error(`electron-chrome-extensions runtime is missing: ${path.dirname(destination)}`);
  }
  fs.copyFileSync(source, destination);
}

function copyRuntimeDependencies(nodeModulesDest) {
  const packages = collectPackageClosure(RUNTIME_PACKAGES);
  for (const [packageName, packageDir] of packages) {
    const destination = path.join(nodeModulesDest, ...packageName.split('/'));
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(packageDir, destination, {
      recursive: true,
      filter: (source) => {
        const base = path.basename(source);
        return base !== '.git' && base !== '.github';
      },
    });
  }
}

function collectPackageClosure(entryPackages) {
  const packages = new Map();

  function visit(packageName) {
    if (packages.has(packageName)) {
      return;
    }
    const packageDir = resolvePackageDir(packageName);
    packages.set(packageName, packageDir);
    const packageJson = readJson(path.join(packageDir, 'package.json'));
    for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
      visit(dependencyName);
    }
  }

  for (const packageName of entryPackages) {
    visit(packageName);
  }

  return packages;
}

function resolvePackageDir(packageName) {
  const nodeModulesPath = path.join(PROJECT_ROOT, 'node_modules', ...packageName.split('/'));
  if (fs.existsSync(path.join(nodeModulesPath, 'package.json'))) {
    return nodeModulesPath;
  }
  throw new Error(`Runtime dependency is not installed: ${packageName}. Run npm install before patching.`);
}

function ensureBackup(asarPath, logger) {
  const backupPath = backupPathFor(asarPath);
  const checksumPath = backupChecksumPathFor(asarPath);
  if (fs.existsSync(backupPath)) {
    ensureBackupChecksum(backupPath, checksumPath);
    return;
  }
  fs.copyFileSync(asarPath, backupPath);
  fs.writeFileSync(checksumPath, `${sha256File(backupPath)}\n`);
  if (logger && typeof logger.log === 'function') {
    logger.log(`Created backup: ${backupPath}`);
  }
}

function restoreOriginalAsar(options = {}) {
  const candidates = resolveAsarPaths(options.target);
  const restorable = candidates
    .map((asarPath) => ({ asarPath, backupPath: backupPathFor(asarPath) }))
    .filter(({ backupPath }) => fs.existsSync(backupPath));
  if (restorable.length === 0) {
    throw new Error(`No app.asar backup exists under target: ${options.target || defaultFaceitInstallRoot()}`);
  }
  for (const { asarPath, backupPath } of restorable) {
    ensureBackupChecksum(backupPath, backupChecksumPathFor(asarPath));
    replaceAsarFromFile(backupPath, asarPath);
    uncacheAsar(asarPath);
  }
  return {
    ...restorable[0],
    restored: restorable,
  };
}

function backupPathFor(asarPath) {
  return `${asarPath}.orig`;
}

function backupChecksumPathFor(asarPath) {
  return `${backupPathFor(asarPath)}.sha256`;
}

function ensureBackupChecksum(backupPath, checksumPath) {
  const actual = sha256File(backupPath);
  if (!fs.existsSync(checksumPath)) {
    fs.writeFileSync(checksumPath, `${actual}\n`);
    return;
  }
  const expected = fs.readFileSync(checksumPath, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
    throw new Error(`Backup integrity check failed: ${backupPath}`);
  }
}

function replaceAsarFromFile(sourcePath, asarPath) {
  const stagedPath = `${asarPath}.faceit-mods-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.copyFileSync(sourcePath, stagedPath);
    readAsarJson(stagedPath, 'package.json');
    fs.renameSync(stagedPath, asarPath);
  } finally {
    fs.rmSync(stagedPath, { force: true });
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function uncacheAsar(asarPath) {
  if (typeof uncache === 'function') {
    uncache(asarPath);
  }
}

async function createAsarPackage(sourceDir, destination, options) {
  const stream = await createPackageWithOptions(sourceDir, destination, options);
  if (stream && typeof stream.on === 'function' && !stream.closed && !stream.destroyed) {
    await waitForStreamClose(stream);
  }
}

function waitForStreamClose(stream) {
  return new Promise((resolve, reject) => {
    if (stream.closed || stream.destroyed) {
      resolve();
      return;
    }
    stream.once('close', resolve);
    stream.once('error', reject);
  });
}

function readAsarJson(asarPath, archivePath) {
  const buffer = readAsarFileIfExists(asarPath, archivePath);
  if (!buffer) {
    return null;
  }
  return JSON.parse(buffer.toString('utf8'));
}

function readAsarFileIfExists(asarPath, archivePath) {
  const candidates = archivePath.startsWith('/') ? [archivePath, archivePath.slice(1)] : [archivePath, `/${archivePath}`];
  for (const candidate of candidates) {
    try {
      statFile(asarPath, candidate);
      return extractFile(asarPath, candidate);
    } catch (error) {
      if (!isMissingAsarEntryError(error)) {
        throw error;
      }
    }
  }
  return null;
}

function isMissingAsarEntryError(error) {
  const message = error && error.message ? error.message : '';
  return /not found|Cannot find|ENOENT/i.test(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

module.exports = {
  MOD_VERSION,
  NATIVE_UNPACK_GLOB,
  PATCHED_MAIN,
  inspectAsar,
  patchFaceitAsar,
  resolveAsarPath,
  resolveAsarPaths,
  restoreOriginalAsar,
};
