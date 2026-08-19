'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const yauzl = require('yauzl');
const { installFaceitUpdateHook } = require('./update-hook');

const APPLIED_MARKER = path.join(__dirname, '.applied');
const DEFAULT_ORIGINAL_MAIN = 'main.js';
const EXTENSION_API_PRELOAD = path.join(__dirname, 'dist', 'chrome-extension-api.preload.js');
const BROWSER_ACTION_PRELOAD = path.join(__dirname, 'browser-action-preload.js');
const TOOLBAR_PRELOAD = path.join(__dirname, 'extension-toolbar-preload.js');
const ACTION_POPUP_PRELOAD = path.join(__dirname, 'action-popup-preload.js');
const EXTENSION_COMPAT = path.join(__dirname, 'extension-compat.js');
const MAIN_WORLD_COMPAT = path.join(__dirname, 'extension-main-world-compat.js');
const MAIN_WORLD_BRIDGE = path.join(__dirname, 'extension-main-world-bridge.js');
const MARKETPLACE_PATH = path.join(__dirname, 'marketplace.json');
const EXTENSION_COMPAT_NAME = 'faceit-loader-extension-compat.js';
const BACKGROUND_COMPAT_WRAPPER_NAME = 'faceit-loader-background-wrapper.js';
const MAIN_WORLD_CONFIG_NAME = 'faceit-loader-main-world-config.js';
const MAIN_WORLD_COMPAT_NAME = 'faceit-loader-main-world-compat.js';
const MAIN_WORLD_BRIDGE_NAME = 'faceit-loader-main-world-bridge.js';
const COMPAT_CACHE_SCHEMA_VERSION = 5;
const IPC_GET_STATE = 'faceit-extension-loader:get-state';
const IPC_ACTIVATE_ACTION = 'faceit-extension-loader:activate-action';
const IPC_MANAGE_EXTENSION = 'faceit-extension-loader:manage-extension';
const IPC_RENDERER_LOG = 'faceit-extension-loader:renderer-log';
const IPC_DEEP_LINK = 'faceit-extension-loader:deep-link';
const IPC_ACTION_POPUP_CONTROL = 'faceit-extension-loader:action-popup-control';
const IPC_ACTION_POPUP_HOST = 'faceit-extension-loader:action-popup-host';
const IPC_ACTION_POPUP_STATE = 'faceit-extension-loader:action-popup-state';
const LEGACY_DEEP_LINK_PROTOCOL = 'faceit-mods';
const ADDONPORT_DEEP_LINK_PROTOCOL = 'addonport';
const ADDONPORT_CONNECT_ORIGIN = 'https://connect.addonport.dev';
const ADDONPORT_RESPONSE_LIMIT = 64 * 1024;
const ADDONPORT_REQUEST_TIMEOUT = 8000;
const RECENT_LOG_LINE_LIMIT = 140;
const MARKETPLACE_DOWNLOAD_LIMIT = 96 * 1024 * 1024;
const MARKETPLACE_EXTRACT_LIMIT = 256 * 1024 * 1024;
const MARKETPLACE_ENTRY_LIMIT = 20000;
const MARKETPLACE_REDIRECT_LIMIT = 6;
const MARKETPLACE_DOWNLOAD_HOSTS = new Set([
  'clients2.google.com',
  'clients2.googleusercontent.com',
]);
const ALLOWED_EXTENSION_ORIGINS = new Set([
  'https://www.faceit.com/*',
  'https://api.faceit.com/*',
  'https://open.faceit.com/*',
]);
const ALLOWED_RUNTIME_PERMISSIONS = new Set([
  'clipboardWrite',
  'storage',
]);
const extensionSurfaceWindows = new Map();
const embeddedExtensionActions = new Map();
const queuedDeepLinks = [];

let pendingInstallRequest = null;
let pendingNavigationRequest = null;
let pendingAddonPortSession = null;
let addonPortConnectGeneration = 0;
let deepLinkRuntime = null;

let electron;

try {
  electron = require('electron');
  registerExtensionLoader(electron);
} catch (error) {
  earlyLog('failed to register extension loader', error);
}

module.exports = require(resolveOriginalMainPath());

function registerExtensionLoader({ app, autoUpdater, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell }) {
  const originalWhenReady = app.whenReady.bind(app);
  let bootstrapLogger;
  let setupPromise = null;

  try {
    bootstrapLogger = createLogger(app);
  } catch (error) {
    earlyLog('could not open the early update-hook log; continuing with console logging', error);
    bootstrapLogger = {
      info(message) { earlyLog(message); },
      warn(message, warning) { earlyLog(message, warning); },
    };
  }
  installFaceitUpdateHook({ autoUpdater, logger: bootstrapLogger });

  queueDeepLinksFromArguments(process.argv);
  app.on('second-instance', (_event, commandLine) => queueDeepLinksFromArguments(commandLine));
  app.on('open-url', (event, value) => {
    if (!isSupportedDeepLink(value)) return;
    event.preventDefault();
    queueDeepLink(value);
  });

  function ensureSetup() {
    if (!setupPromise) {
      setupPromise = originalWhenReady()
        .then(() => setupExtensionLoader({ app, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell }))
        .catch((error) => {
          earlyLog('extension loader setup failed', error);
        });
    }
    return setupPromise;
  }

  app.whenReady = function patchedWhenReady() {
    return originalWhenReady().then(() => ensureSetup());
  };

  originalWhenReady().then(() => ensureSetup()).catch((error) => {
    earlyLog('extension loader failed during app.whenReady', error);
  });
}

async function setupExtensionLoader({ app, BrowserView, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell }) {
  const logger = createLogger(app);
  const browserSession = session.defaultSession;

  if (!browserSession || !browserSession.extensions || typeof browserSession.extensions.loadExtension !== 'function') {
    logger.warn('session.defaultSession.extensions.loadExtension is unavailable');
    return;
  }

  const bridge = createChromeExtensionBridge({
    BrowserWindow,
    browserSession,
    logger,
  });

  installToolbarPreload({
    browserSession,
    logger,
  });

  trackWindows({
    BrowserWindow,
    app,
    browserSession,
    bridge,
    logger,
  });

  const registry = ensureRegistry(app, logger);
  const loadedExtensions = await loadInstalledExtensions({
    bridge,
    browserSession,
    logger,
    registry,
  });

  registerExtensionLoaderIpc({
    app,
    BrowserView,
    BrowserWindow,
    browserSession,
    bridge,
    clipboard,
    dialog,
    ipcMain,
    loadedExtensions,
    logger,
    registry,
    screen,
    shell,
  });

  initializeDeepLinks({ BrowserWindow, logger });
}

function initializeDeepLinks({ BrowserWindow, logger }) {
  deepLinkRuntime = { BrowserWindow, logger };
  while (queuedDeepLinks.length > 0) {
    processDeepLink(queuedDeepLinks.shift(), deepLinkRuntime);
  }
}

function queueDeepLinksFromArguments(args) {
  for (const value of toArray(args)) {
    if (isSupportedDeepLink(value)) queueDeepLink(value);
  }
}

function queueDeepLink(value) {
  if (deepLinkRuntime) {
    processDeepLink(value, deepLinkRuntime);
    return;
  }
  queuedDeepLinks.push(value);
}

function isSupportedDeepLink(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return normalized.startsWith(`${LEGACY_DEEP_LINK_PROTOCOL}://`)
    || normalized.startsWith(`${ADDONPORT_DEEP_LINK_PROTOCOL}://`);
}

function parseDeepLink(value) {
  const url = new URL(value);
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Unsupported AddonPort link');
  }
  if (url.protocol === `${ADDONPORT_DEEP_LINK_PROTOCOL}:`) {
    const action = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    if (action === 'open' && segments.length === 0) {
      return { action, href: `${ADDONPORT_DEEP_LINK_PROTOCOL}://open` };
    }
    if (['install', 'launch'].includes(action) && segments.length === 1
        && /^[a-z0-9-]{1,64}$/.test(segments[0])) {
      return {
        action,
        href: `${ADDONPORT_DEEP_LINK_PROTOCOL}://${action}/${segments[0]}`,
        target: segments[0],
      };
    }
    if (action !== 'connect' || segments.length !== 2) {
      throw new Error('Unsupported AddonPort link');
    }
    const [sessionId, claimToken] = segments;
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(sessionId)
        || !/^[A-Za-z0-9_-]{32,128}$/.test(claimToken)) {
      throw new Error('The AddonPort session link is malformed');
    }
    return {
      action: 'connect',
      claimToken,
      href: `${ADDONPORT_DEEP_LINK_PROTOCOL}://connect/${sessionId}/${claimToken}`,
      sessionId,
    };
  }
  if (url.protocol !== `${LEGACY_DEEP_LINK_PROTOCOL}:`) {
    throw new Error('Unsupported AddonPort link');
  }
  const action = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (action === 'open' && segments.length === 0) {
    return { action, href: `${LEGACY_DEEP_LINK_PROTOCOL}://open` };
  }
  if (!['install', 'launch'].includes(action) || segments.length !== 1 || !/^[a-z0-9-]{1,64}$/.test(segments[0])) {
    throw new Error('The legacy AddonPort link contains an unsupported action or target');
  }
  const target = segments[0];
  return {
    action,
    href: `${LEGACY_DEEP_LINK_PROTOCOL}://${action}/${target}`,
    target,
  };
}

function processDeepLink(value, { BrowserWindow, logger }) {
  try {
    const parsed = parseDeepLink(value);
    if (parsed.action === 'connect') {
      void processAddonPortConnect(parsed, { BrowserWindow, logger });
      return;
    }
    addonPortConnectGeneration += 1;
    rejectPendingAddonPortSession('A direct AddonPort link replaced this request', logger);
    const request = {
      action: parsed.action,
      href: parsed.href,
      requestedAt: new Date().toISOString(),
      token: crypto.randomUUID(),
    };
    if (parsed.action === 'install') {
      const installTarget = resolveDeepLinkInstallTarget(parsed.target);
      pendingNavigationRequest = null;
      pendingInstallRequest = { ...request, ...installTarget };
      logger.info(`received install request for ${installTarget.marketplaceId
        ? `catalog extension ${installTarget.marketplaceId}`
        : `Chrome Web Store extension ${installTarget.extensionId}`}`);
    } else {
      pendingInstallRequest = null;
      pendingNavigationRequest = { ...request, ...(parsed.target ? { target: parsed.target } : {}) };
      logger.info(`received ${parsed.action} request${parsed.target ? ` for ${parsed.target}` : ''}`);
    }
    focusFaceitWindow(BrowserWindow);
    notifyDeepLinkRenderers(BrowserWindow, pendingInstallRequest || pendingNavigationRequest);
  } catch (error) {
    logger.warn('rejected extension loader link', error);
  }
}

async function processAddonPortConnect(parsed, { BrowserWindow, logger }) {
  const generation = addonPortConnectGeneration + 1;
  addonPortConnectGeneration = generation;
  try {
    rejectPendingAddonPortSession('A newer AddonPort request replaced this session', logger);
    pendingInstallRequest = null;
    pendingNavigationRequest = null;

    const snapshot = await requestAddonPortSession({
      action: 'claim',
      claimToken: parsed.claimToken,
      sessionId: parsed.sessionId,
      body: {
        client: {
          adapter: 'addonport-for-faceit',
          platform: process.platform,
          version: readAppliedLoaderVersion(),
        },
      },
    });
    if (generation !== addonPortConnectGeneration) {
      await requestAddonPortSession({
        action: 'transition',
        body: { state: 'rejected', result: { message: 'A newer AddonPort request replaced this session' } },
        claimToken: parsed.claimToken,
        sessionId: parsed.sessionId,
      }).catch(() => null);
      return;
    }
    const intent = validateAddonPortSnapshot(snapshot, parsed.sessionId);
    const request = {
      action: intent.action,
      href: `${ADDONPORT_DEEP_LINK_PROTOCOL}://connect`,
      requestedAt: new Date().toISOString(),
      token: crypto.randomUUID(),
    };
    pendingAddonPortSession = {
      claimToken: parsed.claimToken,
      requestToken: request.token,
      sessionId: parsed.sessionId,
      transitionPromise: Promise.resolve(),
    };

    if (intent.action === 'install') {
      const installTarget = resolveDeepLinkInstallTarget(intent.target);
      pendingInstallRequest = { ...request, ...installTarget };
      void reportPendingAddonPortSession('awaiting_confirmation', null, logger);
      logger.info(`received AddonPort install request for ${installTarget.marketplaceId
        ? `catalog extension ${installTarget.marketplaceId}`
        : `Chrome Web Store extension ${installTarget.extensionId}`}`);
    } else {
      pendingNavigationRequest = { ...request, ...(intent.target ? { target: intent.target } : {}) };
      logger.info(`received AddonPort ${intent.action} request${intent.target ? ` for ${intent.target}` : ''}`);
    }
    focusFaceitWindow(BrowserWindow);
    notifyDeepLinkRenderers(BrowserWindow, pendingInstallRequest || pendingNavigationRequest);
  } catch (error) {
    logger.warn('failed to claim AddonPort session', error);
    if (generation === addonPortConnectGeneration) {
      await requestAddonPortSession({
        action: 'transition',
        body: {
          state: 'failed',
          error: { code: 'adapter_error', message: 'AddonPort for FACEIT could not process the request' },
        },
        claimToken: parsed.claimToken,
        sessionId: parsed.sessionId,
      }).catch(() => null);
      pendingAddonPortSession = null;
    }
  }
}

function validateAddonPortSnapshot(snapshot, expectedSessionId) {
  if (!snapshot || snapshot.protocolVersion !== 2 || snapshot.sessionId !== expectedSessionId
      || snapshot.state !== 'client_opened' || !snapshot.intent || typeof snapshot.intent !== 'object') {
    throw new Error('The AddonPort service returned an invalid claim response');
  }
  const { action, target } = snapshot.intent;
  if (action === 'open' && target === undefined) return { action };
  if (!['install', 'launch'].includes(action) || typeof target !== 'string'
      || !/^[a-z0-9-]{1,64}$/.test(target)) {
    throw new Error('The AddonPort session contains an unsupported intent');
  }
  return { action, target };
}

function readAppliedLoaderVersion() {
  try {
    const applied = JSON.parse(fs.readFileSync(APPLIED_MARKER, 'utf8'));
    return typeof applied.version === 'string' && applied.version ? applied.version.slice(0, 32) : 'unknown';
  } catch (_error) {
    return 'unknown';
  }
}

function rejectPendingAddonPortSession(message, logger) {
  if (!pendingAddonPortSession) return;
  void reportPendingAddonPortSession('rejected', { result: { message } }, logger);
  pendingAddonPortSession = null;
}

async function reportPendingAddonPortSession(state, details, logger) {
  const session = pendingAddonPortSession;
  if (!session) return null;
  try {
    const transition = session.transitionPromise.then(() => requestAddonPortSession({
      action: 'transition',
      body: { state, ...(details || {}) },
      claimToken: session.claimToken,
      sessionId: session.sessionId,
    }));
    session.transitionPromise = transition.catch(() => null);
    return await transition;
  } catch (error) {
    if (logger) logger.warn(`failed to report AddonPort session state ${state}`, error);
    return null;
  }
}

function clearPendingAddonPortSession(requestToken) {
  if (pendingAddonPortSession && pendingAddonPortSession.requestToken === requestToken) {
    pendingAddonPortSession = null;
  }
}

function requestAddonPortSession({ action, body, claimToken, sessionId }) {
  return new Promise((resolve, reject) => {
    if (!['claim', 'transition'].includes(action)
        || !/^[A-Za-z0-9_-]{20,64}$/.test(sessionId)
        || !/^[A-Za-z0-9_-]{32,128}$/.test(claimToken)) {
      reject(new Error('Invalid AddonPort session request'));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const endpoint = new URL(`/v2/sessions/${sessionId}/${action}`, ADDONPORT_CONNECT_ORIGIN);
    const request = https.request(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${claimToken}`,
        'Content-Length': payload.length,
        'Content-Type': 'application/json',
        'User-Agent': `AddonPort-for-FACEIT/${readAppliedLoaderVersion()}`,
      },
    }, (response) => {
      const chunks = [];
      let byteCount = 0;
      response.on('data', (chunk) => {
        byteCount += chunk.length;
        if (byteCount > ADDONPORT_RESPONSE_LIMIT) {
          response.destroy(new Error('AddonPort response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const statusCode = response.statusCode || 0;
        let result;
        try {
          result = JSON.parse(Buffer.concat(chunks, byteCount).toString('utf8'));
        } catch (_error) {
          reject(new Error('AddonPort returned an invalid JSON response'));
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          const message = result && result.error && typeof result.error.message === 'string'
            ? result.error.message
            : `AddonPort request failed with HTTP ${statusCode}`;
          reject(new Error(message));
          return;
        }
        resolve(result);
      });
      response.on('error', reject);
    });
    request.setTimeout(ADDONPORT_REQUEST_TIMEOUT, () => request.destroy(new Error('AddonPort request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

function focusFaceitWindow(BrowserWindow) {
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
  const browserWindow = BrowserWindow.getAllWindows().find((candidate) => {
    if (!candidate || candidate.isDestroyed() || !candidate.webContents || candidate.webContents.isDestroyed()) return false;
    return isTrustedFaceitUrl(candidate.webContents.getURL());
  });
  if (!browserWindow) return;
  if (browserWindow.isMinimized()) browserWindow.restore();
  browserWindow.show();
  browserWindow.focus();
}

function notifyDeepLinkRenderers(BrowserWindow, details) {
  if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') return;
  for (const browserWindow of BrowserWindow.getAllWindows()) {
    if (!browserWindow || browserWindow.isDestroyed() || !browserWindow.webContents || browserWindow.webContents.isDestroyed()) continue;
    if (isTrustedFaceitUrl(browserWindow.webContents.getURL())) {
      browserWindow.webContents.send(IPC_DEEP_LINK, details || null);
    }
  }
}

function isTrustedFaceitUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'faceit.com' || host.endsWith('.faceit.com'));
  } catch (_error) {
    return false;
  }
}

function createChromeExtensionBridge({ BrowserWindow, browserSession, logger }) {
  try {
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    ElectronChromeExtensions.handleCRXProtocol(browserSession);
    if (!fs.existsSync(EXTENSION_API_PRELOAD)) {
      logger.warn(`patched extension API preload is missing: ${EXTENSION_API_PRELOAD}`);
    }
    return new ElectronChromeExtensions({
      license: 'GPL-3.0',
      modulePath: __dirname,
      session: browserSession,
      selectTab(tab) {
        const owner = BrowserWindow.fromWebContents(tab);
        if (owner && !owner.isDestroyed()) {
          owner.focus();
        }
      },
      removeTab(tab) {
        const owner = BrowserWindow.fromWebContents(tab);
        if (owner && !owner.isDestroyed()) {
          owner.close();
        }
      },
      requestPermissions(extension, request) {
        const decision = evaluateRuntimePermissionRequest(request);
        const extensionName = getExtensionLabel(extension);

        if (!decision.allowed) {
          logger.warn(`denied runtime permission request from ${extensionName}: ${JSON.stringify({
            request,
            deniedOrigins: decision.deniedOrigins,
            deniedPermissions: decision.deniedPermissions,
          })}`);
          return Promise.resolve(false);
        }

        logger.info(`granted runtime permission request from ${extensionName}: ${JSON.stringify(request || {})}`);
        return Promise.resolve(true);
      },
    });
  } catch (error) {
    logger.warn('electron-chrome-extensions bridge is unavailable; built-in Electron extension APIs may still work', error);
    return null;
  }
}

function trackWindows({ BrowserWindow, app, browserSession, bridge, logger }) {
  if (!bridge) {
    return;
  }

  const tracked = new WeakSet();

  function track(browserWindow) {
    if (!browserWindow || browserWindow.isDestroyed()) {
      return;
    }

    const webContents = browserWindow.webContents;
    if (!webContents || webContents.isDestroyed() || tracked.has(webContents)) {
      return;
    }

    if (webContents.session && webContents.session !== browserSession) {
      return;
    }

    try {
      bridge.addTab(webContents, browserWindow);
      bridge.selectTab(webContents);
      tracked.add(webContents);
      logger.info(`tracking BrowserWindow webContents=${webContents.id}`);

      browserWindow.on('focus', () => {
        if (!webContents.isDestroyed()) {
          bridge.selectTab(webContents);
        }
      });

      webContents.once('destroyed', () => {
        try {
          bridge.removeTab(webContents);
        } catch (error) {
          logger.warn(`failed to untrack webContents=${webContents.id}`, error);
        }
      });
    } catch (error) {
      logger.warn(`failed to track BrowserWindow webContents=${webContents && webContents.id}`, error);
    }
  }

  for (const browserWindow of BrowserWindow.getAllWindows()) {
    track(browserWindow);
  }

  app.on('browser-window-created', (_event, browserWindow) => {
    setImmediate(() => track(browserWindow));
  });
}

async function loadInstalledExtensions({ bridge, browserSession, logger, registry }) {
  const entries = Array.isArray(registry.extensions) ? registry.extensions : [];
  const results = [];

  for (const entry of entries) {
    results.push(await loadExtensionEntry({
      bridge,
      browserSession,
      entry,
      logger,
      registry,
    }));
  }

  return results;
}

async function loadExtensionEntry({ bridge, browserSession, entry, logger, registry }) {
  if (!entry || entry.enabled === false) {
    return createExtensionStatus({ entry, registry, state: 'disabled' });
  }

  const extensionPath = resolveExtensionPath(entry, registry);
  if (!extensionPath) {
    logger.warn(`skipping registry entry without path: ${JSON.stringify(entry)}`);
    return createExtensionStatus({ entry, registry, state: 'invalid', error: 'missing path' });
  }

  const manifest = readExtensionManifest(extensionPath);
  if (!manifest) {
    logger.warn(`skipping invalid unpacked extension: ${extensionPath}`);
    return createExtensionStatus({
      entry,
      extensionPath,
      registry,
      state: 'invalid',
      error: 'invalid unpacked extension',
    });
  }

  try {
    const loadPlan = prepareExtensionForLoad({
      entry,
      extensionPath,
      logger,
      registry,
    });
    const extension = await browserSession.extensions.loadExtension(loadPlan.loadPath, {
      allowFileAccess: Boolean(entry.allowFileAccess),
    });
    registerBridgeAction({ bridge, extension, logger });
    grantKnownFaceitPermissions({ bridge, extension, logger });
    const loadSuffix = loadPlan.loadPath !== extensionPath ? ` via compatibility copy ${loadPlan.loadPath}` : '';
    logger.info(`loaded extension ${extension.name || extension.id || path.basename(extensionPath)} from ${extensionPath}${loadSuffix}`);
    return createExtensionStatus({
      entry,
      extension,
      extensionPath,
      loadPath: loadPlan.loadPath,
      manifest,
      registry,
      state: 'loaded',
    });
  } catch (error) {
    logger.warn(`failed to load extension from ${extensionPath}`, error);
    return createExtensionStatus({
      entry,
      extensionPath,
      manifest,
      registry,
      state: 'failed',
      error: error && error.message ? error.message : String(error),
    });
  }
}

function registerBridgeAction({ bridge, extension, logger }) {
  if (bridge && bridge.api && bridge.api.browserAction && typeof bridge.api.browserAction.processExtension === 'function') {
    try {
      bridge.api.browserAction.processExtension(extension);
      return;
    } catch (error) {
      logger.warn(`failed to process action for ${extension && extension.id ? extension.id : 'extension'}`, error);
    }
  }

  if (!bridge || typeof bridge.addExtension !== 'function') {
    return;
  }

  try {
    bridge.addExtension(extension);
  } catch (error) {
    logger.warn(`failed to register action for ${extension && extension.id ? extension.id : 'extension'}`, error);
  }
}

function grantKnownFaceitPermissions({ bridge, extension, logger }) {
  const permissionsApi = bridge && bridge.api && bridge.api.permissions;
  const permissionMap = permissionsApi && permissionsApi.permissionMap;
  if (!extension || !extension.id || !permissionMap || typeof permissionMap.get !== 'function' || typeof permissionMap.set !== 'function') {
    return;
  }

  try {
    if (typeof permissionsApi.processExtension === 'function') {
      permissionsApi.processExtension(extension);
    }

    const current = permissionMap.get(extension.id) || {};
    const currentPermissions = Array.isArray(current.permissions) ? current.permissions : [];
    const currentOrigins = Array.isArray(current.origins) ? current.origins : [];
    const originsToGrant = collectKnownFaceitOrigins(extension.manifest);
    const nextOrigins = uniqueStrings([...currentOrigins, ...originsToGrant]);
    const nextPermissions = uniqueStrings(currentPermissions);

    permissionMap.set(extension.id, {
      permissions: nextPermissions,
      origins: nextOrigins,
    });

    const addedOrigins = nextOrigins.filter((origin) => !currentOrigins.includes(origin));
    if (addedOrigins.length > 0) {
      logger.info(`granted static FACEIT origins to ${getExtensionLabel(extension)}: ${JSON.stringify(addedOrigins)}`);
    } else {
      logger.info(`static FACEIT origins already granted for ${getExtensionLabel(extension)}: ${JSON.stringify(nextOrigins.filter(isAllowedExtensionOrigin))}`);
    }
  } catch (error) {
    logger.warn(`failed to grant static FACEIT origins for ${getExtensionLabel(extension)}`, error);
  }
}

function collectKnownFaceitOrigins(manifest) {
  const candidates = [
    ...toArray(manifest && manifest.host_permissions),
  ];

  for (const contentScript of toArray(manifest && manifest.content_scripts)) {
    candidates.push(...toArray(contentScript && contentScript.matches));
  }

  return uniqueStrings(candidates.filter(isAllowedExtensionOrigin));
}

function prepareExtensionForLoad({ entry, extensionPath, logger, registry }) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = readJsonFile(manifestPath);

  if (!needsExtensionCompat(manifest)) {
    return {
      loadPath: extensionPath,
      compatApplied: false,
    };
  }

  if (!fs.existsSync(EXTENSION_COMPAT)) {
    logger.warn(`extension compatibility shim is missing: ${EXTENSION_COMPAT}`);
    return {
      loadPath: extensionPath,
      compatApplied: false,
    };
  }

  const cacheRoot = path.join(registry.__baseDir || path.dirname(registry.__registryPath || extensionPath), 'compat-cache');
  if (isSameOrChildPath(extensionPath, cacheRoot)) {
    logger.info(`extension already lives in compatibility cache, loading directly: ${extensionPath}`);
    return {
      loadPath: extensionPath,
      compatApplied: false,
    };
  }

  const loadPath = path.join(cacheRoot, createCompatCacheName({ extensionPath, manifest }));
  fs.rmSync(loadPath, { recursive: true, force: true });
  fs.mkdirSync(loadPath, { recursive: true });
  fs.cpSync(extensionPath, loadPath, {
    recursive: true,
    force: true,
  });

  fs.copyFileSync(EXTENSION_COMPAT, path.join(loadPath, EXTENSION_COMPAT_NAME));

  const manifestCopy = readJsonFile(path.join(loadPath, 'manifest.json'));
  const manifestForMainWorld = JSON.parse(JSON.stringify(manifestCopy));
  const hasMainWorldScripts = hasMainWorldContentScripts(manifestCopy);
  if (hasMainWorldScripts) {
    if (!fs.existsSync(MAIN_WORLD_COMPAT) || !fs.existsSync(MAIN_WORLD_BRIDGE)) {
      throw new Error('MAIN-world compatibility files are missing');
    }
    const channel = createMainWorldChannel({ extensionPath, manifest: manifestForMainWorld });
    const configSource = createMainWorldConfigSource({
      channel,
      extensionIdHint: entry && entry.id,
      manifest: manifestForMainWorld,
    });
    fs.writeFileSync(path.join(loadPath, MAIN_WORLD_CONFIG_NAME), configSource);
    fs.copyFileSync(MAIN_WORLD_COMPAT, path.join(loadPath, MAIN_WORLD_COMPAT_NAME));
    fs.copyFileSync(MAIN_WORLD_BRIDGE, path.join(loadPath, MAIN_WORLD_BRIDGE_NAME));
  }
  const contentScriptsChanged = prependContentScriptCompat(manifestCopy);
  const backgroundWrapper = createBackgroundCompatWrapper(manifestCopy);
  const extensionPagesChanged = injectExtensionPageCompat({
    loadPath,
    logger,
    manifest: manifestCopy,
  });
  const changed = contentScriptsChanged || Boolean(backgroundWrapper) || extensionPagesChanged;
  if (!changed) {
    logger.info(`extension compatibility copy was not needed after manifest copy: ${extensionPath}`);
    return {
      loadPath: extensionPath,
      compatApplied: false,
    };
  }

  if (backgroundWrapper) {
    fs.writeFileSync(path.join(loadPath, BACKGROUND_COMPAT_WRAPPER_NAME), backgroundWrapper);
  }

  fs.writeFileSync(path.join(loadPath, 'manifest.json'), `${JSON.stringify(manifestCopy, null, 2)}\n`);
  logger.info(`prepared extension compatibility copy for ${manifest.name || path.basename(extensionPath)}: ${loadPath}`);
  return {
    loadPath,
    compatApplied: true,
  };
}

function readJsonFile(filePath) {
  return JSON.parse(stripJsonBom(fs.readFileSync(filePath, 'utf8')));
}

function needsExtensionCompat(manifest) {
  return needsContentScriptCompat(manifest)
    || needsBackgroundServiceWorkerCompat(manifest)
    || collectExtensionPagePaths(manifest).length > 0;
}

function needsContentScriptCompat(manifest) {
  return toArray(manifest && manifest.content_scripts).some((contentScript) => {
    if (!shouldPatchContentScript(contentScript)) return false;
    const scripts = toArray(contentScript.js);
    return isMainWorldContentScript(contentScript)
      ? !scripts.includes(MAIN_WORLD_COMPAT_NAME)
      : !scripts.includes(EXTENSION_COMPAT_NAME);
  });
}

function prependContentScriptCompat(manifest) {
  let changed = false;
  const bridgeScripts = [];
  const contentScripts = toArray(manifest && manifest.content_scripts);

  for (const contentScript of contentScripts) {
    if (!shouldPatchContentScript(contentScript)) {
      continue;
    }

    const scripts = toArray(contentScript.js).filter((scriptPath) => ![
      EXTENSION_COMPAT_NAME,
      MAIN_WORLD_CONFIG_NAME,
      MAIN_WORLD_COMPAT_NAME,
      MAIN_WORLD_BRIDGE_NAME,
    ].includes(scriptPath));
    if (isMainWorldContentScript(contentScript)) {
      contentScript.js = [MAIN_WORLD_CONFIG_NAME, MAIN_WORLD_COMPAT_NAME, ...scripts];
      bridgeScripts.push(createMainWorldBridgeContentScript(contentScript));
    } else {
      contentScript.js = [EXTENSION_COMPAT_NAME, ...scripts];
    }
    changed = true;
  }

  if (bridgeScripts.length > 0) {
    manifest.content_scripts = [...bridgeScripts, ...contentScripts];
  }

  return changed;
}

function shouldPatchContentScript(contentScript) {
  if (!contentScript || typeof contentScript !== 'object') {
    return false;
  }

  return toArray(contentScript.js).some((scriptPath) => typeof scriptPath === 'string' && scriptPath.length > 0);
}

function hasMainWorldContentScripts(manifest) {
  return toArray(manifest && manifest.content_scripts).some((contentScript) => {
    return shouldPatchContentScript(contentScript) && isMainWorldContentScript(contentScript);
  });
}

function isMainWorldContentScript(contentScript) {
  return String(contentScript && contentScript.world || '').toUpperCase() === 'MAIN';
}

function createMainWorldBridgeContentScript(contentScript) {
  const bridge = {
    matches: [...toArray(contentScript.matches)],
    js: [MAIN_WORLD_CONFIG_NAME, MAIN_WORLD_BRIDGE_NAME],
    run_at: contentScript.run_at || 'document_idle',
    world: 'ISOLATED',
  };
  for (const key of ['exclude_matches', 'include_globs', 'exclude_globs']) {
    if (Array.isArray(contentScript[key])) bridge[key] = [...contentScript[key]];
  }
  for (const key of ['all_frames', 'match_about_blank', 'match_origin_as_fallback']) {
    if (typeof contentScript[key] === 'boolean') bridge[key] = contentScript[key];
  }
  return bridge;
}

function createMainWorldChannel({ extensionPath, manifest }) {
  return crypto.createHash('sha256')
    .update(String(COMPAT_CACHE_SCHEMA_VERSION))
    .update('\0')
    .update(path.resolve(extensionPath))
    .update('\0')
    .update(JSON.stringify(manifest || {}))
    .digest('hex')
    .slice(0, 24);
}

function createMainWorldConfigSource({ channel, extensionIdHint, manifest }) {
  const config = {
    channel,
    extensionIdHint: typeof extensionIdHint === 'string' ? extensionIdHint : '',
    manifest: manifest || {},
  };
  return `'use strict';\nglobalThis.__faceitExtensionLoaderMainWorldConfig = ${JSON.stringify(config)};\n`;
}

function needsBackgroundServiceWorkerCompat(manifest) {
  const serviceWorker = manifest && manifest.background && manifest.background.service_worker;
  return typeof serviceWorker === 'string'
    && serviceWorker.length > 0
    && serviceWorker !== BACKGROUND_COMPAT_WRAPPER_NAME;
}

function createBackgroundCompatWrapper(manifest) {
  if (!needsBackgroundServiceWorkerCompat(manifest)) {
    return null;
  }

  const background = manifest.background;
  const originalServiceWorker = normalizeExtensionResourcePath(background.service_worker);
  if (!originalServiceWorker) {
    return null;
  }

  background.service_worker = BACKGROUND_COMPAT_WRAPPER_NAME;
  if (String(background.type || '').toLowerCase() === 'module') {
    return `import ${JSON.stringify(`./${EXTENSION_COMPAT_NAME}`)};\nimport ${JSON.stringify(`./${originalServiceWorker}`)};\n`;
  }

  return `importScripts(${JSON.stringify(EXTENSION_COMPAT_NAME)}, ${JSON.stringify(originalServiceWorker)});\n`;
}

function injectExtensionPageCompat({ loadPath, logger, manifest }) {
  const pagePaths = collectExtensionPagePaths(manifest);
  const changedPages = [];

  for (const pagePath of pagePaths) {
    const absolutePagePath = path.join(loadPath, pagePath);
    if (!fs.existsSync(absolutePagePath)) {
      logger.warn(`extension page declared in manifest is missing, skipping compatibility injection: ${pagePath}`);
      continue;
    }

    const html = fs.readFileSync(absolutePagePath, 'utf8');
    const nextHtml = injectCompatScriptIntoHtml(html);
    if (nextHtml === html) {
      continue;
    }

    fs.writeFileSync(absolutePagePath, nextHtml);
    changedPages.push(pagePath);
  }

  if (changedPages.length > 0) {
    logger.info(`injected extension compatibility script into pages: ${JSON.stringify(changedPages)}`);
  }

  return changedPages.length > 0;
}

function collectExtensionPagePaths(manifest) {
  const candidates = [
    manifest && manifest.action && manifest.action.default_popup,
    manifest && manifest.browser_action && manifest.browser_action.default_popup,
    manifest && manifest.page_action && manifest.page_action.default_popup,
    manifest && manifest.options_page,
    manifest && manifest.options_ui && manifest.options_ui.page,
    manifest && manifest.devtools_page,
    manifest && manifest.side_panel && manifest.side_panel.default_path,
  ];

  return uniqueStrings(candidates
    .map(normalizeExtensionPagePath)
    .filter(Boolean));
}

function normalizeExtensionPagePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  const withoutFragment = value.split('#')[0].split('?')[0];
  const normalized = normalizeExtensionResourcePath(withoutFragment);
  if (!normalized || !normalized.toLowerCase().endsWith('.html')) {
    return null;
  }
  return normalized;
}

function injectCompatScriptIntoHtml(html) {
  if (html.includes(EXTENSION_COMPAT_NAME)) {
    return html;
  }

  const scriptTag = `    <script src="/${EXTENSION_COMPAT_NAME}"></script>\n`;
  const headOpenMatch = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headOpenMatch) {
    const insertAt = headOpenMatch.index + headOpenMatch[0].length;
    return `${html.slice(0, insertAt)}\n${scriptTag}${html.slice(insertAt)}`;
  }

  const headCloseIndex = html.search(/<\/head\s*>/i);
  if (headCloseIndex !== -1) {
    return `${html.slice(0, headCloseIndex)}${scriptTag}${html.slice(headCloseIndex)}`;
  }

  const firstScriptIndex = html.search(/<script[\s>]/i);
  if (firstScriptIndex !== -1) {
    return `${html.slice(0, firstScriptIndex)}${scriptTag}${html.slice(firstScriptIndex)}`;
  }

  return `${scriptTag}${html}`;
}

function normalizeExtensionResourcePath(value) {
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function createCompatCacheName({ extensionPath, manifest }) {
  const hash = crypto.createHash('sha256');
  hash.update(String(COMPAT_CACHE_SCHEMA_VERSION));
  hash.update('\0');
  hash.update(path.resolve(extensionPath));
  hash.update('\0');
  hash.update(JSON.stringify(manifest || {}));
  hash.update('\0');
  hash.update(fs.readFileSync(EXTENSION_COMPAT));
  if (fs.existsSync(MAIN_WORLD_COMPAT)) hash.update(fs.readFileSync(MAIN_WORLD_COMPAT));
  if (fs.existsSync(MAIN_WORLD_BRIDGE)) hash.update(fs.readFileSync(MAIN_WORLD_BRIDGE));
  const label = sanitizeCacheLabel(manifest && manifest.name ? manifest.name : path.basename(extensionPath));
  return `${label}-${hash.digest('hex').slice(0, 16)}`;
}

function sanitizeCacheLabel(value) {
  const cleaned = String(value)
    .replace(/__MSG_([^_]+)__/g, '$1')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
  return cleaned || 'extension';
}

function isSameOrChildPath(child, parent) {
  const relativePath = path.relative(path.resolve(parent), path.resolve(child));
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function evaluateRuntimePermissionRequest(request) {
  const origins = toArray(request && request.origins);
  const permissions = toArray(request && request.permissions);
  const deniedOrigins = origins.filter((origin) => !isAllowedExtensionOrigin(origin));
  const deniedPermissions = permissions.filter((permission) => !ALLOWED_RUNTIME_PERMISSIONS.has(permission));

  return {
    allowed: deniedOrigins.length === 0 && deniedPermissions.length === 0,
    deniedOrigins,
    deniedPermissions,
  };
}

function isAllowedExtensionOrigin(origin) {
  return typeof origin === 'string' && ALLOWED_EXTENSION_ORIGINS.has(origin);
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}

function getExtensionLabel(extension) {
  return extension && (extension.name || extension.id) ? (extension.name || extension.id) : 'unknown extension';
}

function createExtensionStatus({ entry, extension, extensionPath, loadPath, manifest, registry, state, error }) {
  const resolvedPath = extensionPath
    || (entry && registry ? resolveExtensionPath(entry, registry) : null)
    || (entry && typeof entry.path === 'string' ? entry.path : undefined);
  const extensionManifest = manifest || (extension && extension.manifest) || readExtensionManifest(resolvedPath);
  const fallbackName = entry && typeof entry.name === 'string' ? entry.name : path.basename(resolvedPath || '');
  const managedExtensionRoot = registry && registry.__baseDir ? path.join(registry.__baseDir, 'extensions') : null;
  const isManagedExtension = Boolean(managedExtensionRoot && resolvedPath && isSameOrChildPath(resolvedPath, managedExtensionRoot));
  return {
    key: createExtensionKey(entry, resolvedPath, extension && extension.id),
    id: extension && extension.id ? extension.id : (entry && typeof entry.id === 'string' ? entry.id : undefined),
    name: extension && extension.name ? extension.name : getManifestLabel(extensionManifest, fallbackName),
    description: extensionManifest && typeof extensionManifest.description === 'string' ? extensionManifest.description : undefined,
    version: extensionManifest && typeof extensionManifest.version === 'string'
      ? extensionManifest.version
      : (entry && typeof entry.version === 'string' ? entry.version : undefined),
    manifestVersion: extensionManifest && Number.isFinite(extensionManifest.manifest_version)
      ? extensionManifest.manifest_version
      : undefined,
    source: entry && entry.source === 'webstore'
      ? 'webstore'
      : (((entry && entry.source === 'marketplace') || isManagedExtension) ? 'marketplace' : 'local'),
    marketplaceId: entry && typeof entry.marketplaceId === 'string' ? entry.marketplaceId : undefined,
    hasAction: Boolean(extensionManifest && (
      extensionManifest.action
      || extensionManifest.browser_action
      || extensionManifest.page_action
    )),
    hasOptions: Boolean(extensionManifest && (
      extensionManifest.options_page
      || (extensionManifest.options_ui && extensionManifest.options_ui.page)
    )),
    permissions: uniqueStrings([
      ...toArray(extensionManifest && extensionManifest.permissions),
      ...toArray(extensionManifest && extensionManifest.host_permissions),
    ]).slice(0, 40),
    path: resolvedPath,
    loadPath,
    enabled: Boolean(entry && entry.enabled !== false),
    state,
    error,
  };
}

function installToolbarPreload({ browserSession, logger }) {
  const preloadPaths = [
    BROWSER_ACTION_PRELOAD,
    TOOLBAR_PRELOAD,
  ];

  for (const preloadPath of preloadPaths) {
    if (!fs.existsSync(preloadPath)) {
      logger.warn(`extension toolbar preload is missing: ${preloadPath}`);
      return;
    }
  }

  if (typeof browserSession.setPreloads !== 'function') {
    logger.warn('session.defaultSession.setPreloads is unavailable; extension toolbar UI cannot be injected');
    return;
  }

  try {
    const existingPreloads = typeof browserSession.getPreloads === 'function' ? browserSession.getPreloads() : [];
    const nextPreloads = [...existingPreloads];
    for (const preloadPath of preloadPaths) {
      const normalizedPreloadPath = normalizeFilesystemPath(preloadPath);
      const hasPreload = nextPreloads.some((existingPath) => normalizeFilesystemPath(existingPath) === normalizedPreloadPath);
      if (!hasPreload) {
        nextPreloads.push(preloadPath);
      }
    }

    if (nextPreloads.length !== existingPreloads.length) {
      browserSession.setPreloads(nextPreloads);
      logger.info(`installed extension toolbar preloads: ${preloadPaths.join(', ')}`);
    }
  } catch (error) {
    logger.warn('failed to install extension toolbar preload', error);
  }
}

function registerExtensionLoaderIpc({
  app,
  BrowserView,
  BrowserWindow,
  browserSession,
  bridge,
  clipboard,
  dialog,
  ipcMain,
  loadedExtensions,
  logger,
  registry,
  screen,
  shell,
}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    logger.warn('ipcMain.handle is unavailable; extension toolbar state API cannot be registered');
    return;
  }

  try {
    if (typeof ipcMain.removeHandler === 'function') {
      ipcMain.removeHandler(IPC_GET_STATE);
      ipcMain.removeHandler(IPC_ACTIVATE_ACTION);
      ipcMain.removeHandler(IPC_MANAGE_EXTENSION);
    }

    const getState = () => createLoaderState({
      app,
      bridge,
      browserSession,
      loadedExtensions,
      registry,
      shell,
    });

    ipcMain.handle(IPC_GET_STATE, (event) => {
      assertTrustedRenderer(event);
      return getState();
    });

    ipcMain.handle(IPC_ACTIVATE_ACTION, (event, details) => {
      assertTrustedRenderer(event);
      return activateBrowserAction({
        bridge,
        details,
        event,
        logger,
      });
    });

    ipcMain.handle(IPC_MANAGE_EXTENSION, (event, request) => {
      assertTrustedRenderer(event);
      return manageExtensionRequest({
        app,
        BrowserView,
        BrowserWindow,
        browserSession,
        bridge,
        clipboard,
        dialog,
        event,
        getState,
        loadedExtensions,
        logger,
        registry,
        request,
        screen,
        shell,
      });
    });

    ipcMain.removeAllListeners(IPC_RENDERER_LOG);
    ipcMain.on(IPC_RENDERER_LOG, (event, payload) => {
      logger.info(`renderer webContents=${event.sender && event.sender.id}: ${formatRendererLogPayload(payload)}`);
    });

    ipcMain.removeAllListeners(IPC_ACTION_POPUP_CONTROL);
    ipcMain.on(IPC_ACTION_POPUP_CONTROL, (event, payload) => {
      assertTrustedRenderer(event);
      if (!payload || payload.operation !== 'close') return;
      const record = embeddedExtensionActions.get(event.sender.id);
      if (record) closeEmbeddedExtensionAction(record, { notifyRenderer: false });
    });

    ipcMain.removeAllListeners(IPC_ACTION_POPUP_HOST);
    ipcMain.on(IPC_ACTION_POPUP_HOST, (event, payload) => {
      const record = findEmbeddedExtensionActionByGuest(event.sender);
      if (!record || !payload || typeof payload !== 'object') return;
      if (payload.operation === 'close') {
        closeEmbeddedExtensionAction(record);
        return;
      }
      if (payload.operation === 'preferred-size') {
        const width = Number(payload.width);
        const height = Number(payload.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        record.desiredWidth = Math.ceil(width);
        record.desiredHeight = Math.ceil(height);
        layoutEmbeddedExtensionAction(record);
      }
    });

    logger.info(`registered extension toolbar IPC: ${IPC_GET_STATE}, ${IPC_MANAGE_EXTENSION}`);
  } catch (error) {
    logger.warn('failed to register extension toolbar IPC', error);
  }
}

function createLoaderState({ app, bridge, browserSession, loadedExtensions, registry, shell }) {
  const userDataPath = getDataRoot(app);
  const logPath = path.join(userDataPath, 'loader.log');
  const extensions = getLiveExtensionState(browserSession, loadedExtensions);
  const marketplace = createMarketplaceState({ extensions, registry });
  const pendingListing = createPendingInstallListing({
    extensions,
    marketplace,
    pending: pendingInstallRequest,
    registry,
  });
  return {
    actionState: getBrowserActionState(bridge),
    capabilities: {
      desktopShortcuts: process.platform === 'win32' && Boolean(shell && typeof shell.writeShortcutLink === 'function'),
    },
    diagnostics: {
      generatedAt: new Date().toISOString(),
      logPath,
      recentLogs: readRecentLogLines(logPath),
    },
    loader: readAppliedMarker(),
    marketplace,
    pendingInstall: pendingInstallRequest && pendingListing ? {
      ...pendingInstallRequest,
      listing: pendingListing,
    } : null,
    pendingNavigation: pendingNavigationRequest,
    registryPath: registry.__registryPath,
    extensions,
    userDataPath,
  };
}

async function manageExtensionRequest({
  app,
  BrowserView,
  BrowserWindow,
  browserSession,
  bridge,
  clipboard,
  dialog,
  event,
  getState,
  loadedExtensions,
  logger,
  registry,
  request,
  screen,
  shell,
}) {
  const operation = request && typeof request.operation === 'string' ? request.operation : '';
  let pageReloadRequired = false;
  let surfaceResult = null;
  let shortcutPath = null;

  if (operation === 'add-from-folder') {
    if (!dialog || typeof dialog.showOpenDialog !== 'function') {
      throw new Error('Folder picker is unavailable');
    }
    const parent = BrowserWindow && typeof BrowserWindow.fromWebContents === 'function'
      ? BrowserWindow.fromWebContents(event.sender)
      : null;
    const options = {
      title: 'Choose an unpacked browser extension',
      buttonLabel: 'Add extension',
      properties: ['openDirectory'],
    };
    const selection = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !Array.isArray(selection.filePaths) || !selection.filePaths[0]) {
      return { cancelled: true, state: getState() };
    }
    await addExtensionFromPath({
      bridge,
      browserSession,
      extensionPath: selection.filePaths[0],
      loadedExtensions,
      logger,
      registry,
    });
    pageReloadRequired = true;
  } else if (operation === 'install-marketplace' || operation === 'update-marketplace') {
    await installMarketplaceExtension({
      bridge,
      browserSession,
      loadedExtensions,
      logger,
      marketplaceId: request.marketplaceId,
      registry,
    });
    pageReloadRequired = true;
  } else if (operation === 'install-webstore') {
    await installChromeWebStoreExtension({
      bridge,
      browserSession,
      input: request.input,
      loadedExtensions,
      logger,
      registry,
    });
    pageReloadRequired = true;
  } else if (operation === 'install-deeplink') {
    const pending = requirePendingInstallRequest(request.token);
    try {
      if (pending.marketplaceId) {
        await installMarketplaceExtension({
          bridge,
          browserSession,
          loadedExtensions,
          logger,
          marketplaceId: pending.marketplaceId,
          registry,
        });
      } else {
        await installChromeWebStoreExtension({
          bridge,
          browserSession,
          input: pending.extensionId,
          loadedExtensions,
          logger,
          registry,
        });
      }
    } catch (error) {
      if (isPendingAddonPortRequest(request.token)) {
        await reportPendingAddonPortSession('failed', {
          error: {
            code: 'install_failed',
            message: error instanceof Error ? error.message : 'Extension installation failed',
          },
        }, logger);
        clearPendingAddonPortSession(request.token);
      }
      throw error;
    }
    if (isPendingAddonPortRequest(request.token)) {
      await reportPendingAddonPortSession('completed', null, logger);
      clearPendingAddonPortSession(request.token);
    }
    pendingInstallRequest = null;
    notifyDeepLinkRenderers(BrowserWindow, null);
    pageReloadRequired = true;
  } else if (operation === 'dismiss-deeplink') {
    requirePendingInstallRequest(request.token);
    if (isPendingAddonPortRequest(request.token)) {
      await reportPendingAddonPortSession('rejected', {
        result: { message: 'Installation cancelled in FACEIT' },
      }, logger);
      clearPendingAddonPortSession(request.token);
    }
    pendingInstallRequest = null;
    notifyDeepLinkRenderers(BrowserWindow, null);
  } else if (operation === 'ack-deeplink') {
    requirePendingNavigationRequest(request.token);
    if (isPendingAddonPortRequest(request.token)) {
      await reportPendingAddonPortSession('completed', null, logger);
      clearPendingAddonPortSession(request.token);
    }
    pendingNavigationRequest = null;
    notifyDeepLinkRenderers(BrowserWindow, null);
  } else if (operation === 'fail-deeplink') {
    requirePendingNavigationRequest(request.token);
    const failures = {
      not_installed: 'The requested extension is not installed',
      action_unavailable: 'The requested extension does not have an available action',
      launch_failed: 'The requested extension action could not be opened',
    };
    const code = Object.prototype.hasOwnProperty.call(failures, request.reason)
      ? request.reason
      : 'launch_failed';
    if (isPendingAddonPortRequest(request.token)) {
      await reportPendingAddonPortSession('failed', {
        error: { code, message: failures[code] },
      }, logger);
      clearPendingAddonPortSession(request.token);
    }
    pendingNavigationRequest = null;
    notifyDeepLinkRenderers(BrowserWindow, null);
  } else if (operation === 'set-enabled') {
    await setExtensionEnabled({
      bridge,
      browserSession,
      enabled: Boolean(request.enabled),
      key: request.key,
      loadedExtensions,
      logger,
      registry,
    });
    pageReloadRequired = true;
  } else if (operation === 'reload') {
    await reloadManagedExtension({
      bridge,
      browserSession,
      key: request.key,
      loadedExtensions,
      logger,
      registry,
    });
    pageReloadRequired = true;
  } else if (operation === 'remove') {
    await removeManagedExtension({
      browserSession,
      key: request.key,
      loadedExtensions,
      logger,
      registry,
    });
    pageReloadRequired = true;
  } else if (operation === 'open-extension-surface') {
    surfaceResult = await openExtensionSurface({
      BrowserView,
      BrowserWindow,
      browserSession,
      bridge,
      event,
      key: request.key,
      loadedExtensions,
      logger,
      registry,
      screen,
      shell,
      surface: request.surface,
    });
  } else if (operation === 'open-marketplace-page') {
    const listing = findMarketplaceListing(request.marketplaceId);
    if (!shell || typeof shell.openExternal !== 'function') {
      throw new Error('Opening external links is unavailable');
    }
    await shell.openExternal(listing.storeUrl);
  } else if (operation === 'copy-install-link') {
    const listing = findMarketplaceListing(request.marketplaceId);
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      throw new Error('Clipboard is unavailable');
    }
    clipboard.writeText(`${ADDONPORT_DEEP_LINK_PROTOCOL}://install/${listing.id}`);
  } else if (operation === 'create-shortcut') {
    shortcutPath = createDesktopShortcut({
      app,
      key: request.key,
      loadedExtensions,
      logger,
      registry,
      shell,
    });
  } else if (operation === 'open-data-folder') {
    if (!shell || typeof shell.openPath !== 'function') {
      throw new Error('Opening folders is unavailable');
    }
    const openError = await shell.openPath(getDataRoot(app));
    if (openError) {
      throw new Error(openError);
    }
  } else if (operation === 'copy-diagnostics') {
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      throw new Error('Clipboard is unavailable');
    }
    clipboard.writeText(formatDiagnosticsReport(getState()));
  } else {
    throw new Error(`Unknown extension manager operation: ${operation || '(missing)'}`);
  }

  logger.info(`extension manager operation completed: ${operation}`);
  return {
    ok: true,
    pageReloadRequired,
    state: getState(),
    ...(surfaceResult ? { surface: surfaceResult } : {}),
    ...(shortcutPath ? { shortcutPath } : {}),
  };
}

function requirePendingInstallRequest(token) {
  if (!pendingInstallRequest || typeof token !== 'string' || token !== pendingInstallRequest.token) {
    throw new Error('The install request expired; open the link again');
  }
  return pendingInstallRequest;
}

function requirePendingNavigationRequest(token) {
  if (!pendingNavigationRequest || typeof token !== 'string' || token !== pendingNavigationRequest.token) {
    throw new Error('The AddonPort link expired; open it again');
  }
  return pendingNavigationRequest;
}

function isPendingAddonPortRequest(token) {
  return Boolean(pendingAddonPortSession && pendingAddonPortSession.requestToken === token);
}

function createDesktopShortcut({ app, key, loadedExtensions, logger, registry, shell }) {
  if (process.platform !== 'win32' || !shell || typeof shell.writeShortcutLink !== 'function') {
    throw new Error('Desktop shortcuts are unavailable in this FACEIT runtime');
  }
  const launcher = resolveStableFaceitLauncher();
  let deepLink = `${ADDONPORT_DEEP_LINK_PROTOCOL}://open`;
  let shortcutName = 'AddonPort for FACEIT';
  let description = 'Open AddonPort for FACEIT';
  if (typeof key === 'string' && key.length > 0) {
    const status = loadedExtensions.find((candidate) => candidate && candidate.key === key);
    const entry = status && (status.marketplaceId || status.id)
      ? null
      : findRegistryEntryByKey(registry, key);
    const target = status && (status.marketplaceId || status.id)
      ? (status.marketplaceId || status.id)
      : (entry.marketplaceId || entry.id);
    if (typeof target !== 'string' || !/^[a-z0-9-]{1,64}$/.test(target)) {
      throw new Error('This extension does not have a stable shortcut target');
    }
    const extensionName = status && status.name ? status.name : (entry.name || 'Extension');
    deepLink = `${ADDONPORT_DEEP_LINK_PROTOCOL}://launch/${target}`;
    shortcutName = `${extensionName} - FACEIT`;
    description = `Open ${extensionName} in AddonPort for FACEIT`;
  }
  const shortcutPath = path.join(app.getPath('desktop'), `${sanitizeShortcutName(shortcutName)}.lnk`);
  const created = shell.writeShortcutLink(shortcutPath, 'create', {
    target: launcher,
    args: deepLink,
    cwd: path.dirname(launcher),
    description,
    icon: launcher,
    iconIndex: 0,
  });
  if (!created) throw new Error('Windows could not create the desktop shortcut');
  logger.info(`created desktop shortcut: ${shortcutPath} -> ${deepLink}`);
  return shortcutPath;
}

function resolveStableFaceitLauncher() {
  const localAppData = process.env.LOCALAPPDATA;
  const candidate = localAppData && path.join(localAppData, 'FACEIT', 'FACEIT.exe');
  return candidate && fs.existsSync(candidate) ? candidate : process.execPath;
}

function sanitizeShortcutName(value) {
  const cleaned = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return cleaned || 'AddonPort for FACEIT';
}

function readMarketplaceDocument() {
  const document = readJsonFile(MARKETPLACE_PATH);
  if (!document || !Array.isArray(document.extensions)) {
    throw new Error('The bundled marketplace catalog is invalid');
  }
  return document;
}

function getMarketplaceListings() {
  return readMarketplaceDocument().extensions.filter((listing) => {
    return listing
      && typeof listing.id === 'string'
      && /^[a-z0-9-]+$/.test(listing.id)
      && typeof listing.extensionId === 'string'
      && /^[a-p]{32}$/.test(listing.extensionId)
      && typeof listing.storeUrl === 'string';
  });
}

function findMarketplaceListing(marketplaceId) {
  const listing = getMarketplaceListings().find((candidate) => candidate.id === marketplaceId);
  if (!listing) {
    throw new Error('This marketplace extension is not available in the bundled catalog');
  }
  return listing;
}

function resolveDeepLinkInstallTarget(target) {
  const listing = getMarketplaceListings().find((candidate) => (
    candidate.id === target || candidate.extensionId === target
  ));
  if (listing) {
    return {
      extensionId: listing.extensionId,
      marketplaceId: listing.id,
      source: 'marketplace',
    };
  }
  if (/^[a-p]{32}$/.test(target)) {
    return { extensionId: target, source: 'webstore' };
  }
  throw new Error('Install links must use a catalog id or Chrome Web Store extension id');
}

function createPendingInstallListing({ extensions, marketplace, pending, registry }) {
  if (!pending) return null;
  if (pending.marketplaceId) {
    return marketplace.extensions.find((listing) => listing.id === pending.marketplaceId) || null;
  }
  if (!/^[a-p]{32}$/.test(pending.extensionId || '')) return null;
  const installed = extensions.find((extension) => extension && extension.id === pending.extensionId);
  const registryEntry = getRegistryEntries(registry).find((entry) => entry && entry.id === pending.extensionId);
  const installedVersion = installed && installed.version
    ? installed.version
    : registryEntry && registryEntry.version;
  return {
    accent: '#5a5a62',
    author: 'Chrome Web Store',
    compatibility: 'unreviewed',
    extensionId: pending.extensionId,
    id: `webstore-${pending.extensionId}`,
    installed: Boolean(installed || registryEntry),
    installedKey: installed && installed.key,
    installedState: installed && installed.state,
    installedVersion,
    monogram: 'C',
    name: installed && installed.name ? installed.name : 'Chrome Web Store extension',
    permissions: [
      'Permissions declared by the downloaded extension package',
      'Only supported FACEIT origins are granted by AddonPort for FACEIT',
    ],
    source: 'webstore',
    tagline: `Extension id ${pending.extensionId}`,
    updateAvailable: false,
  };
}

function createMarketplaceState({ extensions, registry }) {
  const document = readMarketplaceDocument();
  const listings = getMarketplaceListings().map((listing) => {
    const installed = extensions.find((extension) => extension && (
      extension.marketplaceId === listing.id
      || extension.id === listing.extensionId
    ));
    const registryEntry = getRegistryEntries(registry).find((entry) => entry && (
      entry.marketplaceId === listing.id
      || entry.id === listing.extensionId
    ));
    const installedVersion = installed && installed.version
      ? installed.version
      : registryEntry && registryEntry.version;
    return {
      ...listing,
      installed: Boolean(installed || registryEntry),
      installedVersion,
      installedKey: installed && installed.key,
      installedState: installed && installed.state,
      updateAvailable: Boolean(installedVersion && compareVersions(installedVersion, listing.latestVersion) < 0),
    };
  });
  return {
    schemaVersion: document.schemaVersion,
    updatedAt: document.updatedAt,
    extensions: listings,
  };
}

async function installMarketplaceExtension({
  bridge,
  browserSession,
  loadedExtensions,
  logger,
  marketplaceId,
  registry,
}) {
  const listing = findMarketplaceListing(marketplaceId);
  return installChromeWebStoreListing({
    bridge,
    browserSession,
    listing: { ...listing, source: 'marketplace' },
    loadedExtensions,
    logger,
    registry,
  });
}

async function installChromeWebStoreExtension({
  bridge,
  browserSession,
  input,
  loadedExtensions,
  logger,
  registry,
}) {
  const extensionId = parseChromeWebStoreExtensionId(input);
  const catalogListing = getMarketplaceListings().find((listing) => listing.extensionId === extensionId);
  const listing = catalogListing
    ? { ...catalogListing, source: 'marketplace' }
    : {
      id: `webstore-${extensionId}`,
      extensionId,
      name: 'Chrome Web Store extension',
      source: 'webstore',
    };
  return installChromeWebStoreListing({ bridge, browserSession, listing, loadedExtensions, logger, registry });
}

function parseChromeWebStoreExtensionId(value) {
  const input = String(value || '').trim();
  if (/^[a-p]{32}$/i.test(input)) return input.toLowerCase();
  let parsed;
  try {
    parsed = new URL(input);
  } catch (_error) {
    throw new Error('Paste a Chrome Web Store link or a 32-character extension ID');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'chromewebstore.google.com' && hostname !== 'chrome.google.com') {
    throw new Error('Only Chrome Web Store links are supported');
  }
  const match = parsed.pathname.match(/(?:^|\/)([a-p]{32})(?:\/|$)/i);
  if (!match) throw new Error('The Chrome Web Store link does not contain an extension ID');
  return match[1].toLowerCase();
}

async function installChromeWebStoreListing({
  bridge,
  browserSession,
  listing,
  loadedExtensions,
  logger,
  registry,
}) {
  const managedRoot = path.join(registry.__baseDir, 'extensions');
  fs.mkdirSync(managedRoot, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(managedRoot, `.install-${listing.id}-`));
  const crxPath = path.join(tempRoot, 'extension.crx');
  const zipPath = path.join(tempRoot, 'extension.zip');
  const extractedPath = path.join(tempRoot, 'unpacked');
  const destination = path.join(managedRoot, listing.extensionId);
  const backupPath = path.join(managedRoot, `.previous-${listing.extensionId}-${Date.now()}`);
  const previousEntries = [...getRegistryEntries(registry)];
  const replacedEntries = previousEntries.filter((entry) => isMarketplaceEntryMatch(entry, listing, registry));
  let destinationMoved = false;
  let replacementInstalled = false;

  try {
    logger.info(`downloading marketplace extension ${listing.name} (${listing.extensionId})`);
    const crx = await downloadMarketplaceCrx(listing.extensionId);
    fs.writeFileSync(crxPath, crx);
    fs.writeFileSync(zipPath, getCrxZipPayload(crx));
    fs.mkdirSync(extractedPath, { recursive: true });
    await extractZipSafely(zipPath, extractedPath);

    const manifest = readExtensionManifest(extractedPath);
    if (!manifest) {
      throw new Error('The downloaded package does not contain a valid manifest.json');
    }

    for (const entry of replacedEntries) {
      const key = createExtensionKey(entry, resolveExtensionPath(entry, registry));
      await unloadExtensionStatus({ browserSession, key, loadedExtensions, logger });
      removeExtensionStatus(loadedExtensions, key);
    }

    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backupPath);
      destinationMoved = true;
    }
    fs.renameSync(extractedPath, destination);
    replacementInstalled = true;

    const entry = {
      path: destination,
      enabled: true,
      id: listing.extensionId,
      name: getManifestLabel(manifest, listing.name),
      version: manifest.version,
      source: listing.source,
      ...(listing.source === 'marketplace' ? { marketplaceId: listing.id } : {}),
    };
    const retainedEntries = previousEntries.filter((candidate) => !replacedEntries.includes(candidate));
    persistRegistryExtensions(registry, [...retainedEntries, entry]);

    const status = await loadExtensionEntry({ bridge, browserSession, entry, logger, registry });
    upsertExtensionStatus(loadedExtensions, status);
    if (status.state !== 'loaded') {
      throw new Error(status.error || `${listing.name} could not be loaded after installation`);
    }

    fs.rmSync(backupPath, { recursive: true, force: true });
    for (const previousEntry of replacedEntries) {
      const previousPath = resolveExtensionPath(previousEntry, registry);
      if (previousPath
        && normalizeFilesystemPath(previousPath) !== normalizeFilesystemPath(destination)
        && isSameOrChildPath(previousPath, managedRoot)) {
        try {
          fs.rmSync(previousPath, { recursive: true, force: true });
          logger.info(`removed superseded managed extension directory: ${previousPath}`);
        } catch (cleanupError) {
          logger.warn(`failed to remove superseded managed extension directory: ${previousPath}`, cleanupError);
        }
      }
    }
    logger.info(`installed Chrome Web Store extension ${status.name || listing.name} v${status.version || manifest.version}`);
  } catch (error) {
    logger.warn(`Chrome Web Store installation failed for ${listing.name}; restoring previous state`, error);
    await restoreMarketplaceInstall({
      backupPath,
      bridge,
      browserSession,
      destination,
      destinationMoved,
      loadedExtensions,
      logger,
      previousEntries,
      registry,
      replacedEntries,
      replacementInstalled,
    });
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isMarketplaceEntryMatch(entry, listing, registry) {
  if (!entry) {
    return false;
  }
  if (entry.marketplaceId === listing.id || entry.id === listing.extensionId) {
    return true;
  }
  const extensionPath = resolveExtensionPath(entry, registry);
  const manifest = readExtensionManifest(extensionPath);
  return Boolean(manifest && manifest.key && entry.marketplaceId === listing.id);
}

async function restoreMarketplaceInstall({
  backupPath,
  bridge,
  browserSession,
  destination,
  destinationMoved,
  loadedExtensions,
  logger,
  previousEntries,
  registry,
  replacedEntries,
  replacementInstalled,
}) {
  try {
    if (replacementInstalled) {
      const replacementEntry = getRegistryEntries(registry).find((entry) => entry && entry.path === destination);
      if (replacementEntry) {
        const replacementKey = createExtensionKey(replacementEntry, destination);
        await unloadExtensionStatus({ browserSession, key: replacementKey, loadedExtensions, logger });
        removeExtensionStatus(loadedExtensions, replacementKey);
      }
      fs.rmSync(destination, { recursive: true, force: true });
    }
    if (destinationMoved && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, destination);
    }
    persistRegistryExtensions(registry, previousEntries);
    for (const entry of replacedEntries) {
      const status = await loadExtensionEntry({ bridge, browserSession, entry, logger, registry });
      upsertExtensionStatus(loadedExtensions, status);
    }
  } catch (restoreError) {
    logger.warn('failed to fully restore the previous extension after marketplace installation error', restoreError);
  }
}

function removeExtensionStatus(loadedExtensions, key) {
  const index = loadedExtensions.findIndex((status) => status && status.key === key);
  if (index !== -1) {
    loadedExtensions.splice(index, 1);
  }
}

function downloadMarketplaceCrx(extensionId) {
  const query = new URLSearchParams({
    response: 'redirect',
    prodversion: '150.0.0.0',
    acceptformat: 'crx3',
    x: `id=${extensionId}&installsource=ondemand&uc`,
  });
  return downloadHttpsBuffer(`https://clients2.google.com/service/update2/crx?${query.toString()}`, 0);
}

function downloadHttpsBuffer(url, redirectCount) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_error) {
      reject(new Error('Marketplace download returned an invalid URL'));
      return;
    }
    if (!isAllowedMarketplaceDownloadUrl(parsed)) {
      reject(new Error(`Marketplace download refused an untrusted host: ${parsed.hostname}`));
      return;
    }

    const request = https.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 FACEIT-Mods/0.3',
        Accept: 'application/x-chrome-extension, application/octet-stream',
      },
    }, (response) => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectCount >= MARKETPLACE_REDIRECT_LIMIT) {
          reject(new Error('Marketplace download exceeded the redirect limit'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, parsed).href;
        downloadHttpsBuffer(redirectUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Marketplace download failed with HTTP ${statusCode}`));
        return;
      }

      const declaredLength = Number(response.headers['content-length']) || 0;
      if (declaredLength > MARKETPLACE_DOWNLOAD_LIMIT) {
        response.destroy();
        reject(new Error('Marketplace package exceeds the download size limit'));
        return;
      }

      const chunks = [];
      let byteCount = 0;
      response.on('data', (chunk) => {
        byteCount += chunk.length;
        if (byteCount > MARKETPLACE_DOWNLOAD_LIMIT) {
          response.destroy(new Error('Marketplace package exceeds the download size limit'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks, byteCount)));
      response.on('error', reject);
    });
    request.setTimeout(45000, () => request.destroy(new Error('Marketplace download timed out')));
    request.on('error', reject);
  });
}

function isAllowedMarketplaceDownloadUrl(url) {
  const hostname = String(url && url.hostname || '').toLowerCase();
  return url && url.protocol === 'https:' && (
    MARKETPLACE_DOWNLOAD_HOSTS.has(hostname)
    || hostname.endsWith('.googleusercontent.com')
    || hostname.endsWith('.gvt1.com')
  );
}

function getCrxZipPayload(crx) {
  if (!Buffer.isBuffer(crx) || crx.length < 16 || crx.subarray(0, 4).toString('ascii') !== 'Cr24') {
    throw new Error('The marketplace response is not a valid CRX package');
  }
  const version = crx.readUInt32LE(4);
  let zipOffset;
  if (version === 3) {
    zipOffset = 12 + crx.readUInt32LE(8);
  } else if (version === 2) {
    zipOffset = 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12);
  } else {
    throw new Error(`Unsupported CRX package version: ${version}`);
  }
  if (zipOffset <= 0 || zipOffset + 4 > crx.length || crx.subarray(zipOffset, zipOffset + 2).toString('ascii') !== 'PK') {
    throw new Error('The CRX package does not contain a valid ZIP payload');
  }
  return crx.subarray(zipOffset);
}

function extractZipSafely(zipPath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      lazyEntries: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (openError, zipFile) => {
      if (openError) {
        reject(openError);
        return;
      }

      let entryCount = 0;
      let extractedBytes = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          zipFile.close();
        } catch (_error) {
          // Ignore close errors while reporting the original extraction failure.
        }
        reject(error);
      };

      zipFile.on('error', fail);
      zipFile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      zipFile.on('entry', (entry) => {
        try {
          entryCount += 1;
          extractedBytes += entry.uncompressedSize;
          if (entryCount > MARKETPLACE_ENTRY_LIMIT || extractedBytes > MARKETPLACE_EXTRACT_LIMIT) {
            throw new Error('Marketplace package exceeds extraction safety limits');
          }
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new Error('Encrypted files are not supported in marketplace packages');
          }
          if (isZipSymlink(entry)) {
            throw new Error(`Marketplace package contains a symbolic link: ${entry.fileName}`);
          }

          const targetPath = resolveZipEntryPath(destination, entry.fileName);
          if (entry.fileName.endsWith('/')) {
            fs.mkdirSync(targetPath, { recursive: true });
            zipFile.readEntry();
            return;
          }

          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          zipFile.openReadStream(entry, (streamError, input) => {
            if (streamError) {
              fail(streamError);
              return;
            }
            const output = fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o644 });
            input.on('error', fail);
            output.on('error', fail);
            output.on('finish', () => {
              if (!settled) {
                zipFile.readEntry();
              }
            });
            input.pipe(output);
          });
        } catch (error) {
          fail(error);
        }
      });
      zipFile.readEntry();
    });
  });
}

function resolveZipEntryPath(destination, entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0 || entryName.includes('\0') || entryName.includes('\\')) {
    throw new Error('Marketplace package contains an invalid file path');
  }
  const normalized = path.posix.normalize(entryName);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Marketplace package contains an unsafe file path: ${entryName}`);
  }
  const targetPath = path.resolve(destination, ...normalized.split('/'));
  if (!isSameOrChildPath(targetPath, destination)) {
    throw new Error(`Marketplace package escaped the installation directory: ${entryName}`);
  }
  return targetPath;
}

function isZipSymlink(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0o170000) === 0o120000;
}

function compareVersions(left, right) {
  const leftParts = String(left || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = String(right || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

async function addExtensionFromPath({ bridge, browserSession, extensionPath, loadedExtensions, logger, registry }) {
  const resolvedPath = path.resolve(extensionPath);
  const manifest = readExtensionManifest(resolvedPath);
  if (!manifest) {
    throw new Error('The selected folder does not contain a valid manifest.json');
  }

  const existingEntry = getRegistryEntries(registry).find((entry) => {
    const existingPath = resolveExtensionPath(entry, registry);
    return existingPath && normalizeFilesystemPath(existingPath) === normalizeFilesystemPath(resolvedPath);
  });

  if (existingEntry) {
    const key = createExtensionKey(existingEntry, resolvedPath);
    await setExtensionEnabled({
      bridge,
      browserSession,
      enabled: true,
      key,
      loadedExtensions,
      logger,
      registry,
    });
    return;
  }

  const entry = {
    path: resolvedPath,
    enabled: true,
    name: getManifestLabel(manifest, path.basename(resolvedPath)),
  };
  persistRegistryExtensions(registry, [...getRegistryEntries(registry), entry]);
  const status = await loadExtensionEntry({ bridge, browserSession, entry, logger, registry });
  upsertExtensionStatus(loadedExtensions, status);

  if (status.id || status.name || status.version) {
    const updatedEntry = {
      ...entry,
      ...(status.id ? { id: status.id } : {}),
      ...(status.name ? { name: status.name } : {}),
      ...(status.version ? { version: status.version } : {}),
    };
    persistRegistryExtensions(registry, getRegistryEntries(registry).map((candidate) => candidate === entry ? updatedEntry : candidate));
  }
}

async function setExtensionEnabled({ bridge, browserSession, enabled, key, loadedExtensions, logger, registry }) {
  const entry = findRegistryEntryByKey(registry, key);
  const nextEntry = { ...entry, enabled };
  persistRegistryExtensions(registry, getRegistryEntries(registry).map((candidate) => candidate === entry ? nextEntry : candidate));

  if (enabled) {
    await unloadExtensionStatus({ browserSession, key, loadedExtensions, logger });
    const status = await loadExtensionEntry({ bridge, browserSession, entry: nextEntry, logger, registry });
    upsertExtensionStatus(loadedExtensions, status);
    return;
  }

  await unloadExtensionStatus({ browserSession, key, loadedExtensions, logger });
  upsertExtensionStatus(loadedExtensions, createExtensionStatus({
    entry: nextEntry,
    extensionPath: resolveExtensionPath(nextEntry, registry),
    manifest: readExtensionManifest(resolveExtensionPath(nextEntry, registry)),
    registry,
    state: 'disabled',
  }));
}

async function reloadManagedExtension({ bridge, browserSession, key, loadedExtensions, logger, registry }) {
  const entry = findRegistryEntryByKey(registry, key);
  const nextEntry = entry.enabled === false ? { ...entry, enabled: true } : entry;
  if (nextEntry !== entry) {
    persistRegistryExtensions(registry, getRegistryEntries(registry).map((candidate) => candidate === entry ? nextEntry : candidate));
  }
  await unloadExtensionStatus({ browserSession, key, loadedExtensions, logger });
  const status = await loadExtensionEntry({ bridge, browserSession, entry: nextEntry, logger, registry });
  upsertExtensionStatus(loadedExtensions, status);
}

async function removeManagedExtension({ browserSession, key, loadedExtensions, logger, registry }) {
  const entry = findRegistryEntryByKey(registry, key);
  const extensionPath = resolveExtensionPath(entry, registry);
  await unloadExtensionStatus({ browserSession, key, loadedExtensions, logger });
  persistRegistryExtensions(registry, getRegistryEntries(registry).filter((candidate) => candidate !== entry));
  removeExtensionStatus(loadedExtensions, key);
  closeExtensionSurfaceWindows(entry.id);
  if (['marketplace', 'webstore'].includes(entry.source) && extensionPath && isSameOrChildPath(extensionPath, path.join(registry.__baseDir, 'extensions'))) {
    fs.rmSync(extensionPath, { recursive: true, force: true });
    logger.info(`deleted managed marketplace extension files: ${extensionPath}`);
  }
}

async function unloadExtensionStatus({ browserSession, key, loadedExtensions, logger }) {
  const status = loadedExtensions.find((candidate) => candidate && candidate.key === key);
  if (!status || !status.id || !browserSession.extensions || typeof browserSession.extensions.removeExtension !== 'function') {
    return;
  }

  closeExtensionSurfaceWindows(status.id);
  try {
    const extension = typeof browserSession.extensions.getExtension === 'function'
      ? browserSession.extensions.getExtension(status.id)
      : null;
    const shouldRemove = typeof browserSession.extensions.getExtension === 'function'
      ? Boolean(extension)
      : status.state === 'loaded';
    if (shouldRemove) {
      await Promise.resolve(browserSession.extensions.removeExtension(status.id));
      logger.info(`unloaded extension ${status.name || status.id}`);
    }
  } catch (error) {
    logger.warn(`failed to unload extension ${status.name || status.id}`, error);
    throw error;
  }
}

function findRegistryEntryByKey(registry, key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Missing extension key');
  }
  const entry = getRegistryEntries(registry).find((candidate) => {
    return createExtensionKey(candidate, resolveExtensionPath(candidate, registry)) === key;
  });
  if (!entry) {
    throw new Error('Extension is no longer present in the registry');
  }
  return entry;
}

function getRegistryEntries(registry) {
  return Array.isArray(registry && registry.extensions) ? registry.extensions.filter(Boolean) : [];
}

function persistRegistryExtensions(registry, extensions) {
  const registryDocument = Object.fromEntries(Object.entries(registry)
    .filter(([key]) => !key.startsWith('__') && key !== 'extensions'));
  registryDocument.version = Number.isFinite(registry.version) ? registry.version : 1;
  registryDocument.extensions = extensions;
  const json = `${JSON.stringify(registryDocument, null, 2)}\n`;
  const tempPath = `${registry.__registryPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, json, 'utf8');
  try {
    fs.renameSync(tempPath, registry.__registryPath);
  } catch (_error) {
    fs.copyFileSync(tempPath, registry.__registryPath);
    fs.rmSync(tempPath, { force: true });
  }
  registry.extensions = extensions;
}

function upsertExtensionStatus(loadedExtensions, status) {
  const index = loadedExtensions.findIndex((candidate) => candidate && candidate.key === status.key);
  if (index === -1) {
    loadedExtensions.push(status);
    return;
  }
  loadedExtensions.splice(index, 1, status);
}

function assertTrustedRenderer(event) {
  const senderUrl = event && event.sender && typeof event.sender.getURL === 'function'
    ? event.sender.getURL()
    : '';
  try {
    const url = new URL(senderUrl);
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'https:' && (host === 'faceit.com' || host.endsWith('.faceit.com'))) {
      return;
    }
  } catch (_error) {
    // Fall through to a single generic error without exposing local state.
  }
  throw new Error('Untrusted extension manager renderer');
}

function readRecentLogLines(logPath) {
  try {
    if (!fs.existsSync(logPath)) {
      return [];
    }
    const stat = fs.statSync(logPath);
    const byteCount = Math.min(stat.size, 192 * 1024);
    const buffer = Buffer.alloc(byteCount);
    const handle = fs.openSync(logPath, 'r');
    try {
      fs.readSync(handle, buffer, 0, byteCount, Math.max(0, stat.size - byteCount));
    } finally {
      fs.closeSync(handle);
    }
    return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-RECENT_LOG_LINE_LIMIT);
  } catch (error) {
    return [`Unable to read loader.log: ${error && error.message ? error.message : String(error)}`];
  }
}

function formatDiagnosticsReport(state) {
  const extensions = Array.isArray(state && state.extensions) ? state.extensions : [];
  const logs = state && state.diagnostics && Array.isArray(state.diagnostics.recentLogs)
    ? state.diagnostics.recentLogs
    : [];
  const extensionLines = extensions.map((extension) => {
    return `- ${extension.name || extension.id || extension.path || 'Extension'}: ${extension.state || 'unknown'}${extension.version ? ` v${extension.version}` : ''}${extension.error ? ` (${extension.error})` : ''}`;
  });
  return [
    'AddonPort for FACEIT diagnostics',
    `Generated: ${state && state.diagnostics ? state.diagnostics.generatedAt : new Date().toISOString()}`,
    `Loader: ${state && state.loader && state.loader.version ? state.loader.version : 'unknown'}`,
    `Registry: ${state && state.registryPath ? state.registryPath : 'unknown'}`,
    `Data: ${state && state.userDataPath ? state.userDataPath : 'unknown'}`,
    '',
    'Extensions:',
    ...(extensionLines.length > 0 ? extensionLines : ['- none']),
    '',
    'Recent log:',
    ...(logs.length > 0 ? logs : ['(empty)']),
  ].join('\n');
}

function getBrowserActionState(bridge) {
  try {
    if (bridge && bridge.api && bridge.api.browserAction && typeof bridge.api.browserAction.getState === 'function') {
      return bridge.api.browserAction.getState();
    }
  } catch (_error) {
    // The toolbar can still show extension load state without action state.
  }
  return {
    activeTabId: -1,
    actions: [],
  };
}

async function activateBrowserAction({ bridge, details, event, logger }) {
  if (!bridge || !bridge.api || !bridge.api.browserAction || typeof bridge.api.browserAction.activate !== 'function') {
    throw new Error('Browser action bridge is unavailable');
  }

  const actionDetails = {
    eventType: 'click',
    extensionId: details && details.extensionId,
    tabId: Number.isFinite(details && details.tabId) ? details.tabId : -1,
    alignment: details && typeof details.alignment === 'string' ? details.alignment : '',
    anchorRect: normalizeAnchorRect(details && details.anchorRect),
  };

  if (!actionDetails.extensionId) {
    throw new Error('Missing extension action id');
  }

  try {
    await bridge.api.browserAction.activate({
      type: 'frame',
      sender: event.sender,
    }, actionDetails);
    return { ok: true };
  } catch (error) {
    logger.warn(`failed to activate extension action ${actionDetails.extensionId}`, error);
    throw error;
  }
}

async function openExtensionSurface({
  BrowserView,
  BrowserWindow,
  browserSession,
  bridge,
  event,
  key,
  loadedExtensions,
  logger,
  registry,
  screen,
  shell,
  surface,
}) {
  if (surface !== 'action' && surface !== 'options') {
    throw new Error('Unknown extension window type');
  }
  const entry = findRegistryEntryByKey(registry, key);
  const status = loadedExtensions.find((candidate) => candidate && candidate.key === key);
  const extensionId = status && status.id ? status.id : entry.id;
  const manifest = readExtensionManifest(resolveExtensionPath(entry, registry));
  if (!extensionId || !manifest || !status || status.state !== 'loaded') {
    throw new Error('The extension must be active before its window can be opened');
  }

  let pagePath;
  if (surface === 'options') {
    pagePath = manifest.options_page || (manifest.options_ui && manifest.options_ui.page);
    if (!pagePath) {
      throw new Error('This extension does not provide an options page');
    }
  } else {
    const actionState = getBrowserActionState(bridge);
    const action = toArray(actionState.actions).find((candidate) => candidate && candidate.id === extensionId);
    const tabState = action && action.tabs && actionState.activeTabId >= 0
      ? action.tabs[actionState.activeTabId]
      : null;
    pagePath = tabState && tabState.popup !== undefined
      ? tabState.popup
      : (action && action.popup)
        || (manifest.action && manifest.action.default_popup)
        || (manifest.browser_action && manifest.browser_action.default_popup)
        || (manifest.page_action && manifest.page_action.default_popup);
    if (!pagePath) {
      await activateBrowserAction({
        bridge,
        details: {
          extensionId,
          tabId: actionState.activeTabId,
          anchorRect: { x: 24, y: 24, width: 32, height: 32 },
        },
        event,
        logger,
      });
      return { mode: 'command' };
    }
  }

  const pageUrl = resolveExtensionPageUrl(extensionId, pagePath);
  const name = status.name || entry.name || 'Extension';
  const parent = BrowserWindow && typeof BrowserWindow.fromWebContents === 'function'
    ? BrowserWindow.fromWebContents(event.sender)
    : null;
  if (surface === 'action') {
    const popupState = await openEmbeddedExtensionAction({
      BrowserView,
      browserSession,
      extensionId,
      logger,
      name,
      pageUrl,
      parent,
      shell,
    });
    return {
      mode: 'embed',
      extensionId,
      name,
      width: popupState.width,
      height: popupState.height,
    };
  }
  logger.info(`opening extension ${surface} for ${status.name || entry.name || extensionId}: ${pageUrl}`);
  await openExtensionWindow({
    BrowserWindow,
    browserSession,
    extensionId,
    logger,
    name,
    pageUrl,
    parent,
    screen,
    shell,
    surface,
  });
  return { mode: 'window' };
}

function resolveExtensionPageUrl(extensionId, pagePath) {
  if (typeof pagePath !== 'string' || pagePath.length === 0) {
    throw new Error('The extension page path is invalid');
  }
  const pageUrl = new URL(pagePath, `chrome-extension://${extensionId}/`);
  if (pageUrl.protocol !== 'chrome-extension:' || pageUrl.hostname !== extensionId) {
    throw new Error('The extension page points outside of its own package');
  }
  return pageUrl.href;
}

async function openEmbeddedExtensionAction({
  BrowserView,
  browserSession,
  extensionId,
  logger,
  name,
  pageUrl,
  parent,
  shell,
}) {
  if (typeof BrowserView !== 'function' || !parent || parent.isDestroyed()
    || typeof parent.addBrowserView !== 'function' || typeof parent.removeBrowserView !== 'function') {
    throw new Error('Embedded extension popups are unavailable in this FACEIT build');
  }

  const parentId = parent.webContents && parent.webContents.id;
  if (!Number.isInteger(parentId)) {
    throw new Error('The FACEIT window cannot host an extension popup');
  }
  const existing = embeddedExtensionActions.get(parentId);
  if (existing) closeEmbeddedExtensionAction(existing, { notifyRenderer: false });

  const view = new BrowserView({
    webPreferences: {
      session: browserSession,
      preload: ACTION_POPUP_PRELOAD,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      enablePreferredSizeMode: true,
    },
  });
  const record = {
    desiredHeight: 560,
    desiredWidth: 420,
    extensionId,
    lastBounds: null,
    logger,
    name,
    parent,
    parentId,
    view,
  };
  embeddedExtensionActions.set(parentId, record);
  parent.addBrowserView(view);
  if (typeof view.setAutoResize === 'function') {
    view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });
  }
  if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#101010');

  record.handleParentResize = () => layoutEmbeddedExtensionAction(record);
  record.handleParentClosed = () => closeEmbeddedExtensionAction(record, { notifyRenderer: false });
  parent.on('resize', record.handleParentResize);
  parent.once('closed', record.handleParentClosed);
  view.webContents.once('destroyed', () => {
    if (embeddedExtensionActions.get(parentId) === record) {
      closeEmbeddedExtensionAction(record, { closeGuest: false });
    }
  });
  view.webContents.on('preferred-size-changed', (_event, preferredSize) => {
    const width = Number(preferredSize && preferredSize.width);
    const height = Number(preferredSize && preferredSize.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    record.desiredWidth = Math.ceil(width);
    record.desiredHeight = Math.ceil(height);
    layoutEmbeddedExtensionAction(record);
  });
  view.webContents.on('render-process-gone', (_event, details) => {
    logger.warn(`embedded extension action exited for ${name}: ${JSON.stringify(details || {})}`);
    closeEmbeddedExtensionAction(record, { closeGuest: false });
  });
  view.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
    if (isOwnExtensionUrl(targetUrl, extensionId)) return;
    navigationEvent.preventDefault();
    openExternalUrl(shell, targetUrl, logger);
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isOwnExtensionUrl(url, extensionId)) {
      view.webContents.loadURL(url).catch((error) => logger.warn(`failed to navigate extension action for ${name}`, error));
    } else {
      openExternalUrl(shell, url, logger);
    }
    return { action: 'deny' };
  });

  const bounds = layoutEmbeddedExtensionAction(record);
  try {
    await view.webContents.loadURL(pageUrl);
    logger.info(`loaded embedded extension action for ${name}: ${pageUrl}`);
  } catch (error) {
    closeEmbeddedExtensionAction(record);
    throw error;
  }
  return bounds;
}

function layoutEmbeddedExtensionAction(record) {
  if (!record || embeddedExtensionActions.get(record.parentId) !== record
    || !record.parent || record.parent.isDestroyed() || !record.view
    || !record.view.webContents || record.view.webContents.isDestroyed()) {
    return { width: 0, height: 0 };
  }
  const contentBounds = typeof record.parent.getContentBounds === 'function'
    ? record.parent.getContentBounds()
    : record.parent.getBounds();
  const edge = 10;
  const maxWidth = Math.max(1, Math.min(800, contentBounds.width - edge * 2));
  const maxHeight = Math.max(1, Math.min(640, contentBounds.height - edge * 2));
  const width = clampEmbeddedActionDimension(record.desiredWidth, Math.min(280, maxWidth), maxWidth);
  const height = clampEmbeddedActionDimension(record.desiredHeight, Math.min(120, maxHeight), maxHeight);
  const outerBounds = {
    x: Math.max(0, contentBounds.width - width - edge),
    y: Math.max(0, contentBounds.height - height - edge),
    width,
    height,
  };
  const viewBounds = {
    x: outerBounds.x + 1,
    y: outerBounds.y + 1,
    width: Math.max(1, outerBounds.width - 2),
    height: Math.max(1, outerBounds.height - 2),
  };
  if (!record.lastBounds || Object.keys(viewBounds).some((key) => viewBounds[key] !== record.lastBounds[key])) {
    record.view.setBounds(viewBounds);
    record.lastBounds = viewBounds;
  }
  sendEmbeddedExtensionActionState(record, { open: true, width, height });
  return { width, height };
}

function closeEmbeddedExtensionAction(record, options = {}) {
  const { closeGuest = true, notifyRenderer = true } = options;
  if (!record) return;
  if (embeddedExtensionActions.get(record.parentId) === record) {
    embeddedExtensionActions.delete(record.parentId);
  }
  if (record.parent && !record.parent.isDestroyed()) {
    if (record.handleParentResize) record.parent.removeListener('resize', record.handleParentResize);
    if (record.handleParentClosed) record.parent.removeListener('closed', record.handleParentClosed);
    try {
      record.parent.removeBrowserView(record.view);
    } catch (_error) {
      // The view may already be detached during window teardown.
    }
  }
  if (notifyRenderer) sendEmbeddedExtensionActionState(record, { open: false });
  if (closeGuest && record.view && record.view.webContents && !record.view.webContents.isDestroyed()) {
    if (typeof record.view.webContents.close === 'function') record.view.webContents.close();
    else if (typeof record.view.webContents.destroy === 'function') record.view.webContents.destroy();
  }
  record.logger.info(`closed embedded extension action for ${record.name}`);
}

function sendEmbeddedExtensionActionState(record, state) {
  const webContents = record && record.parent && record.parent.webContents;
  if (!webContents || webContents.isDestroyed()) return;
  webContents.send(IPC_ACTION_POPUP_STATE, {
    extensionId: record.extensionId,
    name: record.name,
    ...state,
  });
}

function findEmbeddedExtensionActionByGuest(webContents) {
  if (!webContents) return null;
  for (const record of embeddedExtensionActions.values()) {
    if (record.view && record.view.webContents === webContents) return record;
  }
  return null;
}

function clampEmbeddedActionDimension(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.round(Math.max(minimum, Math.min(maximum, number)));
}

async function openExtensionWindow({
  BrowserWindow,
  browserSession,
  extensionId,
  logger,
  name,
  pageUrl,
  parent,
  screen,
  shell,
  surface,
}) {
  if (typeof BrowserWindow !== 'function') {
    throw new Error('Extension windows are unavailable');
  }
  const windowKey = `${extensionId}:${surface}`;
  const existing = extensionSurfaceWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) {
      existing.restore();
    }
    keepExtensionWindowVisible({ browserWindow: existing, parent, screen });
    existing.show();
    existing.focus();
    return;
  }

  const desired = { width: 980, height: 720, minWidth: 640, minHeight: 480 };
  const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : null;
  const workArea = getExtensionWorkArea({ parentBounds, screen });
  const minWidth = parentBounds ? Math.min(desired.minWidth, Math.max(320, parentBounds.width - 48)) : desired.minWidth;
  const minHeight = parentBounds ? Math.min(desired.minHeight, Math.max(240, parentBounds.height - 48)) : desired.minHeight;
  const widthLimit = Math.max(280, Math.min(
    parentBounds ? parentBounds.width - 48 : desired.width,
    workArea ? workArea.width - 24 : desired.width,
  ));
  const heightLimit = Math.max(120, Math.min(
    parentBounds ? parentBounds.height - 48 : desired.height,
    workArea ? workArea.height - 24 : desired.height,
  ));
  const effectiveMinWidth = Math.min(minWidth, widthLimit);
  const effectiveMinHeight = Math.min(minHeight, heightLimit);
  const width = Math.max(effectiveMinWidth, Math.min(desired.width, widthLimit));
  const height = Math.max(effectiveMinHeight, Math.min(desired.height, heightLimit));
  const anchorBounds = parentBounds || workArea;
  const position = anchorBounds
    ? getExtensionWindowPosition({ height, parentBounds: anchorBounds, width, workArea })
    : null;
  const browserWindow = new BrowserWindow({
    width,
    height,
    minWidth: effectiveMinWidth,
    minHeight: effectiveMinHeight,
    ...(position || {}),
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    show: false,
    frame: true,
    modal: false,
    movable: true,
    closable: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#111113',
    title: `${name} settings`,
    webPreferences: {
      session: browserSession,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
    },
  });
  extensionSurfaceWindows.set(windowKey, browserWindow);
  browserWindow.setMenuBarVisibility(false);
  browserWindow.once('ready-to-show', () => {
    if (!browserWindow.isDestroyed()) {
      if (typeof browserWindow.setMovable === 'function') {
        browserWindow.setMovable(true);
      }
      keepExtensionWindowVisible({ browserWindow, parent, screen });
      browserWindow.show();
      browserWindow.focus();
      logger.info(`extension ${surface} window ready for ${name}: ${JSON.stringify(browserWindow.getBounds())}`);
    }
  });
  browserWindow.on('closed', () => {
    if (extensionSurfaceWindows.get(windowKey) === browserWindow) {
      extensionSurfaceWindows.delete(windowKey);
    }
  });
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.warn(`extension window renderer exited for ${name}: ${JSON.stringify(details || {})}`);
  });
  browserWindow.webContents.on('will-navigate', (navigationEvent, targetUrl) => {
    if (isOwnExtensionUrl(targetUrl, extensionId)) {
      return;
    }
    navigationEvent.preventDefault();
    openExternalUrl(shell, targetUrl, logger);
  });
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isOwnExtensionUrl(url, extensionId)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: browserWindow,
          autoHideMenuBar: true,
          webPreferences: {
            session: browserSession,
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInWorker: false,
            contextIsolation: true,
          },
        },
      };
    }
    openExternalUrl(shell, url, logger);
    return { action: 'deny' };
  });

  try {
    await browserWindow.loadURL(pageUrl);
    logger.info(`loaded extension ${surface} page for ${name}: ${pageUrl}`);
  } catch (error) {
    if (!browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
    throw error;
  }
}

function getExtensionWindowPosition({ height, parentBounds, width, workArea }) {
  const edge = 12;
  const x = parentBounds.x + (parentBounds.width - width) / 2;
  const y = parentBounds.y + (parentBounds.height - height) / 2;
  return clampWindowPosition({ edge, height, width, workArea, x, y });
}

function keepExtensionWindowVisible({ browserWindow, parent, screen }) {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const bounds = browserWindow.getBounds();
  const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : bounds;
  const workArea = getExtensionWorkArea({ parentBounds, screen });
  if (!workArea) return;
  const position = clampWindowPosition({
    edge: 12,
    height: bounds.height,
    width: bounds.width,
    workArea,
    x: bounds.x,
    y: bounds.y,
  });
  if (position.x !== bounds.x || position.y !== bounds.y) {
    browserWindow.setPosition(position.x, position.y, false);
  }
}

function getExtensionWorkArea({ parentBounds, screen }) {
  if (!screen) return null;
  try {
    const display = parentBounds && typeof screen.getDisplayMatching === 'function'
      ? screen.getDisplayMatching(parentBounds)
      : typeof screen.getPrimaryDisplay === 'function'
        ? screen.getPrimaryDisplay()
        : null;
    const workArea = display && display.workArea;
    if (!workArea || !Number.isFinite(workArea.x) || !Number.isFinite(workArea.y)
      || !Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)
      || workArea.width <= 0 || workArea.height <= 0) {
      return null;
    }
    return {
      x: Math.round(workArea.x),
      y: Math.round(workArea.y),
      width: Math.round(workArea.width),
      height: Math.round(workArea.height),
    };
  } catch (_error) {
    return null;
  }
}

function clampWindowPosition({ edge, height, width, workArea, x, y }) {
  if (!workArea) {
    return { x: Math.round(x), y: Math.round(y) };
  }
  const minX = workArea.x + edge;
  const minY = workArea.y + edge;
  const maxX = Math.max(minX, workArea.x + workArea.width - width - edge);
  const maxY = Math.max(minY, workArea.y + workArea.height - height - edge);
  return {
    x: Math.round(Math.max(minX, Math.min(maxX, x))),
    y: Math.round(Math.max(minY, Math.min(maxY, y))),
  };
}

function isOwnExtensionUrl(value, extensionId) {
  try {
    const url = new URL(value);
    return url.protocol === 'chrome-extension:' && url.hostname === extensionId;
  } catch (_error) {
    return false;
  }
}

function openExternalUrl(shell, value, logger) {
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && shell && typeof shell.openExternal === 'function') {
      Promise.resolve(shell.openExternal(url.href)).catch((error) => {
        logger.warn(`failed to open external extension link: ${url.href}`, error);
      });
    }
  } catch (_error) {
    logger.warn(`blocked invalid external extension URL: ${String(value)}`);
  }
}

function closeExtensionSurfaceWindows(extensionId) {
  if (!extensionId) {
    return;
  }
  for (const [key, browserWindow] of extensionSurfaceWindows) {
    if (!key.startsWith(`${extensionId}:`)) {
      continue;
    }
    extensionSurfaceWindows.delete(key);
    if (browserWindow && !browserWindow.isDestroyed()) {
      browserWindow.destroy();
    }
  }
}

function normalizeAnchorRect(anchorRect) {
  if (!anchorRect || typeof anchorRect !== 'object') {
    return {
      x: 0,
      y: 0,
      width: 32,
      height: 32,
    };
  }

  return {
    x: Number(anchorRect.x) || 0,
    y: Number(anchorRect.y) || 0,
    width: Number(anchorRect.width) || 32,
    height: Number(anchorRect.height) || 32,
  };
}

function getLiveExtensionState(browserSession, loadedExtensions) {
  const extensionMap = new Map();

  for (const extensionStatus of loadedExtensions) {
    const key = extensionStatus.key || extensionStatus.id || extensionStatus.path || extensionStatus.name || `${extensionMap.size}`;
    extensionMap.set(key, extensionStatus);
  }

  if (browserSession.extensions && typeof browserSession.extensions.getAllExtensions === 'function') {
    try {
      for (const extension of browserSession.extensions.getAllExtensions()) {
        const matchingStatus = loadedExtensions.find((status) => status && status.id === extension.id);
        const key = matchingStatus && matchingStatus.key
          ? matchingStatus.key
          : createExtensionKey(null, extension.path, extension.id);
        extensionMap.set(key, {
          ...(matchingStatus || extensionMap.get(key) || {}),
          key,
          id: extension.id,
          name: extension.name,
          path: matchingStatus && matchingStatus.path ? matchingStatus.path : extension.path,
          version: extension.manifest && extension.manifest.version
            ? extension.manifest.version
            : matchingStatus && matchingStatus.version,
          enabled: true,
          state: 'loaded',
        });
      }
    } catch (_error) {
      // Keep the already-recorded load results if Electron cannot enumerate live extensions.
    }
  }

  return Array.from(extensionMap.values());
}

function ensureRegistry(app, logger) {
  const registryPath = process.env.FACEIT_EXTENSION_REGISTRY || path.join(getDataRoot(app), 'installed.json');
  const registryDir = path.dirname(registryPath);
  fs.mkdirSync(registryDir, { recursive: true });

  if (!fs.existsSync(registryPath)) {
    const initial = {
      version: 1,
      extensions: [],
    };
    fs.writeFileSync(registryPath, `${JSON.stringify(initial, null, 2)}\n`);
    logger.info(`created empty extension registry: ${registryPath}`);
    return {
      ...initial,
      __registryPath: registryPath,
      __baseDir: registryDir,
    };
  }

  try {
    const parsed = JSON.parse(stripJsonBom(fs.readFileSync(registryPath, 'utf8')));
    return {
      ...parsed,
      __registryPath: registryPath,
      __baseDir: registryDir,
    };
  } catch (error) {
    logger.warn(`failed to parse extension registry: ${registryPath}`, error);
    return {
      version: 1,
      extensions: [],
      __registryPath: registryPath,
      __baseDir: registryDir,
    };
  }
}

function stripJsonBom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function resolveExtensionPath(entry, registry) {
  if (typeof entry.path !== 'string' || entry.path.length === 0) {
    return null;
  }
  if (path.isAbsolute(entry.path)) {
    return entry.path;
  }
  return path.resolve(registry.__baseDir, entry.path);
}

function readExtensionManifest(extensionPath) {
  if (typeof extensionPath !== 'string' || extensionPath.length === 0) {
    return null;
  }
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(stripJsonBom(fs.readFileSync(manifestPath, 'utf8')));
    if (!manifest || typeof manifest.name !== 'string' || typeof manifest.manifest_version !== 'number') {
      return null;
    }
    return manifest;
  } catch (_error) {
    return null;
  }
}

function getManifestLabel(manifest, fallback) {
  if (manifest && typeof manifest.name === 'string' && !/^__MSG_[^_]+__$/i.test(manifest.name)) {
    return manifest.name;
  }
  return typeof fallback === 'string' && fallback.length > 0 ? fallback : 'Extension';
}

function createExtensionKey(entry, extensionPath, extensionId) {
  const keySource = extensionPath
    || (entry && typeof entry.path === 'string' ? entry.path : '')
    || extensionId
    || (entry && typeof entry.id === 'string' ? entry.id : '')
    || (entry && typeof entry.name === 'string' ? entry.name : 'extension');
  const normalized = path.resolve(String(keySource)).replaceAll('\\', '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 20);
}

function resolveOriginalMainPath() {
  const originalMain = readOriginalMainFromMarker();
  const normalized = path.posix.normalize(String(originalMain).replaceAll('\\', '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    earlyLog(`unsafe original main in marker, falling back to ${DEFAULT_ORIGINAL_MAIN}`);
    return path.join(__dirname, '..', DEFAULT_ORIGINAL_MAIN);
  }
  return path.join(__dirname, '..', normalized);
}

function readOriginalMainFromMarker() {
  const marker = readAppliedMarker();
  if (marker && typeof marker.originalMain === 'string' && marker.originalMain.length > 0) {
    return marker.originalMain;
  }
  return DEFAULT_ORIGINAL_MAIN;
}

function readAppliedMarker() {
  try {
    return JSON.parse(fs.readFileSync(APPLIED_MARKER, 'utf8'));
  } catch (_error) {
    // The marker is expected but not required; keep the original client bootable.
    return null;
  }
}

function normalizeFilesystemPath(filePath) {
  return path.resolve(String(filePath)).toLowerCase();
}

function getDataRoot(app) {
  if (process.env.FACEIT_EXTENSION_LOADER_HOME) {
    return process.env.FACEIT_EXTENSION_LOADER_HOME;
  }
  return path.join(app.getPath('userData'), 'extension-loader');
}

function createLogger(app) {
  const logPath = path.join(getDataRoot(app), 'loader.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  function write(level, message, error) {
    const line = `[${new Date().toISOString()}] [${level}] ${message}${formatError(error)}\n`;
    try {
      fs.appendFileSync(logPath, line);
    } catch (_error) {
      earlyLog(line.trim());
    }
  }

  return {
    info(message) {
      write('info', message);
    },
    warn(message, error) {
      write('warn', message, error);
    },
  };
}

function formatRendererLogPayload(payload) {
  let text;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch (_error) {
    text = String(payload);
  }
  if (text.length > 1600) {
    return `${text.slice(0, 1600)}...`;
  }
  return text;
}

function formatError(error) {
  if (!error) {
    return '';
  }
  if (error && error.stack) {
    return `\n${error.stack}`;
  }
  return ` ${String(error)}`;
}

function earlyLog(message, error) {
  const suffix = error ? formatError(error) : '';
  console.warn(`[faceit-extension-loader] ${message}${suffix}`);
}
