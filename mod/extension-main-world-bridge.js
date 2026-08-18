'use strict';

(function installFaceitMainWorldBridge() {
  const config = globalThis.__faceitExtensionLoaderMainWorldConfig;
  if (!config || typeof config.channel !== 'string') return;

  const channel = config.channel;
  const marker = `__faceitExtensionLoaderMainBridge_${channel}`;
  try {
    delete globalThis.__faceitExtensionLoaderMainWorldConfig;
  } catch (_error) {
    globalThis.__faceitExtensionLoaderMainWorldConfig = undefined;
  }
  if (globalThis[marker]) return;
  globalThis[marker] = true;

  const chromeApi = globalThis.chrome;
  const runtime = chromeApi && chromeApi.runtime;
  const storage = chromeApi && chromeApi.storage;
  const local = storage && storage.local;
  if (!runtime || !local) {
    console.warn('[faceit-extension-loader:main-world-bridge] extension API is unavailable');
    return;
  }

  const SOURCE_MAIN = 'faceit-extension-loader:main-world';
  const SOURCE_BRIDGE = 'faceit-extension-loader:isolated-bridge';

  window.addEventListener('message', async (event) => {
    const message = event && event.data;
    if (event.source !== window || !message || message.source !== SOURCE_MAIN || message.channel !== channel) return;
    if (message.type === 'hello') {
      postReady();
      return;
    }
    if (message.type !== 'request' || typeof message.id !== 'string') return;

    try {
      const value = await handleRequest(message.namespace, message.method, Array.isArray(message.args) ? message.args : []);
      post({ type: 'response', id: message.id, ok: true, value });
    } catch (error) {
      post({ type: 'response', id: message.id, ok: false, error: serializeError(error) });
    }
  });

  const onChanged = storage.onChanged;
  if (onChanged && typeof onChanged.addListener === 'function') {
    onChanged.addListener((changes, areaName) => {
      post({ type: 'storage-changed', changes, areaName });
      if (areaName === 'local') post({ type: 'storage-changed', changes, areaName: 'sync' });
    });
  }

  postReady();
  console.info('[faceit-extension-loader:main-world-bridge] ready', { channel, runtimeId: runtime.id || '' });

  function postReady() {
    post({ type: 'ready', runtimeId: runtime.id || '' });
  }

  function post(message) {
    window.postMessage({ source: SOURCE_BRIDGE, channel, ...message }, '*');
  }

  async function handleRequest(namespace, method, args) {
    if (namespace === 'runtime' && method === 'sendMessage') {
      return invokeApi(runtime, 'sendMessage', args);
    }
    if (namespace === 'storage') {
      if (!['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel'].includes(method)) {
        throw new Error(`Unsupported storage method: ${method}`);
      }
      if (method === 'getBytesInUse' && typeof local.getBytesInUse !== 'function') {
        const values = await invokeApi(local, 'get', args);
        return new TextEncoder().encode(JSON.stringify(values || {})).byteLength;
      }
      if (method === 'setAccessLevel' && typeof local.setAccessLevel !== 'function') return undefined;
      return invokeApi(local, method, args);
    }
    throw new Error(`Unsupported main-world API request: ${namespace}.${method}`);
  }

  function invokeApi(owner, method, args) {
    const fn = owner && owner[method];
    if (typeof fn !== 'function') throw new Error(`${method} is unavailable`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      const callback = (...values) => {
        const lastError = runtime.lastError;
        finish(lastError ? new Error(lastError.message || String(lastError)) : null, values.length <= 1 ? values[0] : values);
      };

      let result;
      try {
        result = fn.apply(owner, [...args, callback]);
      } catch (error) {
        finish(error);
        return;
      }
      if (result && typeof result.then === 'function') result.then((value) => finish(null, value), finish);
    });
  }

  function serializeError(error) {
    return {
      message: error && error.message ? error.message : String(error),
      name: error && error.name ? error.name : 'Error',
    };
  }
})();
