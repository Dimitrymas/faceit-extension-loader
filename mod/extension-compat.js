'use strict';

(function installFaceitExtensionCompat() {
  const LOG_PREFIX = '[faceit-extension-loader:extension-compat]';

  try {
    const nativeChrome = safeGet(globalThis, 'chrome');
    if (!nativeChrome || typeof nativeChrome !== 'object') {
      return;
    }

    const compatChrome = cloneChromeObject(nativeChrome);
    patchStorageAreas(compatChrome);
    patchManagementApi(compatChrome);
    let installedChrome = compatChrome;
    if (replaceGlobalApi('chrome', compatChrome)) {
      log('installed cloned chrome compatibility API');
    } else {
      patchStorageAreas(nativeChrome);
      patchManagementApi(nativeChrome);
      installProxyInvariantFallback(nativeChrome);
      installedChrome = nativeChrome;
      log('installed in-place chrome compatibility API');
    }

    installBrowserNamespace(installedChrome, nativeChrome);
    installDiagnostics(installedChrome);
    installEmbeddedPopupBridge();
  } catch (error) {
    log('failed to install compatibility API', serializeError(error));
  }

  function cloneChromeObject(source, seen = new WeakMap()) {
    if (!source || (typeof source !== 'object' && typeof source !== 'function')) {
      return source;
    }

    if (seen.has(source)) {
      return seen.get(source);
    }

    const target = {};
    seen.set(source, target);

    for (const key of Object.getOwnPropertyNames(source)) {
      const value = readPropertyValue(source, key);
      if (value === undefined && key !== 'lastError') {
        continue;
      }

      defineCompatProperty(target, key, cloneChromeValue(value, source, seen));
    }

    return target;
  }

  function cloneChromeValue(value, owner, seen) {
    if (typeof value === 'function') {
      return createCallbackCompatibleFunction(value, owner);
    }

    if (value && typeof value === 'object') {
      return cloneChromeObject(value, seen);
    }

    return value;
  }

  function readPropertyValue(source, key) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        return descriptor.value;
      }
      if (descriptor && typeof descriptor.get === 'function') {
        return descriptor.get.call(source);
      }
      return source[key];
    } catch (_error) {
      return undefined;
    }
  }

  function safeBind(fn, owner) {
    try {
      return fn.bind(owner);
    } catch (_error) {
      return fn;
    }
  }

  function createCallbackCompatibleFunction(fn, owner) {
    const bound = safeBind(fn, owner);

    return function callbackCompatibleChromeFunction(...args) {
      const lastArg = args[args.length - 1];
      const callback = typeof lastArg === 'function' ? lastArg : null;
      let callbackCalled = false;

      if (callback) {
        args[args.length - 1] = (...callbackArgs) => {
          callbackCalled = true;
          return callback(...callbackArgs);
        };
      }

      const result = bound(...args);
      if (callback && isPromiseLike(result)) {
        result.then(
          (value) => {
            if (!callbackCalled) {
              callbackCalled = true;
              callback(value);
            }
          },
          (error) => {
            setRuntimeLastError(error);
            if (!callbackCalled) {
              callbackCalled = true;
              callback();
            }
            queueMicrotask(clearRuntimeLastError);
          },
        );
      }

      return result;
    };
  }

  function isPromiseLike(value) {
    return value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
  }

  function patchStorageAreas(chromeApi) {
    const storage = safeGet(chromeApi, 'storage');
    if (!storage || typeof storage !== 'object') {
      return;
    }

    const local = safeGet(storage, 'local');
    if (!local || typeof local !== 'object') {
      return;
    }

    defineCompatProperty(storage, 'sync', createStorageAreaFacade(local));
    defineCompatProperty(storage, 'managed', createStorageAreaFacade(local));
    patchStorageOnChanged(storage);
  }

  function createStorageAreaFacade(local) {
    const facade = {};

    for (const key of Object.getOwnPropertyNames(local)) {
      const value = readPropertyValue(local, key);
      if (typeof value === 'function') {
        defineCompatProperty(facade, key, createCallbackCompatibleFunction(value, local));
      } else if (value !== undefined) {
        defineCompatProperty(facade, key, value);
      }
    }

    for (const methodName of ['get', 'set', 'remove', 'clear', 'getBytesInUse', 'setAccessLevel']) {
      const method = safeGet(local, methodName);
      if (typeof method === 'function' && typeof safeGet(facade, methodName) !== 'function') {
        defineCompatProperty(facade, methodName, createCallbackCompatibleFunction(method, local));
      }
    }

    const syncLimits = {
      MAX_ITEMS: 512,
      MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
      MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
      QUOTA_BYTES: 102400,
      QUOTA_BYTES_PER_ITEM: 8192,
    };
    for (const [key, value] of Object.entries(syncLimits)) {
      if (safeGet(facade, key) === undefined) {
        defineCompatProperty(facade, key, value);
      }
    }

    return facade;
  }

  function patchStorageOnChanged(storage) {
    const onChanged = safeGet(storage, 'onChanged');
    if (!onChanged || typeof onChanged !== 'object' || safeGet(onChanged, '__faceitExtensionLoaderStorageSyncFacade')) {
      return;
    }

    const nativeAddListener = safeGet(onChanged, 'addListener');
    const nativeRemoveListener = safeGet(onChanged, 'removeListener');
    if (typeof nativeAddListener !== 'function' || typeof nativeRemoveListener !== 'function') {
      return;
    }

    const listenerMap = new WeakMap();

    defineCompatProperty(onChanged, 'addListener', function addStorageOnChangedListener(listener) {
      if (typeof listener !== 'function') {
        return nativeAddListener.call(onChanged, listener);
      }

      const wrappedListener = function storageSyncAreaListener(changes, areaName, ...rest) {
        listener(changes, areaName, ...rest);
        if (areaName === 'local') {
          listener(changes, 'sync', ...rest);
        }
      };
      listenerMap.set(listener, wrappedListener);
      return nativeAddListener.call(onChanged, wrappedListener);
    });

    defineCompatProperty(onChanged, 'removeListener', function removeStorageOnChangedListener(listener) {
      const wrappedListener = listenerMap.get(listener);
      if (wrappedListener) {
        listenerMap.delete(listener);
        return nativeRemoveListener.call(onChanged, wrappedListener);
      }
      return nativeRemoveListener.call(onChanged, listener);
    });

    defineCompatProperty(onChanged, '__faceitExtensionLoaderStorageSyncFacade', true);
  }

  function patchManagementApi(chromeApi) {
    let management = safeGet(chromeApi, 'management');
    if (!management || typeof management !== 'object') {
      management = {};
      defineCompatProperty(chromeApi, 'management', management);
    }

    if (typeof safeGet(management, 'getSelf') !== 'function') {
      defineCompatProperty(management, 'getSelf', getSelf);
    }
  }

  function installBrowserNamespace(installedChrome, nativeChrome) {
    const nativeBrowser = safeGet(globalThis, 'browser');
    if (!nativeBrowser || nativeBrowser === nativeChrome) {
      if (nativeBrowser === nativeChrome) replaceGlobalApi('browser', installedChrome);
      return;
    }
    if (typeof nativeBrowser !== 'object') return;
    const compatBrowser = cloneChromeObject(nativeBrowser);
    patchStorageAreas(compatBrowser);
    patchManagementApi(compatBrowser);
    if (replaceGlobalApi('browser', compatBrowser)) {
      log('installed cloned browser compatibility API');
      return;
    }
    patchStorageAreas(nativeBrowser);
    patchManagementApi(nativeBrowser);
    log('installed in-place browser compatibility API');
  }

  function getSelf(callback) {
    const manifest = getManifest();
    const selfInfo = {
      id: getRuntimeId(),
      name: manifest.name || '',
      shortName: manifest.short_name || manifest.name || '',
      description: manifest.description || '',
      version: manifest.version || '',
      versionName: manifest.version_name || manifest.version || '',
      type: 'extension',
      enabled: true,
      installType: 'normal',
      mayDisable: false,
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions.slice() : [],
      hostPermissions: Array.isArray(manifest.host_permissions) ? manifest.host_permissions.slice() : [],
    };

    if (typeof callback === 'function') {
      queueMicrotask(() => callback(selfInfo));
      return undefined;
    }

    return Promise.resolve(selfInfo);
  }

  function getManifest() {
    const runtime = safeGet(globalThis.chrome, 'runtime');
    const getManifestFn = runtime && safeGet(runtime, 'getManifest');
    if (typeof getManifestFn !== 'function') {
      return {};
    }

    try {
      return getManifestFn.call(runtime) || {};
    } catch (_error) {
      return {};
    }
  }

  function getRuntimeId() {
    const runtime = safeGet(globalThis.chrome, 'runtime');
    return runtime && typeof runtime.id === 'string' ? runtime.id : '';
  }

  function installDiagnostics(chromeApi) {
    installErrorDiagnostics();
    log('chrome API status', {
      hasRuntime: Boolean(safeGet(chromeApi, 'runtime')),
      hasRuntimeSendMessage: typeof safeGet(safeGet(chromeApi, 'runtime'), 'sendMessage') === 'function',
      hasStorageLocal: Boolean(safeGet(safeGet(chromeApi, 'storage'), 'local')),
      hasStorageSync: Boolean(safeGet(safeGet(chromeApi, 'storage'), 'sync')),
      hasStorageManaged: Boolean(safeGet(safeGet(chromeApi, 'storage'), 'managed')),
      hasStorageOnChanged: Boolean(safeGet(safeGet(chromeApi, 'storage'), 'onChanged')),
      hasManagementGetSelf: typeof safeGet(safeGet(chromeApi, 'management'), 'getSelf') === 'function',
      href: safeGet(globalThis.location, 'href'),
    });
  }

  function installEmbeddedPopupBridge() {
    const hostBridge = safeGet(globalThis, '__faceitExtensionPopupHost');
    const hostClose = safeGet(hostBridge, 'close');
    if (typeof hostClose === 'function') {
      defineCompatProperty(globalThis, 'close', () => hostClose.call(hostBridge));
      log('installed embedded action popup close bridge');
      return;
    }

    const parentWindow = safeGet(globalThis, 'parent');
    if (!parentWindow || parentWindow === globalThis || typeof safeGet(parentWindow, 'postMessage') !== 'function') {
      return;
    }

    let lastWidth = 0;
    let lastHeight = 0;
    let measurementScheduled = false;
    const postToParent = (message) => {
      try {
        parentWindow.postMessage(message, '*');
      } catch (_error) {
        // A detached popup no longer needs to notify its host.
      }
    };
    const requestClose = () => postToParent({ type: 'faceit-extension-loader:close-action-popup' });
    const scheduleMeasurement = () => {
      if (measurementScheduled) return;
      measurementScheduled = true;
      const requestFrame = safeGet(globalThis, 'requestAnimationFrame');
      const schedule = typeof requestFrame === 'function'
        ? (callback) => requestFrame.call(globalThis, callback)
        : (callback) => setTimeout(callback, 0);
      schedule(() => {
        measurementScheduled = false;
        const root = safeGet(globalThis.document, 'documentElement');
        const body = safeGet(globalThis.document, 'body');
        const width = Math.ceil(Math.max(
          root && root.scrollWidth || 0,
          root && root.offsetWidth || 0,
          body && body.scrollWidth || 0,
          body && body.offsetWidth || 0,
        ));
        const height = Math.ceil(Math.max(
          root && root.scrollHeight || 0,
          root && root.offsetHeight || 0,
          body && body.scrollHeight || 0,
          body && body.offsetHeight || 0,
        ));
        if (width <= 0 || height <= 0 || (width === lastWidth && height === lastHeight)) return;
        lastWidth = width;
        lastHeight = height;
        postToParent({
          type: 'faceit-extension-loader:action-popup-size',
          width,
          height,
        });
      });
    };

    defineCompatProperty(globalThis, 'close', requestClose);
    const addEventListenerFn = safeGet(globalThis, 'addEventListener');
    if (typeof addEventListenerFn === 'function') {
      addEventListenerFn.call(globalThis, 'keydown', (event) => {
        if (event && event.key === 'Escape') requestClose();
      }, true);
      addEventListenerFn.call(globalThis, 'load', scheduleMeasurement);
    }

    const ResizeObserverClass = safeGet(globalThis, 'ResizeObserver');
    if (typeof ResizeObserverClass === 'function') {
      const resizeObserver = new ResizeObserverClass(scheduleMeasurement);
      const root = safeGet(globalThis.document, 'documentElement');
      if (root) resizeObserver.observe(root);
      const body = safeGet(globalThis.document, 'body');
      if (body) resizeObserver.observe(body);
    }
    const MutationObserverClass = safeGet(globalThis, 'MutationObserver');
    const documentElement = safeGet(globalThis.document, 'documentElement');
    if (typeof MutationObserverClass === 'function' && documentElement) {
      const mutationObserver = new MutationObserverClass(scheduleMeasurement);
      mutationObserver.observe(documentElement, { attributes: true, childList: true, subtree: true });
    }
    scheduleMeasurement();
    log('installed embedded action popup bridge');
  }

  function installErrorDiagnostics() {
    if (safeGet(globalThis, '__faceitExtensionLoaderCompatDiagnosticsInstalled')) {
      return;
    }

    defineCompatProperty(globalThis, '__faceitExtensionLoaderCompatDiagnosticsInstalled', true);

    const addEventListenerFn = safeGet(globalThis, 'addEventListener');
    if (typeof addEventListenerFn !== 'function') {
      return;
    }

    addEventListenerFn.call(globalThis, 'error', (event) => {
      log('window error', {
        message: event && event.message,
        filename: event && event.filename,
        lineno: event && event.lineno,
        colno: event && event.colno,
        error: serializeError(event && event.error),
      });
    });

    addEventListenerFn.call(globalThis, 'unhandledrejection', (event) => {
      log('unhandled rejection', serializeError(event && event.reason));
    });
  }

  function setRuntimeLastError(error) {
    const runtime = safeGet(globalThis.chrome, 'runtime');
    if (!runtime || typeof runtime !== 'object') {
      return;
    }

    defineCompatProperty(runtime, 'lastError', {
      message: error && error.message ? error.message : String(error),
    });
  }

  function clearRuntimeLastError() {
    const runtime = safeGet(globalThis.chrome, 'runtime');
    if (!runtime || typeof runtime !== 'object') {
      return;
    }

    defineCompatProperty(runtime, 'lastError', undefined);
  }

  function replaceGlobalApi(name, api) {
    try {
      Object.defineProperty(globalThis, name, {
        value: api,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    } catch (_error) {
      try {
        globalThis[name] = api;
      } catch (__error) {
        return false;
      }
    }

    return safeGet(globalThis, name) === api;
  }

  function installProxyInvariantFallback(nativeChrome) {
    const NativeProxy = safeGet(globalThis, 'Proxy');
    if (typeof NativeProxy !== 'function' || safeGet(NativeProxy, '__faceitExtensionLoaderCompat')) {
      return;
    }

    function CompatProxy(target, handler) {
      return new NativeProxy(target, wrapProxyHandler(handler));
    }

    defineCompatProperty(CompatProxy, 'revocable', function revocable(target, handler) {
      return NativeProxy.revocable(target, wrapProxyHandler(handler));
    });
    defineCompatProperty(CompatProxy, '__faceitExtensionLoaderCompat', true);

    try {
      Object.defineProperty(globalThis, 'Proxy', {
        value: CompatProxy,
        configurable: true,
        enumerable: false,
        writable: true,
      });
    } catch (_error) {
      return;
    }

    log('installed Proxy invariant fallback for native chrome API', {
      chromeKeys: Object.getOwnPropertyNames(nativeChrome),
    });
  }

  function wrapProxyHandler(handler) {
    if (!handler || typeof handler !== 'object' || typeof handler.get !== 'function') {
      return handler;
    }

    return {
      ...handler,
      get(target, property, receiver) {
        const descriptor = getOwnDescriptor(target, property);
        if (
          descriptor
          && Object.prototype.hasOwnProperty.call(descriptor, 'value')
          && descriptor.configurable === false
          && descriptor.writable === false
        ) {
          return descriptor.value;
        }

        return handler.get.call(this, target, property, receiver);
      },
    };
  }

  function getOwnDescriptor(target, property) {
    try {
      return Object.getOwnPropertyDescriptor(target, property);
    } catch (_error) {
      return null;
    }
  }

  function defineCompatProperty(target, key, value) {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
      return true;
    } catch (_error) {
      try {
        target[key] = value;
      } catch (__error) {
        return false;
      }
      return safeGet(target, key) === value;
    }
  }

  function safeGet(target, key) {
    try {
      return target && target[key];
    } catch (_error) {
      return undefined;
    }
  }

  function serializeError(error) {
    return {
      name: error && error.name,
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack,
    };
  }

  function log(message, details) {
    try {
      console.info(LOG_PREFIX, message, details || '');
    } catch (_error) {
      // Console logging must not affect the extension.
    }
  }
}());
