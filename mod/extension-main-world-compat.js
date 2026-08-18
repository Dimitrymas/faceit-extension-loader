'use strict';

(function installFaceitMainWorldCompat() {
  const config = globalThis.__faceitExtensionLoaderMainWorldConfig;
  if (!config || typeof config.channel !== 'string') return;

  const channel = config.channel;
  const manifest = config.manifest && typeof config.manifest === 'object' ? config.manifest : {};
  let runtimeId = typeof config.extensionIdHint === 'string' ? config.extensionIdHint : '';
  try {
    delete globalThis.__faceitExtensionLoaderMainWorldConfig;
  } catch (_error) {
    globalThis.__faceitExtensionLoaderMainWorldConfig = undefined;
  }

  const SOURCE_MAIN = 'faceit-extension-loader:main-world';
  const SOURCE_BRIDGE = 'faceit-extension-loader:isolated-bridge';
  const pending = new Map();
  const queued = [];
  const storageListeners = new Set();
  let ready = false;
  let sequence = 0;
  let lastError;

  window.addEventListener('message', (event) => {
    const message = event && event.data;
    if (event.source !== window || !message || message.source !== SOURCE_BRIDGE || message.channel !== channel) return;
    if (message.type === 'ready') {
      ready = true;
      if (typeof message.runtimeId === 'string' && message.runtimeId) runtimeId = message.runtimeId;
      while (queued.length > 0) post(queued.shift());
      return;
    }
    if (message.type === 'storage-changed') {
      for (const listener of [...storageListeners]) {
        try {
          listener(message.changes || {}, message.areaName || 'local');
        } catch (error) {
          queueMicrotask(() => { throw error; });
        }
      }
      return;
    }
    if (message.type !== 'response' || typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.ok) request.resolve(message.value);
    else request.reject(createError(message.error));
  });

  const runtime = {
    get id() { return runtimeId; },
    get lastError() { return lastError; },
    getManifest() { return clone(manifest); },
    getURL(resourcePath = '') {
      const cleanPath = String(resourcePath).replace(/^\/+/, '');
      return runtimeId ? `chrome-extension://${runtimeId}/${cleanPath}` : cleanPath;
    },
    sendMessage(...args) { return invoke('runtime', 'sendMessage', args); },
  };
  const local = createStorageArea('local');
  const sync = createStorageArea('sync');
  const managed = createStorageArea('managed');
  const storage = {
    local,
    sync,
    managed,
    onChanged: {
      addListener(listener) { if (typeof listener === 'function') storageListeners.add(listener); },
      removeListener(listener) { storageListeners.delete(listener); },
      hasListener(listener) { return storageListeners.has(listener); },
      hasListeners() { return storageListeners.size > 0; },
    },
  };

  const compatChrome = copyNamespace(globalThis.chrome);
  compatChrome.runtime = runtime;
  compatChrome.storage = storage;
  replaceGlobal('chrome', compatChrome);

  const compatBrowser = copyNamespace(globalThis.browser);
  compatBrowser.runtime = runtime;
  compatBrowser.storage = storage;
  replaceGlobal('browser', compatBrowser);

  post({ type: 'hello' });
  let helloAttempts = 0;
  const helloTimer = setInterval(() => {
    if (ready || helloAttempts++ >= 40) {
      clearInterval(helloTimer);
      return;
    }
    post({ type: 'hello' });
  }, 50);
  console.info('[faceit-extension-loader:main-world-compat] installed', { channel, runtimeId });

  function createStorageArea(areaName) {
    const area = {};
    for (const method of ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel']) {
      area[method] = (...args) => invoke('storage', method, args, areaName);
    }
    if (areaName === 'sync') {
      Object.assign(area, {
        MAX_ITEMS: 512,
        MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
        MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
        QUOTA_BYTES: 102400,
        QUOTA_BYTES_PER_ITEM: 8192,
      });
    }
    return area;
  }

  function invoke(namespace, method, originalArgs, areaName) {
    const args = [...originalArgs];
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const promise = request(namespace, method, args, areaName);
    if (!callback) return promise;
    promise.then(
      (value) => callback(value),
      (error) => {
        lastError = { message: error.message || String(error) };
        try {
          callback();
        } finally {
          queueMicrotask(() => { lastError = undefined; });
        }
      },
    );
    return undefined;
  }

  function request(namespace, method, args, areaName) {
    const id = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${namespace}.${method} timed out waiting for the extension bridge`));
      }, 10000);
      pending.set(id, { resolve, reject, timeout });
      const message = { type: 'request', id, namespace, method, args, areaName };
      if (ready) post(message);
      else queued.push(message);
    });
  }

  function post(message) {
    window.postMessage({ source: SOURCE_MAIN, channel, ...message }, '*');
  }

  function replaceGlobal(name, value) {
    try {
      Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, value, writable: true });
    } catch (_error) {
      try {
        globalThis[name] = value;
      } catch (error) {
        console.warn(`[faceit-extension-loader:main-world-compat] could not replace ${name}`, error);
      }
    }
  }

  function copyNamespace(value) {
    const result = {};
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return result;
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        result[key] = value[key];
      } catch (_error) {
        // Chromium exposes a few lazy page APIs that may throw when read.
      }
    }
    return result;
  }

  function clone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_error) {
      return {};
    }
  }

  function createError(value) {
    const error = new Error(value && value.message ? value.message : 'Extension bridge request failed');
    if (value && value.name) error.name = value.name;
    return error;
  }
})();
