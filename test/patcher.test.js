const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const asar = require('@electron/asar');

const {
  PATCHED_MAIN,
  inspectAsar,
  patchFaceitAsar,
  resolveAsarPath,
  restoreOriginalAsar,
} = require('../src/patcher');
const {
  installFaceitUpdateHook,
  patchPendingFaceitUpdate,
  resolveUpdateHookPaths,
} = require('../mod/update-hook');

test('release notes come from the matching changelog section', () => {
  const projectRoot = path.join(__dirname, '..');
  const packageJson = require('../package.json');
  const result = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'release-notes.js'), packageJson.version], {
    cwd: projectRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stable `faceit-mods:\/\/open`/);
  assert.match(result.stdout, /### Security/);
  assert.equal(result.stdout.includes('0.3.0-beta.22'), false);

  const missing = spawnSync(process.execPath, [path.join(projectRoot, 'scripts', 'release-notes.js'), '9.9.9'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /does not contain a section for 9\.9\.9/);
});

test('patches the newest FACEIT app.asar and is idempotent', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faceit-patcher-test-'));
  try {
    const installRoot = path.join(tempRoot, 'FACEIT');
    const oldResources = path.join(installRoot, 'app-2.9.0', 'resources');
    const newResources = path.join(installRoot, 'app-2.10.0', 'resources');
    fs.mkdirSync(oldResources, { recursive: true });
    fs.mkdirSync(newResources, { recursive: true });

    await createFakeFaceitAsar(path.join(oldResources, 'app.asar'), '2.9.0');
    await createFakeFaceitAsar(path.join(newResources, 'app.asar'), '2.10.0');

    const selectedAsar = resolveAsarPath(installRoot);
    assert.equal(selectedAsar, path.join(newResources, 'app.asar'));

    const first = await patchFaceitAsar({
      target: installRoot,
      logger: silentLogger,
    });

    assert.equal(first.changed, true);
    assert.equal(first.originalMain, 'main.js');
    assert.equal(first.patchedMain, PATCHED_MAIN);
    assert.equal(fs.existsSync(`${selectedAsar}.orig`), true);

    const inspection = inspectAsar(selectedAsar);
    assert.equal(inspection.main, PATCHED_MAIN);
    assert.equal(inspection.applied.version, require('../package.json').version);

    const packageJson = JSON.parse(asar.extractFile(selectedAsar, 'package.json').toString('utf8'));
    assert.equal(packageJson.faceitExtensionLoader.originalMain, 'main.js');
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/bootstrap.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/dist/chrome-extension-api.preload.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/browser-action-preload.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/action-popup-preload.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/extension-toolbar-preload.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/extension-compat.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/extension-main-world-compat.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/extension-main-world-bridge.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/marketplace.json')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/update-hook.js')), true);
    assert.equal(Boolean(asar.extractFile(selectedAsar, 'mod/node_modules/yauzl/package.json')), true);
    const packagedPreload = asar.extractFile(selectedAsar, 'mod/node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js').toString('utf8');
    const patchedPreload = fs.readFileSync(path.join(__dirname, '..', 'mod', 'dist', 'chrome-extension-api.preload.js'), 'utf8');
    assert.equal(packagedPreload, patchedPreload);
    assert.match(packagedPreload, /if \(key === "sync" \|\| key === "managed"\) continue/);
    assert.equal(asar.statFile(selectedAsar, 'build/win32/x64/odin.node').unpacked, true);

    const second = await patchFaceitAsar({
      target: installRoot,
      logger: silentLogger,
    });
    assert.equal(second.changed, false);

    await rewriteAppliedLoaderVersion(selectedAsar, '0.3.0-beta.4');
    const upgrade = await patchFaceitAsar({
      target: installRoot,
      logger: silentLogger,
    });
    assert.equal(upgrade.changed, true);
    assert.equal(inspectAsar(selectedAsar).applied.version, require('../package.json').version);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('downloaded FACEIT updates are patched synchronously before client update handlers', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faceit-update-hook-test-'));
  try {
    const localAppData = path.join(tempRoot, 'Local');
    const paths = resolveUpdateHookPaths({ LOCALAPPDATA: localAppData });
    fs.mkdirSync(path.dirname(paths.scriptPath), { recursive: true });
    fs.mkdirSync(paths.faceitRoot, { recursive: true });
    fs.writeFileSync(paths.scriptPath, '// test payload\n');

    const order = [];
    const calls = [];
    const autoUpdater = new EventEmitter();
    autoUpdater.on('update-downloaded', () => order.push('faceit-handler'));
    const installed = installFaceitUpdateHook({
      autoUpdater,
      env: { LOCALAPPDATA: localAppData, EXISTING_VALUE: 'kept' },
      execPath: 'C:\\FACEIT\\app-2.9.0\\FACEIT.exe',
      logger: silentLogger,
      platform: 'win32',
      spawnSync(executable, args, options) {
        order.push('mods-hook');
        calls.push({ args, executable, options });
        return { status: 0, stdout: '{"changed":true}', stderr: '' };
      },
    });

    assert.equal(installed, true);
    assert.equal(installFaceitUpdateHook({ autoUpdater, logger: silentLogger, platform: 'win32' }), false);
    autoUpdater.emit('update-downloaded');
    assert.deepEqual(order, ['mods-hook', 'faceit-handler']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, 'C:\\FACEIT\\app-2.9.0\\FACEIT.exe');
    assert.deepEqual(calls[0].args, [paths.scriptPath, 'patch', paths.faceitRoot, '--json']);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(calls[0].options.env.EXISTING_VALUE, 'kept');
    assert.equal(calls[0].options.windowsHide, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('restore rolls back every patched Squirrel app version with a backup', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faceit-restore-all-test-'));
  try {
    const installRoot = path.join(tempRoot, 'FACEIT');
    const oldAsar = path.join(installRoot, 'app-2.9.0', 'resources', 'app.asar');
    const newAsar = path.join(installRoot, 'app-2.10.0', 'resources', 'app.asar');
    fs.mkdirSync(path.dirname(oldAsar), { recursive: true });
    fs.mkdirSync(path.dirname(newAsar), { recursive: true });
    await createFakeFaceitAsar(oldAsar, '2.9.0');
    await createFakeFaceitAsar(newAsar, '2.10.0');
    await patchFaceitAsar({ target: oldAsar, logger: silentLogger });
    await patchFaceitAsar({ target: newAsar, logger: silentLogger });
    assert.equal(fs.existsSync(`${oldAsar}.orig.sha256`), true);
    assert.equal(fs.existsSync(`${newAsar}.orig.sha256`), true);

    const result = restoreOriginalAsar({ target: installRoot });
    assert.equal(result.restored.length, 2);
    assert.equal(JSON.parse(asar.extractFile(oldAsar, 'package.json')).main, 'main.js');
    assert.equal(JSON.parse(asar.extractFile(newAsar, 'package.json')).main, 'main.js');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('restore refuses a backup that fails its recorded SHA-256 integrity check', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faceit-backup-integrity-test-'));
  try {
    const asarPath = path.join(tempRoot, 'FACEIT', 'app-2.9.0', 'resources', 'app.asar');
    fs.mkdirSync(path.dirname(asarPath), { recursive: true });
    await createFakeFaceitAsar(asarPath, '2.9.0');
    await patchFaceitAsar({ target: asarPath, logger: silentLogger });
    fs.appendFileSync(`${asarPath}.orig`, 'corrupt');
    assert.throws(() => restoreOriginalAsar({ target: asarPath }), /integrity check failed/);
    assert.equal(inspectAsar(asarPath).patched, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('FACEIT update hook fails open when its installed payload is unavailable', () => {
  const warnings = [];
  const result = patchPendingFaceitUpdate({
    env: { LOCALAPPDATA: path.join(os.tmpdir(), 'missing-faceit-mods-payload') },
    logger: {
      info() {},
      warn(message) { warnings.push(message); },
    },
    platform: 'win32',
    spawnSync() { throw new Error('must not run'); },
  });
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'payload-missing');
  assert.equal(warnings.length, 1);
});

test('bundled extension API preload avoids frozen Chrome proxy APIs', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'mod', 'dist', 'chrome-extension-api.preload.js'), 'utf8');

  assert.match(preload, /cloneChromeObject/);
  assert.match(preload, /management: \{/);
  assert.match(preload, /getSelf: \(callback\) =>/);
  assert.match(preload, /sync: local/);
  assert.equal(preload.includes('Object.freeze(chrome)'), false);
});

test('extension compatibility shim patches unsupported Electron extension APIs', () => {
  const shim = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-compat.js'), 'utf8');

  assert.match(shim, /replaceGlobalApi/);
  assert.match(shim, /installBrowserNamespace/);
  assert.match(shim, /defineCompatProperty\(storage, 'sync', createStorageAreaFacade\(local\)\)/);
  assert.match(shim, /defineCompatProperty\(storage, 'managed', createStorageAreaFacade\(local\)\)/);
  assert.match(shim, /defineCompatProperty\(management, 'getSelf', getSelf\)/);
  assert.match(shim, /installProxyInvariantFallback/);
  assert.match(shim, /callbackCompatibleChromeFunction/);
  assert.match(shim, /createStorageAreaFacade/);
  assert.match(shim, /getBytesInUse/);
  assert.match(shim, /QUOTA_BYTES_PER_ITEM/);
  assert.match(shim, /patchStorageOnChanged/);
  assert.match(shim, /listener\(changes, 'sync'/);
  assert.match(shim, /chrome API status/);
  assert.match(shim, /unhandledrejection/);
});

test('storage.sync fallback never calls the unavailable native sync backend', async () => {
  const shim = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-compat.js'), 'utf8');
  const values = {};
  const storageListeners = new Set();
  const local = {
    get(_keys, callback) {
      const result = { ...values };
      if (typeof callback === 'function') queueMicrotask(() => callback(result));
      return Promise.resolve(result);
    },
    set(items, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(items || {})) {
        changes[key] = { oldValue: values[key], newValue: value };
        values[key] = value;
      }
      for (const listener of storageListeners) listener(changes, 'local');
      if (typeof callback === 'function') queueMicrotask(callback);
      return Promise.resolve();
    },
    remove() { return Promise.resolve(); },
    clear() { return Promise.resolve(); },
  };
  const storage = {
    local,
    onChanged: {
      addListener(listener) { storageListeners.add(listener); },
      removeListener(listener) { storageListeners.delete(listener); },
    },
  };
  Object.defineProperty(storage, 'sync', {
    configurable: false,
    enumerable: true,
    get() {
      throw new Error('"sync" is not available in this instance of Chrome');
    },
  });
  const chrome = {
    runtime: {
      id: 'storage-test-extension',
      getManifest() { return { name: 'Storage test', version: '1.0.0' }; },
    },
    storage,
  };
  let nativeBrowserSyncCalls = 0;
  const browserStorage = {
    local,
    onChanged: storage.onChanged,
    sync: {
      get() { nativeBrowserSyncCalls += 1; throw new Error('native browser sync must not be used'); },
      set() { nativeBrowserSyncCalls += 1; throw new Error('native browser sync must not be used'); },
    },
  };
  const browser = { runtime: chrome.runtime, storage: browserStorage };
  const context = {
    Array,
    Error,
    Function,
    Object,
    Promise,
    Proxy,
    WeakMap,
    browser,
    chrome,
    console: silentLogger,
    globalThis: {},
    queueMicrotask,
  };
  context.globalThis = context;
  vm.runInNewContext(shim, context);

  const observedAreas = [];
  context.chrome.storage.onChanged.addListener((_changes, areaName) => observedAreas.push(areaName));
  await context.chrome.storage.sync.set({ language: 'en' });
  const promiseResult = await context.chrome.storage.sync.get(['language']);
  const callbackResult = await new Promise((resolve) => context.chrome.storage.sync.get(['language'], resolve));

  assert.equal(promiseResult.language, 'en');
  assert.equal(callbackResult.language, 'en');
  assert.deepEqual(observedAreas, ['local', 'sync']);
  assert.equal(context.chrome.storage.sync.QUOTA_BYTES, 102400);
  await context.browser.storage.sync.set({ language: 'de' });
  assert.equal((await context.browser.storage.sync.get(['language'])).language, 'de');
  assert.equal(nativeBrowserSyncCalls, 0);
});

test('extension compatibility shim preserves event listener return values', () => {
  const shim = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-compat.js'), 'utf8');
  let registeredListener;
  const chrome = {
    runtime: {
      id: 'test-extension',
      onMessage: {
        addListener(listener) {
          registeredListener = listener;
        },
      },
    },
    storage: {
      local: {},
    },
  };
  const context = {
    Array,
    Error,
    Function,
    Object,
    Promise,
    WeakMap,
    chrome,
    clearTimeout,
    console: silentLogger,
    globalThis: {},
    queueMicrotask,
    setTimeout,
    window: {},
  };
  context.globalThis = context;
  context.window = context;

  vm.runInNewContext(shim, context);
  context.chrome.runtime.onMessage.addListener(() => true);

  assert.equal(typeof registeredListener, 'function');
  assert.equal(registeredListener({ type: 'ping' }, {}, () => {}), true);
});

test('bootstrap prepares generic extension compatibility copies', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'mod', 'bootstrap.js'), 'utf8');

  assert.match(bootstrap, /faceit-loader-extension-compat\.js/);
  assert.match(bootstrap, /faceit-loader-background-wrapper\.js/);
  assert.match(bootstrap, /faceit-loader-main-world-compat\.js/);
  assert.match(bootstrap, /faceit-loader-main-world-bridge\.js/);
  assert.match(bootstrap, /injectExtensionPageCompat/);
  assert.match(bootstrap, /default_popup/);
  assert.match(bootstrap, /importScripts/);
  assert.equal(bootstrap.includes('__faceit_loader'), false);
});

test('MAIN-world content scripts receive an isolated extension API bridge before their code', () => {
  const helpers = loadBootstrapTestFunctions();
  const manifest = {
    manifest_version: 3,
    name: 'Bridge test',
    version: '1.0.0',
    content_scripts: [
      { matches: ['https://www.faceit.com/*'], js: ['forecast.js'], run_at: 'document_start', world: 'MAIN' },
      { matches: ['https://www.faceit.com/*'], js: ['forecast.js'] },
    ],
  };

  assert.equal(helpers.prependContentScriptCompat(manifest), true);
  assert.deepEqual(Array.from(manifest.content_scripts[0].js), [
    'faceit-loader-main-world-config.js',
    'faceit-loader-main-world-bridge.js',
  ]);
  assert.equal(manifest.content_scripts[0].world, 'ISOLATED');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.deepEqual(Array.from(manifest.content_scripts[1].js), [
    'faceit-loader-main-world-config.js',
    'faceit-loader-main-world-compat.js',
    'forecast.js',
  ]);
  assert.deepEqual(Array.from(manifest.content_scripts[2].js), [
    'faceit-loader-extension-compat.js',
    'forecast.js',
  ]);
});

test('MAIN-world storage.sync and runtime calls cross the isolated bridge', async () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-main-world-bridge.js'), 'utf8');
  const compatSource = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-main-world-compat.js'), 'utf8');
  const listeners = new Set();
  const bus = {
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
    postMessage(data) { for (const listener of [...listeners]) listener({ data, source: bus }); },
  };
  const values = {};
  const storageListeners = new Set();
  const local = {
    get(_keys, callback) { queueMicrotask(() => callback({ ...values })); },
    set(items, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(items || {})) {
        changes[key] = { oldValue: values[key], newValue: value };
        values[key] = value;
      }
      for (const listener of storageListeners) listener(changes, 'local');
      queueMicrotask(callback);
    },
    remove(keys, callback) { for (const key of [].concat(keys || [])) delete values[key]; queueMicrotask(callback); },
    clear(callback) { for (const key of Object.keys(values)) delete values[key]; queueMicrotask(callback); },
  };
  const runtime = {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    lastError: undefined,
    sendMessage(message, callback) { queueMicrotask(() => callback({ echoed: message })); },
  };
  const config = {
    channel: 'bridge-test-channel',
    extensionIdHint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    manifest: { name: 'Bridge test', version: '1.0.0' },
  };
  const shared = {
    Error,
    Map,
    Object,
    Promise,
    Set,
    TextEncoder,
    clearInterval,
    clearTimeout,
    console: silentLogger,
    queueMicrotask,
    setInterval,
    setTimeout,
    window: bus,
  };
  const bridgeContext = {
    ...shared,
    __faceitExtensionLoaderMainWorldConfig: { ...config },
    chrome: { runtime, storage: { local, onChanged: { addListener(listener) { storageListeners.add(listener); } } } },
  };
  bridgeContext.globalThis = bridgeContext;
  const mainContext = { ...shared, __faceitExtensionLoaderMainWorldConfig: { ...config }, chrome: {} };
  mainContext.globalThis = mainContext;

  vm.runInNewContext(bridgeSource, bridgeContext);
  vm.runInNewContext(compatSource, mainContext);

  const observedAreas = [];
  mainContext.chrome.storage.onChanged.addListener((_changes, areaName) => observedAreas.push(areaName));
  await mainContext.chrome.storage.sync.set({ language: 'en' });
  const valuesFromPromise = await mainContext.chrome.storage.sync.get(['language']);
  const valuesFromCallback = await new Promise((resolve) => mainContext.browser.storage.sync.get(['language'], resolve));
  const runtimeResponse = await mainContext.chrome.runtime.sendMessage({ type: 'ping' });

  assert.equal(valuesFromPromise.language, 'en');
  assert.equal(valuesFromCallback.language, 'en');
  assert.equal(runtimeResponse.echoed.type, 'ping');
  assert.equal(mainContext.chrome.runtime.id, runtime.id);
  assert.equal(mainContext.chrome.runtime.getManifest().version, '1.0.0');
  assert.deepEqual(observedAreas, ['local', 'sync']);
});

test('extension page compatibility loads before the extension page scripts', () => {
  const helpers = loadBootstrapTestFunctions();
  const original = '<html><head><script src="popup.js"></script></head><body></body></html>';
  const patched = helpers.injectCompatScriptIntoHtml(original);

  assert.ok(patched.indexOf('faceit-loader-extension-compat.js') < patched.indexOf('popup.js'));
});

test('mod manager exposes marketplace, lifecycle, window, and diagnostic operations', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'mod', 'bootstrap.js'), 'utf8');
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-toolbar-preload.js'), 'utf8');

  for (const operation of [
    'add-from-folder',
    'install-marketplace',
    'install-webstore',
    'update-marketplace',
    'install-deeplink',
    'dismiss-deeplink',
    'ack-deeplink',
    'create-shortcut',
    'set-enabled',
    'reload',
    'remove',
    'open-extension-surface',
    'open-marketplace-page',
    'copy-install-link',
    'open-data-folder',
    'copy-diagnostics',
  ]) {
    assert.match(bootstrap, new RegExp(`operation === '${operation}'`));
  }

  assert.match(bootstrap, /assertTrustedRenderer/);
  assert.match(bootstrap, /persistRegistryExtensions/);
  assert.match(bootstrap, /readRecentLogLines/);
  assert.match(bootstrap, /extractZipSafely/);
  assert.match(bootstrap, /openExtensionWindow/);
  assert.match(bootstrap, /restoreMarketplaceInstall/);
  assert.match(toolbar, /data-view="browse"/);
  assert.match(toolbar, /data-view="installed"/);
  assert.match(toolbar, /renderSettingsScreen/);
  assert.match(toolbar, /renderExtensionDock/);
  assert.match(toolbar, /className = 'webstore-install'/);
  assert.match(toolbar, /install\.type = 'submit'/);
  assert.match(toolbar, /manager operation requested/);
  assert.equal(toolbar.includes('renderDetailScreen'), false);
  assert.match(toolbar, /activeView: 'installed'/);
  assert.match(toolbar, /--mods-panel-width/);
  assert.match(toolbar, /runExtensionOperation/);
  assert.match(toolbar, /showConfirmation/);
  assert.match(toolbar, /pageReloadRequired/);
});

test('FACEIT Mods launcher tracks the visible right sidebar without joining the React tree', () => {
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-toolbar-preload.js'), 'utf8');

  assert.match(toolbar, /RIGHT_SIDEBAR_SELECTOR = '\[class\*="SideBarContainer"\]'/);
  assert.match(toolbar, /attachShadow\(\{ mode: 'open' \}\)/);
  assert.match(toolbar, /aria-label="FACEIT Mods"/);
  assert.match(toolbar, /function isVisibleRightSidebar\(sidebar\)/);
  assert.match(toolbar, /style\.visibility === 'hidden'/);
  assert.match(toolbar, /function isVisibleSidebarRect\(rect\)/);
  assert.match(toolbar, /host && host\.parentElement !== document\.body/);
  assert.match(toolbar, /updatePlacementLog\('bottom-right-extension-dock'/);
  assert.match(toolbar, /dock\.querySelector\('\.mods-button'\)/);
  assert.match(toolbar, /function renderExtensionDock\(state\)/);
  assert.match(toolbar, /function syncIntegratedLaunchers\(state\)/);
  assert.match(toolbar, /slot="extension-launcher"/);
  assert.match(toolbar, /function createLauncherProxy\(node, selector\)/);
  assert.match(toolbar, /cloneNode\(true\)/);
  assert.match(toolbar, /function hideLauncherAnchor\(record\)/);
  assert.match(toolbar, /function activateLauncherProxy\(event, record\)/);
  assert.match(toolbar, /record\.proxy\.removeAttribute\('class'\)/);
  assert.equal(toolbar.includes('host.appendChild(node)'), false);
  assert.match(toolbar, /function getPageLauncherSelectors\(listing\)/);
  assert.match(toolbar, /overflow-y:auto/);
  assert.match(toolbar, /const width = Math\.max\(44, Math\.round\(sidebarRect\.width\)\)/);
  assert.match(toolbar, /sidebarRect\.bottom \+ 4/);
  assert.equal(toolbar.includes('dock-separator'), false);
  assert.match(toolbar, /const SIDEBAR_BACKGROUND = '#121212'/);
  assert.match(toolbar, /\.dock\{[^}]*background:var\(--mods-sidebar-background,#121212\);border:0;border-radius:0;box-shadow:none/);
  assert.match(toolbar, /\.dock\{[^}]*padding:4px 0;[^}]*width:var\(--mods-dock-width,64px\)/);
  assert.match(toolbar, /setProperty\('--mods-sidebar-background', SIDEBAR_BACKGROUND\)/);
  assert.equal(toolbar.includes('getSidebarBackground'), false);
  assert.match(toolbar, /\.dock\[data-has-actions="true"\] \.mods-button::before/);
  assert.match(toolbar, /\.dock-button\{[^}]*border:0/);
  assert.match(toolbar, /slot::slotted\([^)]*\)\{[^}]*border:0!important/);
  assert.equal(toolbar.includes('fc-logo-button'), false);
  assert.equal(toolbar.includes('candidates[0]'), false);
  assert.match(toolbar, /function shouldEnsureUi\(\)/);
  assert.equal(toolbar.includes('Party Finder'), false);
  assert.equal(toolbar.includes('SearchButtonWrapper'), false);
});

test('extension actions embed in FACEIT while options retain a normal window', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'mod', 'bootstrap.js'), 'utf8');
  const toolbar = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-toolbar-preload.js'), 'utf8');
  const compat = fs.readFileSync(path.join(__dirname, '..', 'mod', 'extension-compat.js'), 'utf8');
  const popupPreload = fs.readFileSync(path.join(__dirname, '..', 'mod', 'action-popup-preload.js'), 'utf8');

  assert.match(bootstrap, /surfaceResult = await openExtensionSurface/);
  assert.match(bootstrap, /mode: 'embed'/);
  assert.match(bootstrap, /\.\.\.\(surfaceResult \? \{ surface: surfaceResult \} : \{\}\)/);
  assert.match(bootstrap, /if \(surface === 'action'\) \{[\s\S]*openEmbeddedExtensionAction\([\s\S]*mode: 'embed'/);
  assert.match(bootstrap, /new BrowserView\(\{/);
  assert.match(bootstrap, /parent\.addBrowserView\(view\)/);
  assert.match(bootstrap, /parent\.removeBrowserView\(record\.view\)/);
  assert.match(bootstrap, /preload: ACTION_POPUP_PRELOAD/);
  assert.match(bootstrap, /findEmbeddedExtensionActionByGuest/);
  assert.match(bootstrap, /IPC_ACTION_POPUP_HOST/);
  assert.match(bootstrap, /IPC_ACTION_POPUP_CONTROL/);
  assert.match(bootstrap, /layoutEmbeddedExtensionAction/);
  assert.match(bootstrap, /await openExtensionWindow\(\{/);
  assert.match(bootstrap, /resizable: true/);
  assert.match(bootstrap, /movable: true/);
  assert.match(bootstrap, /getExtensionWorkArea/);
  assert.match(bootstrap, /screen\.getDisplayMatching/);
  assert.match(bootstrap, /keepExtensionWindowVisible/);
  assert.match(bootstrap, /enablePreferredSizeMode: true/);
  assert.match(bootstrap, /view\.webContents\.on\('preferred-size-changed'/);
  assert.match(toolbar, /ACTION_POPUP_HOST_ID/);
  assert.match(toolbar, /openEmbeddedExtensionPopup/);
  assert.match(toolbar, /right: `\$\{edge\}px`/);
  assert.match(toolbar, /bottom: `\$\{edge\}px`/);
  assert.match(toolbar, /handleActionPopupState/);
  assert.match(toolbar, /IPC_ACTION_POPUP_CONTROL/);
  assert.equal(toolbar.includes('document.createElement(\'iframe\')'), false);
  assert.match(compat, /installEmbeddedPopupBridge/);
  assert.match(compat, /__faceitExtensionPopupHost/);
  assert.match(popupPreload, /contextBridge\.exposeInMainWorld/);
  assert.match(popupPreload, /event\.key === 'Escape'/);
  assert.equal(popupPreload.includes('ResizeObserver'), false);
});

test('embedded extension actions attach, resize, and detach inside the FACEIT window', async () => {
  const helpers = loadBootstrapTestFunctions();
  const parentMessages = [];
  const parent = new EventEmitter();
  parent.webContents = {
    id: 42,
    isDestroyed: () => false,
    send: (channel, payload) => parentMessages.push({ channel, payload }),
  };
  parent.isDestroyed = () => false;
  parent.getContentBounds = () => ({ x: 100, y: 50, width: 1280, height: 800 });
  parent.addBrowserView = (view) => { parent.attachedView = view; };
  parent.removeBrowserView = (view) => { parent.detachedView = view; };

  class FakeBrowserView {
    constructor(options) {
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => false;
      this.webContents.setWindowOpenHandler = (handler) => { this.windowOpenHandler = handler; };
      this.webContents.loadURL = async (url) => { this.loadedUrl = url; };
      this.webContents.close = () => { this.closed = true; };
    }

    setAutoResize(value) { this.autoResize = value; }
    setBackgroundColor(value) { this.backgroundColor = value; }
    setBounds(value) { this.bounds = value; }
  }

  const initial = await helpers.openEmbeddedExtensionAction({
    BrowserView: FakeBrowserView,
    browserSession: { id: 'default' },
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    logger: silentLogger,
    name: 'Example',
    pageUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
    parent,
    shell: null,
  });
  assert.deepEqual({ ...initial }, { width: 420, height: 560 });
  assert.deepEqual({ ...parent.attachedView.bounds }, { x: 851, y: 231, width: 418, height: 558 });
  assert.equal(parent.attachedView.loadedUrl, 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html');
  assert.equal(parent.attachedView.options.webPreferences.preload.endsWith('action-popup-preload.js'), true);

  const record = helpers.embeddedExtensionActions.get(42);
  parent.attachedView.webContents.emit('preferred-size-changed', {}, { width: 720, height: 540 });
  assert.deepEqual({ ...parent.attachedView.bounds }, { x: 551, y: 251, width: 718, height: 538 });

  helpers.closeEmbeddedExtensionAction(record);
  assert.equal(parent.detachedView, parent.attachedView);
  assert.equal(parent.attachedView.closed, true);
  assert.equal(helpers.embeddedExtensionActions.has(42), false);
  assert.equal(parentMessages.at(-1).payload.open, false);
});

test('deep links expose strict open, install, and launch actions', () => {
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'mod', 'bootstrap.js'), 'utf8');
  const helpers = loadBootstrapTestFunctions();

  assert.equal(bootstrap.includes('setAsDefaultProtocolClient'), false);
  assert.match(bootstrap, /pendingInstallRequest/);
  assert.match(bootstrap, /pendingNavigationRequest/);
  assert.match(bootstrap, /requirePendingInstallRequest/);
  assert.match(bootstrap, /requirePendingNavigationRequest/);
  assert.match(bootstrap, /notifyDeepLinkRenderers/);
  assert.deepEqual({ ...helpers.parseDeepLink('faceit-mods://open') }, {
    action: 'open',
    href: 'faceit-mods://open',
  });
  assert.deepEqual({ ...helpers.parseDeepLink('faceit-mods://install/faceit-forecast') }, {
    action: 'install',
    href: 'faceit-mods://install/faceit-forecast',
    target: 'faceit-forecast',
  });
  assert.deepEqual({ ...helpers.parseDeepLink('faceit-mods://launch/mpkkcddegpblmobincjkbpgfcbejjbcp') }, {
    action: 'launch',
    href: 'faceit-mods://launch/mpkkcddegpblmobincjkbpgfcbejjbcp',
    target: 'mpkkcddegpblmobincjkbpgfcbejjbcp',
  });
  assert.deepEqual({ ...helpers.resolveDeepLinkInstallTarget('faceit-forecast') }, {
    extensionId: 'mpkkcddegpblmobincjkbpgfcbejjbcp',
    marketplaceId: 'faceit-forecast',
    source: 'marketplace',
  });
  assert.deepEqual({ ...helpers.resolveDeepLinkInstallTarget('abcdefghijklmnopabcdefghijklmnop') }, {
    extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    source: 'webstore',
  });
  assert.throws(() => helpers.resolveDeepLinkInstallTarget('unknown-extension'), /catalog id or Chrome Web Store/);
  assert.throws(() => helpers.parseDeepLink('faceit-mods://install?id=faceit-forecast'), /Unsupported/);
  assert.throws(() => helpers.parseDeepLink('faceit-mods://install/%66aceit-forecast'), /unsupported/i);
  assert.throws(() => helpers.parseDeepLink('faceit-mods://install/%2e%2e%2fforecast'), /unsupported/i);
  assert.throws(() => helpers.parseDeepLink('https://example.com/install/faceit-forecast'), /Unsupported/);
});

test('Chrome Web Store installs accept only store links or extension ids', () => {
  const helpers = loadBootstrapTestFunctions();
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  assert.equal(helpers.parseChromeWebStoreExtensionId(extensionId), extensionId);
  assert.equal(helpers.parseChromeWebStoreExtensionId(`https://chromewebstore.google.com/detail/example/${extensionId}`), extensionId);
  assert.equal(helpers.parseChromeWebStoreExtensionId(`https://chrome.google.com/webstore/detail/example/${extensionId}`), extensionId);
  assert.throws(() => helpers.parseChromeWebStoreExtensionId(`https://example.com/${extensionId}`), /Only Chrome Web Store/);
  assert.throws(() => helpers.parseChromeWebStoreExtensionId('not-an-extension'), /Paste a Chrome Web Store/);
});

test('options windows remain centered and clamped to the current work area', () => {
  const helpers = loadBootstrapTestFunctions();
  const parentBounds = { x: 100, y: 50, width: 1200, height: 800 };
  assert.deepEqual({ ...helpers.getExtensionWindowPosition({ height: 600, parentBounds, width: 800 }) }, { x: 300, y: 150 });

  const workArea = { x: 0, y: 0, width: 1280, height: 720 };
  assert.deepEqual({ ...helpers.getExtensionWindowPosition({ height: 700, parentBounds, width: 980, workArea }) }, { x: 210, y: 12 });

  const secondMonitor = { x: -1920, y: 0, width: 1920, height: 1040 };
  const secondParent = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual({ ...helpers.getExtensionWindowPosition({ height: 720, parentBounds: secondParent, width: 980, workArea: secondMonitor }) }, { x: -1450, y: 180 });
});

test('extension window work area follows the display containing FACEIT', () => {
  const helpers = loadBootstrapTestFunctions();
  const parentBounds = { x: 2100, y: 100, width: 1200, height: 800 };
  const screen = {
    getDisplayMatching(bounds) {
      assert.deepEqual(bounds, parentBounds);
      return { workArea: { x: 1920.4, y: 0, width: 1919.6, height: 1040.2 } };
    },
  };
  assert.deepEqual({ ...helpers.getExtensionWorkArea({ parentBounds, screen }) }, { x: 1920, y: 0, width: 1920, height: 1040 });
});

test('runtime compatibility remains extension-agnostic', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod', 'marketplace.json'), 'utf8'));
  const runtimeSources = [
    'bootstrap.js',
    'action-popup-preload.js',
    'browser-action-preload.js',
    'extension-compat.js',
    'extension-toolbar-preload.js',
  ].map((fileName) => fs.readFileSync(path.join(__dirname, '..', 'mod', fileName), 'utf8').toLowerCase()).join('\n');

  for (const listing of marketplace.extensions) {
    assert.equal(runtimeSources.includes(listing.id.toLowerCase()), false);
    assert.equal(runtimeSources.includes(listing.extensionId.toLowerCase()), false);
  }
});

test('Windows maintenance scripts warn and close only the FACEIT desktop client', () => {
  const projectRoot = path.join(__dirname, '..');
  const windowsRoot = fs.existsSync(path.join(projectRoot, 'windows-portable'))
    ? path.join(projectRoot, 'windows-portable')
    : projectRoot;
  const helper = fs.readFileSync(path.join(windowsRoot, '_ensure-faceit-closed.bat'), 'utf8');
  const patchScript = fs.readFileSync(path.join(windowsRoot, '1-patch-faceit.bat'), 'utf8');
  const debugScript = fs.readFileSync(path.join(windowsRoot, '3-run-faceit-debug.bat'), 'utf8');
  const restoreScript = fs.readFileSync(path.join(windowsRoot, '4-restore-faceit.bat'), 'utf8');

  assert.match(helper, /Closing FACEIT immediately/);
  assert.equal(helper.includes('timeout /T 10 /NOBREAK'), false);
  assert.equal(/choice \/C YN|\[Y\/N\]|\/D Y/.test(helper), false);
  assert.match(helper, /taskkill \/IM FACEIT\.exe \/T/);
  assert.match(helper, /taskkill \/F \/IM FACEIT\.exe \/T/);
  assert.match(helper, /Anti-Cheat services are not touched/);
  assert.equal(/FACEITService|FACEITClient|AntiCheat\.exe/i.test(helper), false);

  for (const script of [patchScript, debugScript, restoreScript]) {
    assert.match(script, /call "%~dp0_ensure-faceit-closed\.bat"/);
    assert.match(script, /if errorlevel 1/);
  }
  assert.match(restoreScript, /reg delete "HKCU\\Software\\Classes\\faceit-mods"/);
  assert.match(restoreScript, /reg delete "HKCU\\Software\\FACEIT Mods"/);
  assert.match(patchScript, /install-update-hook-payload\.js/);
  assert.match(patchScript, /FACEIT Mods\\current/);
  assert.match(patchScript, /Join-Path \$root 'FACEIT\.exe'/);
  assert.match(patchScript, /DisplayVersion/);
  assert.match(patchScript, /ProtocolVersion/);
});

test('native Windows setup uses the FACEIT Electron runtime and stays current-user scoped', () => {
  const projectRoot = path.join(__dirname, '..');
  const installer = fs.readFileSync(path.join(projectRoot, 'native-installer', 'installer.c'), 'utf8');
  const protocolHandler = fs.readFileSync(path.join(projectRoot, 'native-installer', 'protocol-handler.c'), 'utf8');
  const manifest = fs.readFileSync(path.join(projectRoot, 'native-installer', 'installer.manifest'), 'utf8');
  const buildScript = fs.readFileSync(path.join(projectRoot, 'scripts', 'build-win-installer.js'), 'utf8');
  const packageJson = require('../package.json');

  assert.match(installer, /FindResourceW\([^\n]+RT_RCDATA\)/);
  assert.match(installer, /ACTION_INSTALL/);
  assert.match(installer, /ACTION_RESTORE/);
  assert.match(installer, /RegDeleteTreeW\(HKEY_CURRENT_USER/);
  assert.match(installer, /FACEIT_MODS_SKIP_CLOSE/);
  assert.match(installer, /FACEIT closes briefly while setup applies the local patch/);
  assert.equal(installer.includes('will close in %d seconds'), false);
  assert.equal(installer.includes('for (int remaining = 10'), false);
  assert.equal(installer.toLowerCase().includes('powershell'), false);
  assert.match(manifest, /requestedExecutionLevel level="asInvoker"/);
  assert.match(buildScript, /RCDATA/);
  assert.match(buildScript, /faceit-mods\.ico/);
  assert.match(buildScript, /FACEIT-Extension-Loader-Setup/);
  assert.match(buildScript, /ICON/);
  assert.match(buildScript, /-Werror/);
  assert.match(buildScript, /sha256/);
  assert.equal(packageJson.scripts['build:win-installer'], 'node ./scripts/build-win-installer.js');
  assert.equal(packageJson.scripts['build:win-installers'], undefined);
  assert.equal(packageJson.scripts['build:win-web-installer'], undefined);
  assert.equal(packageJson.scripts['build:win-offline-installer'], undefined);
  assert.equal(buildScript.includes("\n    'node',"), false);
  assert.equal(buildScript.includes('-lwinhttp'), false);
  assert.equal(buildScript.includes('-lbcrypt'), false);
  assert.match(installer, /ELECTRON_RUN_AS_NODE/);
  assert.match(installer, /FACEIT_MODS_RUNTIME_EXE/);
  assert.match(installer, /find_latest_faceit_exe/);
  assert.match(installer, /join_path\(output, capacity, local_app_data, L"FACEIT Mods"\)/);
  assert.match(installer, /join_path\(output, capacity, mods_root, L"current"\)/);
  assert.equal(installer.includes('WinHttpOpen'), false);
  assert.equal(installer.includes('BCryptFinishHash'), false);
  assert.equal(installer.includes('CreateHardLinkW'), false);
  assert.equal(installer.includes('Downloading verified runtime'), false);
  assert.match(fs.readFileSync(path.join(projectRoot, 'bin', 'faceit-extension-loader.js'), 'utf8'), /process\.noAsar = true/);
  const updateHook = fs.readFileSync(path.join(projectRoot, 'mod', 'update-hook.js'), 'utf8');
  assert.match(updateHook, /update-downloaded/);
  assert.match(updateHook, /prependListener/);
  assert.match(updateHook, /ELECTRON_RUN_AS_NODE/);
  assert.match(updateHook, /FACEIT Mods', 'current/);
  assert.match(installer, /g_install_complete/);
  assert.match(installer, /primary_text = L"Open FACEIT"/);
  assert.match(installer, /installed\.marker/);
  assert.match(installer, /join_path\(marker, PATH_CAPACITY, mods_root, L"installed\.marker"\)/);
  assert.match(installer, /read_install_state_marker/);
  assert.match(installer, /read_product_state_version/);
  assert.match(installer, /RegQueryValueExW\(key, L"DisplayVersion"/);
  assert.match(installer, /DisplayVersion/);
  assert.match(installer, /ProtocolVersion/);
  assert.match(installer, /L"Repair"/);
  assert.match(installer, /DWMWA_USE_IMMERSIVE_DARK_MODE/);
  assert.match(installer, /WM_DPICHANGED/);
  assert.match(installer, /DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2/);
  assert.match(installer, /high_contrast_enabled/);
  assert.match(installer, /TaskDialogIndirect/);
  assert.match(installer, /show_inline_error/);
  assert.match(installer, /start_task\(g_active_action\)/);
  assert.equal(installer.includes('MessageBoxW('), false);
  assert.equal(fs.existsSync(path.join(projectRoot, 'LICENSE')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'THIRD_PARTY_NOTICES.md')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'native-installer', 'faceit-mods.ico')), true);
  assert.match(buildScript, /buildProtocolHandler/);
  assert.match(buildScript, /faceit-mods-handler\.exe/);
  assert.match(protocolHandler, /DEEP_LINK_PREFIX L"faceit-mods:\/\/"/);
  assert.match(protocolHandler, /wcscmp\(action, L"open"\)/);
  assert.match(protocolHandler, /install\//);
  assert.match(protocolHandler, /launch\//);
  assert.match(protocolHandler, /L"FACEIT\\\\FACEIT\.exe"|L"FACEIT"/);
  assert.match(protocolHandler, /argument_count != 2/);
});

test('bundled marketplace has unique, attributable, compatibility-scoped listings', () => {
  const marketplace = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mod', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.schemaVersion, 1);
  assert.ok(Array.isArray(marketplace.extensions));
  assert.ok(marketplace.extensions.length >= 3);
  assert.equal(new Set(marketplace.extensions.map((listing) => listing.id)).size, marketplace.extensions.length);
  assert.equal(new Set(marketplace.extensions.map((listing) => listing.extensionId)).size, marketplace.extensions.length);
  for (const listing of marketplace.extensions) {
    assert.match(listing.id, /^[a-z0-9-]+$/);
    assert.match(listing.extensionId, /^[a-p]{32}$/);
    assert.match(listing.storeUrl, /^https:\/\/chromewebstore\.google\.com\/detail\//);
    assert.match(listing.iconUrl, /^https:\/\/lh3\.googleusercontent\.com\//);
    assert.ok(['tested', 'experimental'].includes(listing.compatibility));
    assert.ok(Array.isArray(listing.features) && listing.features.length > 0);
    assert.ok(Array.isArray(listing.permissions) && listing.permissions.length > 0);
    if (listing.pageLauncherSelectors) {
      assert.ok(Array.isArray(listing.pageLauncherSelectors));
      for (const selector of listing.pageLauncherSelectors) assert.match(selector, /^#[a-z][a-z0-9_-]*$/i);
    }
  }
});

test('marketplace CRX parsing and archive path validation reject unsafe input', () => {
  const helpers = loadBootstrapTestFunctions();
  const zipPayload = Buffer.from('PK\x03\x04payload', 'binary');
  const crx3 = Buffer.alloc(12 + zipPayload.length);
  crx3.write('Cr24', 0, 'ascii');
  crx3.writeUInt32LE(3, 4);
  crx3.writeUInt32LE(0, 8);
  zipPayload.copy(crx3, 12);
  assert.deepEqual(Buffer.from(helpers.getCrxZipPayload(crx3)), zipPayload);

  const crx2 = Buffer.alloc(16 + 3 + 4 + zipPayload.length);
  crx2.write('Cr24', 0, 'ascii');
  crx2.writeUInt32LE(2, 4);
  crx2.writeUInt32LE(3, 8);
  crx2.writeUInt32LE(4, 12);
  zipPayload.copy(crx2, 23);
  assert.deepEqual(Buffer.from(helpers.getCrxZipPayload(crx2)), zipPayload);
  assert.throws(() => helpers.getCrxZipPayload(Buffer.from('not-a-crx')), /valid CRX/);

  const destination = path.join(os.tmpdir(), 'faceit-marketplace-safe-root');
  assert.equal(helpers.resolveZipEntryPath(destination, 'assets/icon.png'), path.join(destination, 'assets', 'icon.png'));
  for (const unsafe of ['../escape.js', '/absolute.js', 'C:/escape.js', 'folder\\escape.js']) {
    assert.throws(() => helpers.resolveZipEntryPath(destination, unsafe), /unsafe|invalid/);
  }
  assert.equal(helpers.compareVersions('5.6.10', '5.6.9') > 0, true);
  assert.equal(helpers.compareVersions('1.0', '1.0.0'), 0);
});

async function createFakeFaceitAsar(destination, version) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-faceit-app-'));
  try {
    fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify({
      name: '@faceit/client',
      version,
      type: 'commonjs',
      main: 'main.js',
      appId: 'com.faceit.client',
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(source, 'main.js'), 'module.exports = { started: true };\n');
    const nativeDir = path.join(source, 'build', 'win32', 'x64');
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'odin.node'), 'fake native module');
    await createAsarPackage(source, destination, {
      unpack: '{**/*.node,**/*.dll,**/*.exe}',
    });
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
  }
}

async function rewriteAppliedLoaderVersion(asarPath, version) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-faceit-version-'));
  const output = path.join(os.tmpdir(), `fake-faceit-version-${process.pid}-${Date.now()}.asar`);
  try {
    asar.extractAll(asarPath, source);
    const appliedPath = path.join(source, 'mod', '.applied');
    const packagePath = path.join(source, 'package.json');
    const applied = JSON.parse(fs.readFileSync(appliedPath, 'utf8'));
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    applied.version = version;
    packageJson.faceitExtensionLoader.version = version;
    fs.writeFileSync(appliedPath, `${JSON.stringify(applied, null, 2)}\n`);
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    await createAsarPackage(source, output, { unpack: '{**/*.node,**/*.dll,**/*.exe}' });
    fs.copyFileSync(output, asarPath);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.unpacked`, { recursive: true, force: true });
  }
}

const silentLogger = {
  log() {},
  warn() {},
  info() {},
};

async function createAsarPackage(source, destination, options) {
  const stream = await asar.createPackageWithOptions(source, destination, options);
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

function loadBootstrapTestFunctions() {
  const bootstrapPath = path.join(__dirname, '..', 'mod', 'bootstrap.js');
  const source = `${fs.readFileSync(bootstrapPath, 'utf8')}\nmodule.exports = { getCrxZipPayload, resolveZipEntryPath, compareVersions, injectCompatScriptIntoHtml, parseDeepLink, resolveDeepLinkInstallTarget, parseChromeWebStoreExtensionId, getExtensionWindowPosition, getExtensionWorkArea, prependContentScriptCompat, openEmbeddedExtensionAction, layoutEmbeddedExtensionAction, closeEmbeddedExtensionAction, embeddedExtensionActions };`;
  const context = {
    Buffer,
    URL,
    URLSearchParams,
    __dirname: path.dirname(bootstrapPath),
    console: silentLogger,
    module: { exports: {} },
    process,
    require(request) {
      if (request === 'electron') {
        throw new Error('Electron is intentionally unavailable in unit tests');
      }
      if (request === './update-hook') {
        return require(path.join(path.dirname(bootstrapPath), 'update-hook.js'));
      }
      if (typeof request === 'string' && path.isAbsolute(request) && request.endsWith(`${path.sep}main.js`)) {
        return {};
      }
      return require(request);
    },
    setImmediate,
    setTimeout,
  };
  vm.runInNewContext(source, context, { filename: bootstrapPath });
  return context.module.exports;
}
