'use strict';

const { ipcRenderer } = safeRequireElectron();

const IPC_GET_STATE = 'faceit-extension-loader:get-state';
const IPC_MANAGE_EXTENSION = 'faceit-extension-loader:manage-extension';
const IPC_RENDERER_LOG = 'faceit-extension-loader:renderer-log';
const IPC_DEEP_LINK = 'faceit-extension-loader:deep-link';
const IPC_ACTION_POPUP_CONTROL = 'faceit-extension-loader:action-popup-control';
const IPC_ACTION_POPUP_STATE = 'faceit-extension-loader:action-popup-state';
const BUTTON_HOST_ID = 'faceit-extension-loader-button-host';
const PANEL_HOST_ID = 'faceit-extension-loader-panel-host';
const ACTION_POPUP_HOST_ID = 'faceit-extension-loader-action-popup-host';
const RIGHT_SIDEBAR_SELECTOR = '[class*="SideBarContainer"]';
const SIDEBAR_BACKGROUND = '#121212';

const runtimeState = {
  buttonHost: null,
  buttonRoot: null,
  panelHost: null,
  panelRoot: null,
  actionPopupHost: null,
  actionPopupRoot: null,
  actionPopupExtensionId: null,
  actionPopupWidth: 420,
  actionPopupHeight: 560,
  isOpen: false,
  isRefreshing: false,
  latestState: null,
  activeView: 'installed',
  webStoreInput: '',
  webStoreInstallBusy: false,
  pendingPageReload: false,
  busyKeys: new Set(),
  busyListings: new Set(),
  integratedLaunchers: new Map(),
  ensureScheduled: false,
  globalHandlersInstalled: false,
  lastPlacement: null,
  pendingInstallToken: null,
};

if (shouldInject()) {
  onReady(() => {
    installGlobalHandlers();
    ensureUi();
    refreshState({ quiet: true });
    observeAppShell();
    installDeepLinkListener();
    logRenderer('AddonPort ready', { href: location.href, userAgent: navigator.userAgent });
  });
}

function safeRequireElectron() {
  try {
    return require('electron');
  } catch (_error) {
    return {};
  }
}

function shouldInject() {
  const host = String(location.hostname || '').toLowerCase();
  return host === 'faceit.com' || host.endsWith('.faceit.com');
}

function onReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

function installGlobalHandlers() {
  if (runtimeState.globalHandlersInstalled) return;
  runtimeState.globalHandlersInstalled = true;
  document.addEventListener('keydown', handleDocumentKeydown, true);
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  window.addEventListener('resize', handleViewportResize, { passive: true });
  if (ipcRenderer && typeof ipcRenderer.on === 'function') {
    ipcRenderer.on(IPC_ACTION_POPUP_STATE, handleActionPopupState);
  }
}

function installDeepLinkListener() {
  if (!ipcRenderer || typeof ipcRenderer.on !== 'function') return;
  ipcRenderer.on(IPC_DEEP_LINK, (_event, details) => {
    logRenderer('deep link received', details);
    runtimeState.pendingInstallToken = null;
    refreshState();
  });
}

function handleViewportResize() {
  placeButton();
  updatePanelPosition();
  updateActionPopupPosition();
}

function handleDocumentKeydown(event) {
  if (event.key !== 'Escape') return;
  if (isActionPopupOpen()) {
    closeEmbeddedExtensionPopup();
    return;
  }
  if (runtimeState.isOpen) setPanelOpen(false);
}

function handleDocumentPointerDown(event) {
  if (!isActionPopupOpen()) return;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  if (path.includes(runtimeState.actionPopupHost)) return;
  const sameActionButton = path.some((node) => node && node.dataset
    && node.dataset.extensionId === runtimeState.actionPopupExtensionId);
  if (!sameActionButton) closeEmbeddedExtensionPopup();
}

function handleActionPopupState(_event, state) {
  if (!state || state.open !== true) {
    closeEmbeddedExtensionPopup({ notifyMain: false });
    return;
  }
  ensureActionPopup();
  runtimeState.actionPopupExtensionId = state.extensionId || null;
  runtimeState.actionPopupWidth = Number(state.width) || 420;
  runtimeState.actionPopupHeight = Number(state.height) || 560;
  showEmbeddedExtensionPopupHost();
}

function observeAppShell() {
  const observer = new MutationObserver((mutations) => {
    const ownUiRemoved = mutations.some((mutation) => [...mutation.removedNodes].some(containsOwnUi));
    const sidebarChanged = mutations.some((mutation) => mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE
      && (mutation.target.matches?.(RIGHT_SIDEBAR_SELECTOR) || mutation.target.closest?.(RIGHT_SIDEBAR_SELECTOR)
        || [...mutation.addedNodes, ...mutation.removedNodes].some(containsRightSidebar)));
    if (ownUiRemoved || sidebarChanged || shouldEnsureUi()) {
      scheduleEnsureUi();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function containsRightSidebar(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  return node.matches?.(RIGHT_SIDEBAR_SELECTOR) || Boolean(node.querySelector?.(RIGHT_SIDEBAR_SELECTOR));
}

function containsOwnUi(node) {
  if (isOwnNode(node)) return true;
  return node && node.nodeType === Node.ELEMENT_NODE && typeof node.querySelector === 'function'
    && Boolean(node.querySelector(`#${BUTTON_HOST_ID}, #${PANEL_HOST_ID}, #${ACTION_POPUP_HOST_ID}`));
}

function isOwnNode(node) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  if ([BUTTON_HOST_ID, PANEL_HOST_ID, ACTION_POPUP_HOST_ID].includes(node.id)) return true;
  return typeof node.closest === 'function'
    && Boolean(node.closest(`#${BUTTON_HOST_ID}, #${PANEL_HOST_ID}, #${ACTION_POPUP_HOST_ID}`));
}

function shouldEnsureUi() {
  if (!runtimeState.panelHost || !runtimeState.panelHost.isConnected) return true;
  if (!runtimeState.actionPopupHost || !runtimeState.actionPopupHost.isConnected) return true;
  return !runtimeState.buttonHost || runtimeState.buttonHost.parentElement !== document.body;
}

function scheduleEnsureUi() {
  if (runtimeState.ensureScheduled) return;
  runtimeState.ensureScheduled = true;
  window.setTimeout(() => {
    runtimeState.ensureScheduled = false;
    ensureUi();
  }, 240);
}

function ensureUi() {
  ensureFallbackButton();
  ensurePanel();
  ensureActionPopup();
  if (runtimeState.latestState) renderExtensionDock(runtimeState.latestState);
  placeButton();
}

function ensureFallbackButton() {
  let host = document.getElementById(BUTTON_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = BUTTON_HOST_ID;
  }
  if (!host.shadowRoot) {
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
:host{all:initial;color-scheme:dark;display:block;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0;pointer-events:auto}*,*::before,*::after{box-sizing:border-box;letter-spacing:0}.dock{align-items:center;background:var(--mods-sidebar-background,#121212);border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column;gap:12px;max-height:var(--mods-dock-height,320px);padding:4px 0;width:var(--mods-dock-width,64px)}.dock-actions{align-items:center;display:flex;flex:1 1 auto;flex-direction:column;gap:4px;min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-color:#52525b transparent;scrollbar-width:none;width:100%}.dock-actions::-webkit-scrollbar{display:none}.dock-actions slot{display:contents}.dock-actions slot::slotted([slot="extension-launcher"]){background:#202020!important;border:0!important;border-radius:6px!important;box-shadow:none!important;box-sizing:border-box!important;cursor:pointer!important;flex:0 0 44px!important;height:44px!important;margin:0!important;max-height:44px!important;max-width:44px!important;min-height:44px!important;min-width:44px!important;overflow:hidden!important;position:relative!important;transform:none!important;width:44px!important}.dock-button{align-items:center;appearance:none;background:#202020;border:0;border-radius:6px;color:#f4f4f5;cursor:pointer;display:flex;flex:0 0 44px;height:44px;justify-content:center;padding:0;position:relative;transition:background 120ms,color 120ms;width:44px}.dock-button:hover{background:#2b2b2b;color:#fff}.dock-button:focus-visible{outline:2px solid #ff4b00;outline-offset:1px}.dock-button svg{height:24px;width:24px}.mods-button{background:#2a1d18;color:#ff5a1f}.dock[data-has-actions="true"] .mods-button::before{background:#383838;content:"";height:1px;left:10px;pointer-events:none;position:absolute;top:-7px;width:24px}.mods-button:hover,.mods-button[aria-pressed="true"]{background:#3a241b;color:#ff713d}.dock-action .mod-icon{align-items:center;background:transparent;border:0;border-radius:0;color:var(--accent,#f4f4f5);display:flex;font-size:15px;font-weight:800;height:26px;justify-content:center;overflow:hidden;position:relative;width:26px}.dock-action .mod-icon img{height:100%;inset:0;object-fit:contain;position:absolute;width:100%}.badge{align-items:center;background:#ff4b00;border:2px solid var(--mods-sidebar-background,#121212);border-radius:8px;color:#fff;display:none;font:700 9px/1 system-ui;height:16px;justify-content:center;min-width:16px;padding:0 3px;position:absolute;right:-4px;top:-4px}.badge[data-visible="true"]{display:flex}`;
    const dock = document.createElement('div');
    dock.className = 'dock';
    dock.dataset.hasActions = 'false';
    dock.innerHTML = `<div class="dock-actions" data-role="dock-actions"><slot name="extension-launcher"></slot></div><button class="dock-button mods-button" type="button" title="AddonPort" aria-label="AddonPort" aria-pressed="false">${iconMarkup('boxes')}<span class="badge" aria-hidden="true"></span></button>`;
    dock.querySelector('.mods-button').addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      logRenderer('right-sidebar Mods dock button clicked', { wasOpen: runtimeState.isOpen });
      setPanelOpen(!runtimeState.isOpen);
    });
    root.append(style, dock);
  }
  runtimeState.buttonHost = host;
  runtimeState.buttonRoot = host.shadowRoot;
}

function placeButton() {
  const host = runtimeState.buttonHost;
  if (host && host.parentElement !== document.body) document.body.appendChild(host);
  const sidebar = findRightSidebar();
  const sidebarRect = sidebar && sidebar.getBoundingClientRect();
  if (!host) return;
  if (!sidebar || !sidebarRect || !isVisibleRightSidebar(sidebar)) {
    host.style.display = 'none';
    updatePlacementLog('right-sidebar-unavailable', document.body);
    return;
  }

  const width = Math.max(44, Math.round(sidebarRect.width));
  const left = Math.round(sidebarRect.left);
  const bottom = Math.max(0, Math.round(window.innerHeight - sidebarRect.bottom + 4));
  const maxHeight = Math.max(52, Math.min(360, Math.round(sidebarRect.height - 8)));
  Object.assign(host.style, {
    bottom: `${bottom}px`,
    display: 'block',
    height: 'auto',
    left: `${left}px`,
    maxHeight: `${maxHeight}px`,
    pointerEvents: 'auto',
    position: 'fixed',
    right: 'auto',
    top: 'auto',
    width: `${width}px`,
    zIndex: '2147483600',
  });
  host.style.setProperty('--mods-dock-width', `${width}px`);
  host.style.setProperty('--mods-dock-height', `${maxHeight}px`);
  host.style.setProperty('--mods-sidebar-background', SIDEBAR_BACKGROUND);
  updateIntegratedLauncherAnchors();
  updatePlacementLog('bottom-right-extension-dock', sidebar, { bottom, left });
}

function findRightSidebar() {
  const candidates = Array.from(document.querySelectorAll(RIGHT_SIDEBAR_SELECTOR));
  return candidates.find(isVisibleRightSidebar) || null;
}

function isVisibleRightSidebar(sidebar) {
  const style = window.getComputedStyle(sidebar);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  return sidebar.getClientRects().length > 0 && isVisibleSidebarRect(sidebar.getBoundingClientRect());
}

function isVisibleSidebarRect(rect) {
  return rect.width >= 44 && rect.width <= 120 && rect.height >= 240
    && rect.right >= window.innerWidth - 4 && rect.left < window.innerWidth;
}

function updatePlacementLog(placement, anchor, geometry = null) {
  const signature = `${placement}:${describeElement(anchor)}:${geometry ? `${geometry.left},${geometry.top}` : ''}`;
  if (runtimeState.lastPlacement === signature) return;
  runtimeState.lastPlacement = signature;
  logRenderer('nav placement', { placement, anchor: describeElement(anchor), geometry });
}

function ensurePanel() {
  let host = document.getElementById(PANEL_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = PANEL_HOST_ID;
    document.body.appendChild(host);
  }
  if (!host.shadowRoot) {
    const root = host.attachShadow({ mode: 'open' });
    root.append(createPanelStyle(), createPanelElement());
  }
  runtimeState.panelHost = host;
  runtimeState.panelRoot = host.shadowRoot;
  Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483601', pointerEvents: runtimeState.isOpen ? 'auto' : 'none' });
  host.toggleAttribute('data-open', runtimeState.isOpen);
  updatePanelPosition();
}

function updatePanelPosition() {
  const host = runtimeState.panelHost;
  if (!host) return;
  const viewportWidth = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 320);
  const viewportHeight = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 320);
  const sidebar = findRightSidebar();
  const sidebarRect = sidebar && sidebar.getBoundingClientRect();
  const rightEdge = sidebarRect && sidebarRect.width > 0 ? sidebarRect.left : viewportWidth;
  const gap = 8;
  const width = Math.min(380, Math.max(280, Math.min(viewportWidth - gap * 2, rightEdge - gap * 2)));
  const height = getDesktopPanelHeight(viewportHeight - gap * 2);
  const left = Math.max(gap, rightEdge - width - gap);
  const top = Math.max(gap, viewportHeight - height - gap);
  host.style.setProperty('--mods-panel-left', `${Math.round(left)}px`);
  host.style.setProperty('--mods-panel-top', `${Math.round(top)}px`);
  host.style.setProperty('--mods-panel-width', `${Math.round(width)}px`);
  host.style.setProperty('--mods-panel-height', `${Math.round(height)}px`);
}

function ensureActionPopup() {
  let host = document.getElementById(ACTION_POPUP_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = ACTION_POPUP_HOST_ID;
    document.body.appendChild(host);
  }
  if (!host.shadowRoot) {
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
:host{all:initial;background:#101010;border:1px solid rgba(255,255,255,.14);border-radius:8px;box-shadow:0 18px 48px rgba(0,0,0,.52);box-sizing:border-box;color-scheme:dark;display:block;overflow:hidden}.surface{background:#101010;height:100%;width:100%}`;
    const surface = document.createElement('div');
    surface.className = 'surface';
    surface.setAttribute('aria-hidden', 'true');
    root.append(style, surface);
  }
  runtimeState.actionPopupHost = host;
  runtimeState.actionPopupRoot = host.shadowRoot;
  Object.assign(host.style, {
    display: isActionPopupOpen() ? 'block' : 'none',
    pointerEvents: isActionPopupOpen() ? 'auto' : 'none',
    position: 'fixed',
    zIndex: '2147483602',
  });
  host.toggleAttribute('data-open', isActionPopupOpen());
  updateActionPopupPosition();
}

function updateActionPopupPosition() {
  const host = runtimeState.actionPopupHost;
  if (!host) return;
  const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
  const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
  const edge = 10;
  const maxWidth = Math.max(1, Math.min(800, viewportWidth - edge * 2));
  const maxHeight = Math.max(1, Math.min(640, viewportHeight - edge * 2));
  const minWidth = Math.min(280, maxWidth);
  const minHeight = Math.min(120, maxHeight);
  const width = Math.round(clampNumber(runtimeState.actionPopupWidth, minWidth, maxWidth));
  const height = Math.round(clampNumber(runtimeState.actionPopupHeight, minHeight, maxHeight));
  Object.assign(host.style, {
    bottom: `${edge}px`,
    height: `${height}px`,
    left: 'auto',
    right: `${edge}px`,
    top: 'auto',
    width: `${width}px`,
  });
}

function isActionPopupOpen() {
  return Boolean(runtimeState.actionPopupExtensionId);
}

function openEmbeddedExtensionPopup(extension, surface, source) {
  if (!extension || !surface || surface.mode !== 'embed') return false;
  if (surface.extensionId !== extension.id) {
    showToast('The extension popup was rejected.', 'error');
    logRenderer('rejected embedded extension popup', {
      extensionId: extension.id,
      resolvedExtensionId: surface.extensionId,
    });
    return false;
  }

  ensureActionPopup();
  runtimeState.actionPopupExtensionId = extension.id;
  runtimeState.actionPopupWidth = Number(surface.width) || 420;
  runtimeState.actionPopupHeight = Number(surface.height) || 560;
  showEmbeddedExtensionPopupHost();
  setPanelOpen(false);
  logRenderer('embedded extension popup opened', {
    extensionId: extension.id,
    name: extension.name,
    source,
  });
  return true;
}

function showEmbeddedExtensionPopupHost() {
  if (!runtimeState.actionPopupHost || !isActionPopupOpen()) return;
  runtimeState.actionPopupHost.style.display = 'block';
  runtimeState.actionPopupHost.style.pointerEvents = 'auto';
  runtimeState.actionPopupHost.setAttribute('data-open', '');
  runtimeState.actionPopupHost.dataset.extensionId = runtimeState.actionPopupExtensionId;
  updateActionPopupPosition();
}

function closeEmbeddedExtensionPopup(options = {}) {
  const { notifyMain = true } = options;
  const extensionId = runtimeState.actionPopupExtensionId;
  runtimeState.actionPopupExtensionId = null;
  if (runtimeState.actionPopupHost) {
    runtimeState.actionPopupHost.style.display = 'none';
    runtimeState.actionPopupHost.style.pointerEvents = 'none';
    runtimeState.actionPopupHost.removeAttribute('data-open');
    delete runtimeState.actionPopupHost.dataset.extensionId;
  }
  if (notifyMain && extensionId && ipcRenderer && typeof ipcRenderer.send === 'function') {
    ipcRenderer.send(IPC_ACTION_POPUP_CONTROL, { operation: 'close' });
  }
  if (extensionId) logRenderer('embedded extension popup closed', { extensionId });
}

function clampNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function getDesktopPanelHeight(availableHeight) {
  const extensionCount = Array.isArray(runtimeState.latestState && runtimeState.latestState.extensions)
    ? runtimeState.latestState.extensions.length
    : 0;
  let desiredHeight;
  if (runtimeState.activeView === 'browse') desiredHeight = 205;
  else if (runtimeState.activeView === 'settings') desiredHeight = 500;
  else if (runtimeState.activeView === 'install-request') {
    const permissions = runtimeState.latestState && runtimeState.latestState.pendingInstall
      && runtimeState.latestState.pendingInstall.listing
      && Array.isArray(runtimeState.latestState.pendingInstall.listing.permissions)
      ? runtimeState.latestState.pendingInstall.listing.permissions
      : [];
    desiredHeight = 305 + Math.min(4, permissions.length) * 28;
  }
  else desiredHeight = 140 + Math.min(6, Math.max(1, extensionCount)) * 58;
  if (runtimeState.pendingPageReload) desiredHeight += 38;
  return Math.min(520, Math.max(205, Math.min(availableHeight, desiredHeight)));
}

function createPanelElement() {
  const shell = document.createElement('div');
  shell.className = 'manager-shell';
  shell.innerHTML = `
    <button class="scrim" type="button" aria-label="Close AddonPort" data-role="scrim"></button>
    <aside class="panel" role="dialog" aria-modal="true" aria-label="AddonPort" aria-hidden="true">
      <header class="topbar">
        <div class="brand-mark" aria-hidden="true">${iconMarkup('boxes')}</div>
        <div class="brand-copy"><div class="brand-title">AddonPort</div><div class="brand-status" data-role="header-status">Connecting</div></div>
        <button class="icon-button" type="button" title="Settings" aria-label="Settings" data-role="settings">${iconMarkup('settings')}</button>
        <button class="icon-button" type="button" title="Close" aria-label="Close" data-role="close">${iconMarkup('x')}</button>
      </header>
      <nav class="tabs" aria-label="Mod manager views" data-role="tabs">
        <button type="button" data-view="installed">Extensions <span class="tab-count" data-role="installed-count">0</span></button>
        <button type="button" data-view="browse">Add</button>
      </nav>
      <div class="reload-banner" data-role="reload-banner" data-visible="false">
        <span>Reload FACEIT to apply page changes.</span><button type="button" data-role="reload-page">Reload</button>
        <button class="banner-dismiss" type="button" aria-label="Dismiss" data-role="dismiss-reload">${iconMarkup('x')}</button>
      </div>
      <main class="content" data-role="content"></main>
      <div class="confirmation" data-role="confirmation" data-visible="false">
        <button class="confirmation-scrim" type="button" aria-label="Cancel" data-role="cancel-confirm"></button>
        <div class="confirmation-dialog" role="alertdialog" aria-modal="true">
          <div class="confirmation-icon">${iconMarkup('trash')}</div><h2 data-role="confirm-title">Remove mod?</h2><p data-role="confirm-copy"></p>
          <div class="confirmation-actions"><button class="button secondary" type="button" data-role="cancel-confirm">Cancel</button><button class="button danger" type="button" data-role="confirm-action">Remove</button></div>
        </div>
      </div>
      <div class="toasts" aria-live="polite" data-role="toasts"></div>
    </aside>`;
  shell.querySelector('[data-role="scrim"]').addEventListener('click', () => setPanelOpen(false));
  shell.querySelector('[data-role="close"]').addEventListener('click', () => setPanelOpen(false));
  shell.querySelector('[data-role="settings"]').addEventListener('click', () => setActiveView('settings'));
  shell.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.view)));
  shell.querySelector('[data-role="reload-page"]').addEventListener('click', () => location.reload());
  shell.querySelector('[data-role="dismiss-reload"]').addEventListener('click', () => { runtimeState.pendingPageReload = false; renderReloadBanner(); });
  shell.querySelectorAll('[data-role="cancel-confirm"]').forEach((button) => button.addEventListener('click', hideConfirmation));
  return shell;
}

function createPanelStyle() {
  const style = document.createElement('style');
  style.textContent = `
:host{all:initial;color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}*,*::before,*::after{box-sizing:border-box;letter-spacing:0}button,input{font:inherit}.manager-shell{height:100%;pointer-events:none;position:relative;width:100%}.scrim{appearance:none;background:transparent;border:0;cursor:default;height:100%;inset:0;padding:0;pointer-events:none;position:absolute;width:100%}.panel{background:#171717;border:0;border-left:1px solid #303030;border-right:1px solid #303030;box-shadow:-18px 0 48px rgba(0,0,0,.42);color:#f5f5f5;display:flex;flex-direction:column;height:var(--mods-panel-height,100vh);left:var(--mods-panel-left,0);max-height:100vh;max-width:100vw;opacity:0;overflow:hidden;pointer-events:auto;position:absolute;top:var(--mods-panel-top,0);transform:translateX(18px);transform-origin:right center;transition:opacity 140ms ease,transform 140ms ease;visibility:hidden;width:var(--mods-panel-width,400px)}:host([data-open]) .manager-shell{pointer-events:auto}:host([data-open]) .scrim{pointer-events:auto}:host([data-open]) .panel{opacity:1;transform:none;visibility:visible}
.topbar{align-items:center;background:#1b1b1b;border-bottom:1px solid #303030;display:flex;flex:0 0 56px;gap:10px;padding:0 12px}.brand-mark{align-items:center;color:#ff5500;display:flex;flex:0 0 28px;height:28px;justify-content:center;width:28px}.brand-mark svg{height:20px;width:20px}.brand-copy{min-width:0;margin-right:auto}.brand-title{font-size:14px;font-weight:700;line-height:19px}.brand-status{color:#919191;font-size:11px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.icon-button{align-items:center;appearance:none;background:transparent;border:0;border-radius:4px;color:#a7a7a7;cursor:pointer;display:inline-flex;flex:0 0 32px;height:32px;justify-content:center;padding:0;width:32px}.icon-button:hover{background:#292929;color:#fff}.icon-button:disabled{cursor:default;opacity:.4}.icon-button svg{height:17px;width:17px}.icon-button:focus-visible,.button:focus-visible,.tabs button:focus-visible,.search input:focus-visible,.row-main:focus-visible,.quick-action:focus-visible{outline:2px solid #ff5500;outline-offset:-2px}
.tabs{background:#1b1b1b;border-bottom:1px solid #303030;display:flex;flex:0 0 42px;gap:20px;padding:0 14px}.tabs button{appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;color:#929292;cursor:pointer;font-size:12px;font-weight:650;padding:2px 1px 0}.tabs button:hover{color:#ddd}.tabs button[data-active="true"]{border-bottom-color:#ff5500;color:#fff}.tab-count{color:#727272;font-size:10px;margin-left:3px}.reload-banner{align-items:center;background:#211914;border-bottom:1px solid #493124;color:#e9d9ce;display:none;flex:0 0 42px;font-size:12px;gap:8px;padding:0 12px 0 14px}.reload-banner[data-visible="true"]{display:flex}.reload-banner span{flex:1;min-width:0}.reload-banner button{appearance:none;background:transparent;border:0;color:#ff8b6f;cursor:pointer;font-size:12px;font-weight:700;padding:6px}.reload-banner .banner-dismiss{color:#9b8278;display:flex;padding:5px}.reload-banner svg{height:15px;width:15px}.content{flex:0 1 auto;min-height:0;overflow:hidden;position:relative}.screen{height:auto;max-height:calc(var(--mods-panel-height,640px) - 99px);overflow-x:hidden;overflow-y:auto;scrollbar-color:#3a3a3a transparent;scrollbar-width:thin}.screen::-webkit-scrollbar{width:8px}.screen::-webkit-scrollbar-thumb{background:#3a3a3a;border:2px solid #171717;border-radius:4px}
.screen-header{padding:18px 16px 14px}.screen-header.compact{align-items:center;display:flex;gap:8px;padding-bottom:12px}.screen-title{font-size:17px;font-weight:700;line-height:23px;margin:0}.screen-subtitle{color:#8d8d8d;font-size:12px;line-height:18px;margin:3px 0 0}.back-button{margin-left:-6px}.search{display:block;margin:0 16px 14px;position:relative}.search>svg{color:#737373;height:16px;left:11px;pointer-events:none;position:absolute;top:10px;width:16px}.search input{appearance:none;background:#202020;border:1px solid #353535;border-radius:4px;color:#f4f4f4;font-size:12px;height:36px;outline:0;padding:0 34px 0 35px;width:100%}.search input::placeholder{color:#707070}.search input:focus{background:#222;border-color:#626262}.section-label{align-items:center;color:#818181;display:flex;font-size:10px;font-weight:700;gap:8px;line-height:16px;padding:0 16px 7px;text-transform:uppercase}.section-label::after{background:#303030;content:"";flex:1;height:1px}
.market-list,.installed-list{border-bottom:1px solid #303030;border-top:1px solid #303030}.market-row,.installed-row{align-items:center;border-bottom:1px solid #2d2d2d;display:flex;gap:10px;min-height:68px;padding:9px 12px 9px 16px}.market-row:last-child,.installed-row:last-child{border-bottom:0}.market-row:hover,.installed-row:hover{background:#1d1d1d}.mod-icon{align-items:center;background:var(--accent,#3b3b42);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#fff;display:flex;flex:0 0 40px;font-size:16px;font-weight:800;height:40px;justify-content:center;overflow:hidden;position:relative;width:40px}.mod-icon.large{flex-basis:58px;font-size:23px;height:58px;width:58px}.mod-icon img{height:100%;inset:0;object-fit:cover;position:absolute;width:100%}.row-main{appearance:none;background:transparent;border:0;color:inherit;cursor:pointer;flex:1;min-width:0;padding:2px 0;text-align:left}.row-name-line{align-items:center;display:flex;gap:7px;min-width:0}.row-name{font-size:13px;font-weight:680;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.verified{color:#43ca90;display:inline-flex;flex:0 0 auto}.verified svg{height:13px;width:13px}.row-tagline{color:#909090;font-size:11px;line-height:16px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row-meta{align-items:center;color:#777;display:flex;font-size:10px;gap:6px;line-height:15px;margin-top:2px}.meta-dot{background:#555;border-radius:50%;height:3px;width:3px}
.button{align-items:center;appearance:none;background:#ff5500;border:1px solid #ff5500;border-radius:4px;color:#fff;cursor:pointer;display:inline-flex;font-size:12px;font-weight:700;gap:7px;height:32px;justify-content:center;min-width:72px;padding:0 12px;white-space:nowrap}.button:hover{background:#ff6a21;border-color:#ff6a21}.button:disabled{cursor:default;opacity:.48}.button.secondary{background:#252525;border-color:#3a3a3a;color:#e5e5e5}.button.secondary:hover{background:#2d2d2d;border-color:#4b4b4b}.button.ghost{background:transparent;border-color:#3a3a3a;color:#c7c7c7}.button.ghost:hover{background:#222}.button.danger{background:#d74747;border-color:#d74747}.button.danger:hover{background:#e15454}.button svg{height:14px;width:14px}.button .spin,.icon-button .spin{animation:spin 700ms linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.installed-chip{align-items:center;color:#43ca90;display:inline-flex;font-size:11px;font-weight:700;gap:5px;padding:0 4px}.installed-chip svg{height:14px;width:14px}.browse-footer{color:#707070;font-size:10px;line-height:16px;padding:16px 18px 20px;text-align:center}
.empty{align-items:center;display:flex;flex-direction:column;padding:54px 30px;text-align:center}.empty-icon{align-items:center;background:#202020;border:1px solid #353535;border-radius:6px;color:#858585;display:flex;height:44px;justify-content:center;width:44px}.empty-icon svg{height:21px;width:21px}.empty h2{font-size:15px;line-height:21px;margin:14px 0 4px}.empty p{color:#858585;font-size:12px;line-height:18px;margin:0 0 18px;max-width:280px}.quick-section{border-bottom:1px solid #303030;padding:0 16px 14px}.quick-section .section-label{padding-left:0;padding-right:0}.quick-grid{display:flex;flex-wrap:nowrap;gap:8px;overflow-x:auto;padding:1px 1px 5px;scrollbar-color:#3b3b3b transparent;scrollbar-width:thin}.quick-action{align-items:center;appearance:none;background:#212121;border:1px solid #343434;border-radius:4px;color:#fff;cursor:pointer;display:flex;flex:0 0 42px;height:42px;justify-content:center;padding:0;position:relative;width:42px}.quick-action:hover{background:#2a2a2a;border-color:#555}.quick-action .mod-icon{border:0;border-radius:3px;flex-basis:30px;height:30px;width:30px}.manager-footer{align-items:center;border-top:1px solid #303030;display:flex;justify-content:space-between;padding:11px 16px}.manager-footer-copy{color:#888;font-size:11px}.installed-row{min-height:66px}.installed-controls{align-items:center;display:flex;flex:0 0 auto;gap:1px}.status-line{align-items:center;display:flex;gap:6px}.status-dot{background:#686868;border-radius:50%;height:6px;width:6px}.status-dot.loaded{background:#43ca90}.status-dot.failed,.status-dot.invalid{background:#e15454}.status-error{color:#e26d6d;font-size:10px;line-height:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.switch{cursor:pointer;display:inline-flex;height:30px;padding:6px 3px;width:38px}.switch input{height:1px;opacity:0;position:absolute;width:1px}.switch-track{background:#3b3b3b;border-radius:9px;height:18px;position:relative;transition:background 120ms;width:32px}.switch-track::after{background:#c8c8c8;border-radius:50%;content:"";height:14px;left:2px;position:absolute;top:2px;transition:transform 120ms,background 120ms;width:14px}.switch input:checked+.switch-track{background:#258654}.switch input:checked+.switch-track::after{background:#fff;transform:translateX(14px)}.switch input:focus-visible+.switch-track{outline:2px solid #ff5500;outline-offset:2px}.switch input:disabled+.switch-track{opacity:.45}.update-button{color:#ff8b6f;min-width:auto;padding:0 9px}
	.detail-hero{border-bottom:1px solid #29292d;padding:8px 20px 22px}.detail-heading{align-items:center;display:flex;gap:14px}.detail-heading-copy{flex:1;min-width:0}.detail-name{font-size:20px;font-weight:760;line-height:26px;margin:0;overflow-wrap:anywhere}.detail-author{color:#8b8b94;font-size:12px;line-height:18px;margin-top:2px}.compatibility{align-items:center;color:#43ca90;display:flex;font-size:11px;font-weight:700;gap:5px;margin-top:7px}.compatibility.experimental{color:#d5a74d}.compatibility svg{height:14px;width:14px}.detail-tagline{color:#d4d4d8;font-size:14px;line-height:21px;margin:18px 0 0}.detail-description{color:#93939c;font-size:13px;line-height:20px;margin:8px 0 0}.detail-actions{display:flex;gap:8px;margin-top:18px}.detail-actions .button:first-child{flex:1}.install-request-note{align-items:flex-start;background:#211914;border:1px solid #493124;border-radius:4px;color:#d9c1b2;display:flex;font-size:11px;gap:9px;line-height:17px;margin-top:18px;padding:10px 11px}.install-request-note svg{color:#ff8b6f;flex:0 0 auto;height:16px;margin-top:1px;width:16px}.detail-stats{border-bottom:1px solid #29292d;display:grid;grid-template-columns:repeat(3,1fr);padding:15px 20px}.stat{border-right:1px solid #29292d;min-width:0;padding:0 12px}.stat:first-child{padding-left:0}.stat:last-child{border-right:0;padding-right:0}.stat-label{color:#74747d;font-size:10px;line-height:15px;text-transform:uppercase}.stat-value{font-size:13px;font-weight:680;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.detail-section{border-bottom:1px solid #29292d;padding:20px}.detail-section h2{font-size:13px;line-height:18px;margin:0 0 12px}.feature-list,.permission-list{display:grid;gap:10px;list-style:none;margin:0;padding:0}.feature-list li,.permission-list li{align-items:flex-start;color:#a7a7af;display:flex;font-size:12px;gap:9px;line-height:18px}.feature-list svg,.permission-list svg{flex:0 0 auto;height:16px;margin-top:1px;width:16px}.feature-list svg{color:#43ca90}.permission-list svg{color:#73737c}.detail-note{color:#72727b;font-size:11px;line-height:17px;margin:12px 0 0}
.install-body{display:flex;flex-direction:column;padding:6px 16px 16px}.install-summary{align-items:center;display:flex;gap:12px;padding:4px 0 14px}.install-summary-copy{flex:1;min-width:0}.install-name{font-size:16px;font-weight:720;line-height:22px;margin:0;overflow-wrap:anywhere}.install-source{align-items:center;color:#43ca90;display:flex;font-size:11px;font-weight:650;gap:5px;line-height:17px;margin-top:3px}.install-source.unreviewed{color:#d5a74d}.install-source svg{flex:0 0 auto;height:13px;width:13px}.install-permissions{border-top:1px solid #2d2d2d;padding:13px 0 4px}.install-permissions h2{color:#818181;font-size:10px;font-weight:700;line-height:16px;margin:0 0 8px;text-transform:uppercase}.install-permissions ul{display:grid;gap:7px;list-style:none;margin:0;padding:0}.install-permissions li{align-items:flex-start;color:#aaa;font-size:11px;line-height:17px;padding-left:17px;position:relative}.install-permissions li::before{background:#626262;border-radius:50%;content:"";height:4px;left:3px;position:absolute;top:7px;width:4px}.install-actions{border-top:1px solid #2d2d2d;display:grid;gap:8px;grid-template-columns:1fr 1fr;margin-top:13px;padding-top:13px}.install-actions.single{grid-template-columns:1fr}.install-actions .button{width:100%}
.settings-group{border-bottom:1px solid #29292d}.settings-group-title{color:#7f7f88;font-size:11px;font-weight:720;padding:18px 20px 8px;text-transform:uppercase}.settings-row{align-items:center;border-top:1px solid #29292d;display:flex;gap:12px;min-height:62px;padding:10px 16px 10px 20px}.settings-row-icon{align-items:center;color:#8f8f98;display:flex;flex:0 0 28px;justify-content:center}.settings-row-icon svg{height:18px;width:18px}.settings-row-copy{flex:1;min-width:0}.settings-row-title{font-size:13px;font-weight:650;line-height:18px}.settings-row-subtitle{color:#7f7f88;font-size:11px;line-height:16px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.log{background:#0b0b0c;border:1px solid #29292d;border-radius:6px;color:#909099;font:10px/16px ui-monospace,SFMono-Regular,Consolas,monospace;margin:12px 20px 20px;max-height:200px;overflow:auto;padding:12px;white-space:pre-wrap;word-break:break-word}
.confirmation{display:none;inset:0;position:absolute;z-index:5}.confirmation[data-visible="true"]{display:grid;place-items:center}.confirmation-scrim{appearance:none;background:rgba(0,0,0,.72);border:0;inset:0;padding:0;position:absolute}.confirmation-dialog{background:#19191c;border:1px solid #38383d;border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.5);padding:20px;position:relative;width:min(340px,calc(100% - 36px))}.confirmation-icon{align-items:center;background:#352020;border-radius:7px;color:#ef6969;display:flex;height:36px;justify-content:center;width:36px}.confirmation-icon svg{height:18px;width:18px}.confirmation-dialog h2{font-size:16px;line-height:22px;margin:14px 0 5px}.confirmation-dialog p{color:#94949d;font-size:12px;line-height:18px;margin:0}.confirmation-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}.confirmation-actions .button{min-width:84px}.toasts{bottom:16px;display:grid;gap:8px;left:16px;pointer-events:none;position:absolute;right:16px;z-index:8}.toast{background:#242428;border:1px solid #3b3b40;border-radius:7px;box-shadow:0 10px 30px rgba(0,0,0,.36);color:#eeeef0;font-size:12px;line-height:18px;padding:11px 13px}.toast.error{border-color:#6b3434;color:#ffc4c4}
.panel{background:#181818;border:1px solid #3a3a3a;border-radius:6px;box-shadow:0 18px 48px rgba(0,0,0,.55);max-height:calc(100vh - 16px);transform:translate(8px,8px) scale(.985);transform-origin:right bottom}.topbar{background:#1c1c1c;flex-basis:50px;padding:0 10px}.brand-mark{flex-basis:24px;height:24px;width:24px}.brand-mark svg{height:18px;width:18px}.brand-title{font-size:13px}.brand-status{font-size:10px}.icon-button{height:30px;width:30px;flex-basis:30px}.tabs{background:#1c1c1c;flex-basis:38px;gap:18px;padding:0 12px}.tabs button{font-size:11px}.content{flex:1 1 auto}.screen{height:100%;max-height:calc(var(--mods-panel-height,580px) - 89px)}.screen-header{padding:13px 12px 10px}.screen-header.compact{padding:10px 12px}.screen-title{font-size:14px;line-height:20px}.installed-list{border-color:#303030}.installed-row{gap:9px;min-height:58px;padding:7px 8px 7px 12px}.installed-row:hover{background:#202020}.mod-icon{border-radius:5px;flex-basis:36px;font-size:14px;height:36px;width:36px}.row-name{font-size:12px;line-height:17px}.row-meta{font-size:9px;line-height:14px}.installed-controls{gap:0}.installed-controls .icon-button{height:28px;opacity:0;transition:opacity 100ms;width:28px;flex-basis:28px}.installed-row:hover .installed-controls .icon-button,.installed-controls .icon-button:focus-visible{opacity:1}.switch{height:28px;padding:5px 3px;width:36px}.webstore-install{display:flex;gap:8px;padding:4px 12px 14px}.webstore-install input{appearance:none;background:#202020;border:1px solid #3a3a3a;border-radius:4px;color:#f4f4f4;flex:1;font-size:11px;height:34px;min-width:0;outline:0;padding:0 10px}.webstore-install input::placeholder{color:#777}.webstore-install input:focus{border-color:#696969}.webstore-install .button{height:34px;min-width:82px}.empty{padding:38px 24px}.reload-banner{flex-basis:38px;font-size:11px}.toasts{bottom:10px;left:10px;right:10px}.confirmation-dialog{border-radius:6px}.install-body{padding-left:12px;padding-right:12px}
@media(max-width:639px){.panel{border:1px solid #3a3a3a}.screen-header{padding-left:12px;padding-right:12px}.installed-row{padding-left:12px}.install-body{padding-left:12px;padding-right:12px}.installed-controls .icon-button[data-compact-hide="true"]{display:none}}@media(prefers-reduced-motion:reduce){.panel,.switch-track,.switch-track::after{transition:none}}`;
  return style;
}

function setPanelOpen(isOpen) {
  runtimeState.isOpen = Boolean(isOpen);
  if (runtimeState.isOpen && isActionPopupOpen()) closeEmbeddedExtensionPopup();
  updatePanelPosition();
  logRenderer('panel visibility changed', {
    isOpen: runtimeState.isOpen,
    placement: runtimeState.lastPlacement,
    buttonConnected: Boolean(runtimeState.buttonHost && runtimeState.buttonHost.isConnected),
  });
  const button = runtimeState.buttonRoot && runtimeState.buttonRoot.querySelector('.mods-button');
  if (button) button.setAttribute('aria-pressed', runtimeState.isOpen ? 'true' : 'false');
  if (runtimeState.panelHost) {
    runtimeState.panelHost.style.pointerEvents = runtimeState.isOpen ? 'auto' : 'none';
    runtimeState.panelHost.toggleAttribute('data-open', runtimeState.isOpen);
  }
  const panel = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('.panel');
  if (panel) panel.setAttribute('aria-hidden', runtimeState.isOpen ? 'false' : 'true');
  if (runtimeState.isOpen) {
    refreshState();
    window.setTimeout(() => {
      const close = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="close"]');
      if (close) close.focus({ preventScroll: true });
    }, 200);
  } else {
    hideConfirmation();
  }
}

function setActiveView(view) {
  runtimeState.activeView = view;
  renderPanelState(runtimeState.latestState);
}

async function refreshState(options = {}) {
  if (runtimeState.isRefreshing) return;
  runtimeState.isRefreshing = true;
  try {
    if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') throw new Error('AddonPort bridge is unavailable');
    runtimeState.latestState = await ipcRenderer.invoke(IPC_GET_STATE);
    renderPanelState(runtimeState.latestState);
    await revealPendingDeepLink(runtimeState.latestState);
    logRenderer('state refreshed', summarizeState(runtimeState.latestState));
  } catch (error) {
    renderFatalError(error);
    if (!options.quiet) showToast(error.message || String(error), 'error');
    logRenderer('state refresh failed', serializeError(error));
  } finally {
    runtimeState.isRefreshing = false;
  }
}

async function revealPendingDeepLink(state) {
  const installRequest = state && state.pendingInstall;
  if (installRequest && installRequest.token && installRequest.token !== runtimeState.pendingInstallToken) {
    runtimeState.pendingInstallToken = installRequest.token;
    runtimeState.activeView = 'install-request';
    setPanelOpen(true);
    renderPanelState(state);
    return;
  }
  const request = state && state.pendingNavigation;
  if (!request || !request.token || request.token === runtimeState.pendingInstallToken) return;
  runtimeState.pendingInstallToken = request.token;
  runtimeState.activeView = 'installed';
  setPanelOpen(true);
  renderPanelState(state);
  if (request.action !== 'launch') {
    await runManagerOperation({ operation: 'ack-deeplink', token: request.token }, { requiresReload: false });
    return;
  }
  const extensions = Array.isArray(runtimeState.latestState && runtimeState.latestState.extensions)
    ? runtimeState.latestState.extensions
    : [];
  const extension = extensions.find((candidate) => candidate && (
    candidate.marketplaceId === request.target || candidate.id === request.target
  ));
  if (!extension) {
    showToast('That extension is not installed.', 'error');
    await runManagerOperation({ operation: 'fail-deeplink', reason: 'not_installed', token: request.token }, { requiresReload: false });
    return;
  }
  if (extension.state !== 'loaded' || !extension.hasAction) {
    showToast('That extension does not have an available action.', 'error');
    await runManagerOperation({ operation: 'fail-deeplink', reason: 'action_unavailable', token: request.token }, { requiresReload: false });
    return;
  }
  const opened = await openExtensionAction(extension, 'deeplink');
  await runManagerOperation({
    operation: opened ? 'ack-deeplink' : 'fail-deeplink',
    ...(opened ? {} : { reason: 'launch_failed' }),
    token: request.token,
  }, { requiresReload: false });
}

function renderPanelState(state) {
  if (!runtimeState.panelRoot || !state) return;
  renderExtensionDock(state);
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  if (runtimeState.actionPopupExtensionId && !extensions.some((extension) => extension
    && extension.id === runtimeState.actionPopupExtensionId && extension.state === 'loaded')) {
    closeEmbeddedExtensionPopup();
  }
  const active = extensions.filter((extension) => extension && extension.state === 'loaded').length;
  const loaderVersion = state.loader && state.loader.version ? `Loader ${state.loader.version}` : 'Loader version unknown';
  setText('[data-role="header-status"]', extensions.length
    ? `${loaderVersion} · ${active}/${extensions.length} active`
    : `${loaderVersion} · No extensions`);
  setText('[data-role="installed-count"]', extensions.length);
  runtimeState.panelRoot.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('data-active', button.dataset.view === runtimeState.activeView ? 'true' : 'false'));
  const tabs = runtimeState.panelRoot.querySelector('[data-role="tabs"]');
  if (tabs) tabs.style.display = ['settings', 'install-request'].includes(runtimeState.activeView) ? 'none' : '';
  const settingsButton = runtimeState.panelRoot.querySelector('[data-role="settings"]');
  if (settingsButton) settingsButton.style.display = runtimeState.activeView === 'settings' ? 'none' : '';
  const content = runtimeState.panelRoot.querySelector('[data-role="content"]');
  replaceChildren(content);
  if (runtimeState.activeView === 'installed') content.appendChild(renderInstalledScreen(state));
  else if (runtimeState.activeView === 'settings') content.appendChild(renderSettingsScreen(state));
  else if (runtimeState.activeView === 'install-request') content.appendChild(renderInstallRequestScreen(state));
  else content.appendChild(renderBrowseScreen(state));
  renderReloadBanner();
  updateButtonBadge(state);
  updatePanelPosition();
}

function renderExtensionDock(state) {
  const root = runtimeState.buttonRoot;
  if (!root) return;
  const integratedSelectors = syncIntegratedLaunchers(state);
  const container = root.querySelector('[data-role="dock-actions"]');
  const dock = root.querySelector('.dock');
  if (!container || !dock) return;
  container.querySelectorAll(':scope > .dock-action').forEach((button) => button.remove());
  const extensions = Array.isArray(state && state.extensions) ? state.extensions : [];
  const actionable = extensions.filter((extension) => extension && extension.hasAction && extension.state === 'loaded');
  actionable.forEach((extension) => {
    const listing = getMarketplaceListings(state).find((candidate) => candidate.id === extension.marketplaceId || candidate.extensionId === extension.id);
    if (getPageLauncherSelectors(listing).some((selector) => integratedSelectors.has(selector))) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dock-button dock-action';
    button.dataset.extensionId = extension.id || '';
    button.title = extension.name || 'Open extension';
    button.setAttribute('aria-label', button.title);
    button.appendChild(createInstalledIcon(extension, listing, state));
    button.addEventListener('click', () => {
      setPanelOpen(false);
      openExtensionAction(extension, 'dock');
    });
    container.appendChild(button);
  });
  dock.dataset.hasActions = container.querySelectorAll(':scope > .dock-action').length + integratedSelectors.size > 0 ? 'true' : 'false';
}

function syncIntegratedLaunchers(state) {
  const host = runtimeState.buttonHost;
  if (!host) return new Set();
  const extensions = Array.isArray(state && state.extensions) ? state.extensions : [];
  const listings = getMarketplaceListings(state);
  const desiredSelectors = new Set();
  for (const extension of extensions) {
    if (!extension || extension.state !== 'loaded' || !extension.hasAction) continue;
    const listing = listings.find((candidate) => candidate.id === extension.marketplaceId || candidate.extensionId === extension.id);
    getPageLauncherSelectors(listing).forEach((selector) => desiredSelectors.add(selector));
  }

  for (const [selector, record] of runtimeState.integratedLaunchers) {
    if (desiredSelectors.has(selector) && record.node.isConnected && record.proxy.isConnected) continue;
    restoreIntegratedLauncher(record);
    runtimeState.integratedLaunchers.delete(selector);
  }

  for (const selector of desiredSelectors) {
    if (runtimeState.integratedLaunchers.has(selector)) continue;
    let node;
    try {
      node = document.querySelector(selector);
    } catch (error) {
      logRenderer('invalid page launcher selector', { selector, error: serializeError(error) });
      continue;
    }
    if (!node || !(node instanceof HTMLElement) || node === host || node.closest?.(`#${BUTTON_HOST_ID}`)) continue;
    const proxy = createLauncherProxy(node, selector);
    const record = {
      node,
      parent: node.parentNode,
      style: node.getAttribute('style'),
      ariaHidden: node.getAttribute('aria-hidden'),
      anchor: captureLauncherAnchor(node),
      proxy,
    };
    record.clickHandler = (event) => activateLauncherProxy(event, record);
    record.keyHandler = (event) => handleLauncherProxyKeydown(event, record);
    proxy.addEventListener('click', record.clickHandler);
    proxy.addEventListener('keydown', record.keyHandler);
    hideLauncherAnchor(record);
    host.appendChild(proxy);
    runtimeState.integratedLaunchers.set(selector, record);
    logRenderer('integrated extension page launcher proxy', {
      selector,
      anchor: describeElement(node),
      proxy: describeElement(proxy),
    });
  }
  return new Set([...runtimeState.integratedLaunchers.keys()].filter((selector) => desiredSelectors.has(selector)));
}

function restoreIntegratedLauncher(record) {
  record.proxy.removeEventListener('click', record.clickHandler);
  record.proxy.removeEventListener('keydown', record.keyHandler);
  record.proxy.remove();
  restoreAttribute(record.node, 'style', record.style);
  restoreAttribute(record.node, 'aria-hidden', record.ariaHidden);
}

function createLauncherProxy(node, selector) {
  const proxy = node.cloneNode(true);
  stripDescendantIds(proxy);
  proxy.setAttribute('slot', 'extension-launcher');
  proxy.setAttribute('role', 'button');
  proxy.setAttribute('tabindex', '0');
  proxy.setAttribute('data-loader-launcher-proxy', selector);
  proxy.removeAttribute('aria-hidden');
  return proxy;
}

function stripDescendantIds(node) {
  node.removeAttribute('id');
  node.querySelectorAll('[id]').forEach((descendant) => descendant.removeAttribute('id'));
}

function captureLauncherAnchor(node) {
  const rect = node.getBoundingClientRect();
  const parentRect = node.parentElement && node.parentElement.getBoundingClientRect();
  return {
    height: rect.height,
    width: rect.width,
    offsetLeft: parentRect ? rect.left - parentRect.left : rect.left,
    offsetTop: parentRect ? rect.top - parentRect.top : rect.top,
  };
}

function hideLauncherAnchor(record) {
  record.node.setAttribute('aria-hidden', 'true');
  setLauncherAnchorStyle(record);
}

function updateIntegratedLauncherAnchors() {
  for (const record of runtimeState.integratedLaunchers.values()) {
    if (record.node.isConnected && record.parent && record.parent.isConnected) {
      setLauncherAnchorStyle(record);
    }
  }
}

function setLauncherAnchorStyle(record) {
  const parentRect = record.parent && record.parent.isConnected
    ? record.parent.getBoundingClientRect()
    : { left: 0, top: 0 };
  const styles = {
    height: `${Math.round(record.anchor.height)}px`,
    left: `${Math.round(parentRect.left + record.anchor.offsetLeft)}px`,
    margin: '0px',
    opacity: '0',
    pointerEvents: 'none',
    position: 'fixed',
    top: `${Math.round(parentRect.top + record.anchor.offsetTop)}px`,
    width: `${Math.round(record.anchor.width)}px`,
  };
  for (const [property, value] of Object.entries(styles)) {
    if (record.node.style[property] !== value) record.node.style[property] = value;
  }
}

function activateLauncherProxy(event, record) {
  event.preventDefault();
  event.stopPropagation();
  setPanelOpen(false);
  if (!record.node.isConnected) return;
  const proxyClass = record.proxy.getAttribute('class');
  record.proxy.removeAttribute('class');
  try {
    record.node.click();
  } finally {
    restoreAttribute(record.proxy, 'class', proxyClass);
  }
}

function handleLauncherProxyKeydown(event, record) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  activateLauncherProxy(event, record);
}

function restoreAttribute(node, name, value) {
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
}

function getPageLauncherSelectors(listing) {
  return listing && Array.isArray(listing.pageLauncherSelectors)
    ? listing.pageLauncherSelectors.filter((selector) => typeof selector === 'string' && selector.length > 0)
    : [];
}

function renderBrowseScreen() {
  const screen = createScreen();
  screen.appendChild(createScreenHeader('Add extension'));
  const form = document.createElement('form');
  form.className = 'webstore-install';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Chrome Web Store link or extension ID';
  input.value = runtimeState.webStoreInput;
  input.disabled = runtimeState.webStoreInstallBusy;
  input.setAttribute('aria-label', 'Chrome Web Store link or extension ID');
  input.addEventListener('input', () => {
    runtimeState.webStoreInput = input.value;
    install.disabled = runtimeState.webStoreInstallBusy || !input.value.trim();
  });
  const install = createButton(runtimeState.webStoreInstallBusy ? 'Installing' : 'Install', runtimeState.webStoreInstallBusy ? 'loader' : 'download');
  install.type = 'submit';
  install.disabled = runtimeState.webStoreInstallBusy || !runtimeState.webStoreInput.trim();
  if (runtimeState.webStoreInstallBusy) install.querySelector('svg')?.classList.add('spin');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (runtimeState.webStoreInstallBusy || !runtimeState.webStoreInput.trim()) return;
    runtimeState.webStoreInstallBusy = true;
    renderPanelState(runtimeState.latestState);
    const result = await runManagerOperation({ operation: 'install-webstore', input: runtimeState.webStoreInput.trim() }, { successMessage: 'Extension installed.' });
    runtimeState.webStoreInstallBusy = false;
    if (result) {
      runtimeState.webStoreInput = '';
      setActiveView('installed');
    } else {
      renderPanelState(runtimeState.latestState);
    }
  });
  form.append(input, install);
  screen.appendChild(form);
  return screen;
}

async function installMarketplaceListing(listing) {
  if (!listing || runtimeState.busyListings.has(listing.id)) return;
  runtimeState.busyListings.add(listing.id);
  renderPanelState(runtimeState.latestState);
  const result = await runManagerOperation({
    operation: listing.installed ? 'update-marketplace' : 'install-marketplace',
    marketplaceId: listing.id,
  }, { successMessage: listing.installed ? `${listing.name} updated.` : `${listing.name} installed.` });
  runtimeState.busyListings.delete(listing.id);
  if (result && result.state) runtimeState.latestState = result.state;
  renderPanelState(runtimeState.latestState);
}

function renderInstalledScreen(state) {
  const screen = createScreen();
  const extensions = Array.isArray(state.extensions) ? state.extensions : [];
  screen.appendChild(createScreenHeader('Extensions'));
  if (!extensions.length) {
    const empty = createEmptyState('boxes', 'No extensions', '');
    const browse = createButton('Add extension', 'plus');
    browse.addEventListener('click', () => setActiveView('browse'));
    empty.appendChild(browse);
    screen.appendChild(empty);
    return screen;
  }
  const list = document.createElement('div');
  list.className = 'installed-list';
  extensions.forEach((extension) => list.appendChild(createInstalledRow(extension, state)));
  screen.appendChild(list);
  return screen;
}

async function openExtensionAction(extension, source) {
  if (extension && runtimeState.actionPopupExtensionId === extension.id && isActionPopupOpen()) {
    closeEmbeddedExtensionPopup();
    return true;
  }
  logRenderer('quick action requested', { extensionId: extension.id, key: extension.key, name: extension.name, source });
  const result = await runExtensionOperation(extension, { operation: 'open-extension-surface', surface: 'action' }, null, false);
  if (result && result.surface && result.surface.mode === 'embed') {
    openEmbeddedExtensionPopup(extension, result.surface, source);
  } else if (!result) {
    setPanelOpen(true);
  }
  return Boolean(result);
}

function createInstalledRow(extension, state) {
  const row = document.createElement('div');
  row.className = 'installed-row';
  const listing = getMarketplaceListings(state).find((candidate) => candidate.id === extension.marketplaceId || candidate.extensionId === extension.id);
  row.appendChild(createInstalledIcon(extension, listing, state));
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'row-main';
  main.dataset.extensionId = extension.id || '';
  if (extension.hasAction && extension.state === 'loaded') {
    main.title = 'Open extension';
    main.addEventListener('click', () => openExtensionAction(extension, 'manager'));
  } else {
    main.style.cursor = 'default';
  }
  const nameLine = document.createElement('div');
  nameLine.className = 'row-name-line';
  nameLine.appendChild(createTextNode('div', 'row-name', extension.name || basename(extension.path) || 'Extension'));
  const statusLine = document.createElement('div');
  statusLine.className = 'row-meta status-line';
  const dot = document.createElement('span');
  dot.className = `status-dot ${normalizeExtensionState(extension.state)}`;
  statusLine.append(dot, document.createTextNode(extensionStatusLabel(extension.state)));
  if (extension.version) appendMeta(statusLine, `v${extension.version}`);
  if (extension.source === 'local') appendMeta(statusLine, 'Unpacked');
  main.append(nameLine, statusLine);
  if (extension.error) main.appendChild(createTextNode('div', 'status-error', extension.error));
  row.appendChild(main);

  const busy = runtimeState.busyKeys.has(extension.key);
  const controls = document.createElement('div');
  controls.className = 'installed-controls';
  if (listing && listing.updateAvailable) {
    const update = createButton('Update', 'refresh-cw', 'secondary update-button');
    update.disabled = busy;
    update.addEventListener('click', () => installMarketplaceListing(listing));
    controls.appendChild(update);
  }
  if (extension.hasOptions && extension.state === 'loaded') {
    const options = createIconButton('settings', 'Mod settings');
    options.disabled = busy;
    options.addEventListener('click', () => runExtensionOperation(extension, { operation: 'open-extension-surface', surface: 'options' }, null, false));
    controls.appendChild(options);
  }
  const reload = createIconButton('refresh-cw', 'Reload mod');
  reload.dataset.compactHide = 'true';
  reload.disabled = busy;
  reload.addEventListener('click', () => runExtensionOperation(extension, { operation: 'reload' }, 'Mod reloaded.'));
  const shortcut = createIconButton('monitor-down', 'Create desktop shortcut');
  shortcut.dataset.compactHide = 'true';
  shortcut.disabled = busy;
  shortcut.addEventListener('click', () => runExtensionOperation(extension, { operation: 'create-shortcut' }, 'Desktop shortcut created.', false));
  const remove = createIconButton('trash', 'Remove mod');
  remove.disabled = busy;
  remove.addEventListener('click', () => confirmRemoveExtension(extension));
  controls.append(reload);
  if (state.capabilities && state.capabilities.desktopShortcuts && extension.id) controls.append(shortcut);
  controls.append(remove, createExtensionToggle(extension, busy));
  row.appendChild(controls);
  return row;
}

function createExtensionToggle(extension, disabled) {
  const label = document.createElement('label');
  label.className = 'switch';
  label.title = extension.enabled === false ? 'Enable mod' : 'Disable mod';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = extension.enabled !== false;
  input.disabled = disabled;
  input.setAttribute('aria-label', label.title);
  const track = document.createElement('span');
  track.className = 'switch-track';
  input.addEventListener('change', () => runExtensionOperation(extension, { operation: 'set-enabled', enabled: input.checked }, input.checked ? 'Mod enabled.' : 'Mod disabled.'));
  label.append(input, track);
  return label;
}

function renderInstallRequestScreen(state) {
  const request = state && state.pendingInstall;
  const listing = request && request.listing;
  const screen = createScreen();
  if (!request || !listing) {
    screen.append(createBackHeader('Install extension', () => setActiveView('installed')), createEmptyState('alert-triangle', 'Install request expired', 'Open the installation link again and review the mod before installing.'));
    return screen;
  }

  const dismiss = async () => {
    await runManagerOperation({ operation: 'dismiss-deeplink', token: request.token }, { requiresReload: false });
    runtimeState.pendingInstallToken = null;
    setActiveView('installed');
  };
  screen.appendChild(createBackHeader('Install extension', dismiss));
  const body = document.createElement('section');
  body.className = 'install-body';
  const summary = document.createElement('div');
  summary.className = 'install-summary';
  summary.appendChild(createMarketplaceIcon(listing, false));
  const summaryCopy = document.createElement('div');
  summaryCopy.className = 'install-summary-copy';
  summaryCopy.appendChild(createTextNode('h1', 'install-name', listing.name));
  const source = document.createElement('div');
  source.className = `install-source${request.source === 'webstore' ? ' unreviewed' : ''}`;
  source.innerHTML = iconMarkup(request.source === 'webstore' ? 'shield-alert' : 'badge-check');
  source.appendChild(document.createTextNode(request.source === 'webstore'
    ? 'Chrome Web Store · Not reviewed by AddonPort'
    : 'AddonPort catalog · Reviewed for FACEIT'));
  summaryCopy.appendChild(source);
  summary.appendChild(summaryCopy);
  body.appendChild(summary);

  const permissions = Array.isArray(listing.permissions) ? listing.permissions.filter(Boolean) : [];
  if (permissions.length) {
    const permissionSection = document.createElement('section');
    permissionSection.className = 'install-permissions';
    permissionSection.appendChild(createTextNode('h2', null, 'Permissions'));
    const list = document.createElement('ul');
    permissions.forEach((permission) => list.appendChild(createTextNode('li', null, permission)));
    permissionSection.appendChild(list);
    body.appendChild(permissionSection);
  }

  const actions = document.createElement('div');
  actions.className = 'install-actions';
  const alreadyInstalled = Boolean(listing.installed && !listing.updateAvailable);
  if (alreadyInstalled) {
    actions.classList.add('single');
    const done = createButton('Done', 'check');
    done.addEventListener('click', dismiss);
    actions.appendChild(done);
  } else {
    const cancel = createButton('Cancel', null, 'secondary');
    cancel.addEventListener('click', dismiss);
    const install = createButton(listing.installed ? 'Update' : 'Install', listing.installed ? 'refresh-cw' : 'download');
    install.disabled = runtimeState.busyListings.has(listing.id);
    install.addEventListener('click', async () => {
      if (runtimeState.busyListings.has(listing.id)) return;
      runtimeState.busyListings.add(listing.id);
      renderPanelState(runtimeState.latestState);
      const result = await runManagerOperation({ operation: 'install-deeplink', token: request.token }, { successMessage: listing.installed ? `${listing.name} updated.` : `${listing.name} installed.` });
      runtimeState.busyListings.delete(listing.id);
      runtimeState.pendingInstallToken = null;
      if (result) setActiveView('installed');
      else renderPanelState(runtimeState.latestState);
    });
    actions.append(cancel, install);
  }
  body.appendChild(actions);
  screen.appendChild(body);
  return screen;
}

function renderSettingsScreen(state) {
  const screen = createScreen();
  screen.appendChild(createBackHeader('Settings', () => setActiveView('installed')));
  const managerRows = [
    createSettingsRow('refresh-cw', 'Refresh state', 'Re-read loaded mods and action state', () => refreshState(), 'Refresh'),
    createSettingsRow('folder-open', 'Open data folder', state.userDataPath || 'Extension loader storage', () => runManagerOperation({ operation: 'open-data-folder' }, { requiresReload: false }), 'Open'),
  ];
  if (state.capabilities && state.capabilities.desktopShortcuts) {
    managerRows.push(createSettingsRow('monitor-down', 'Desktop shortcut', 'Open FACEIT directly in the Mods manager', () => runManagerOperation({ operation: 'create-shortcut' }, { successMessage: 'Desktop shortcut created.', requiresReload: false }), 'Create'));
  }
  screen.appendChild(createSettingsGroup('Manager', managerRows));
  screen.appendChild(createSettingsGroup('Developer', [
    createSettingsRow('folder-plus', 'Load unpacked mod', 'Add a local extension folder without copying it', () => runManagerOperation({ operation: 'add-from-folder' }, { successMessage: 'Unpacked mod added.' }), 'Choose'),
  ]));
  screen.appendChild(createSettingsGroup('Diagnostics', [
    createSettingsRow('copy', 'Copy diagnostic report', `Loader ${state.loader && state.loader.version ? state.loader.version : 'unknown'}`, () => runManagerOperation({ operation: 'copy-diagnostics' }, { successMessage: 'Diagnostic report copied.', requiresReload: false }), 'Copy'),
  ]));
  const logs = state.diagnostics && Array.isArray(state.diagnostics.recentLogs) ? state.diagnostics.recentLogs.slice(-60) : [];
  const pre = document.createElement('pre');
  pre.className = 'log';
  pre.textContent = logs.length ? logs.join('\n') : 'No log entries yet.';
  screen.appendChild(pre);
  return screen;
}

function createSettingsGroup(title, rows) {
  const group = document.createElement('section');
  group.className = 'settings-group';
  group.appendChild(createTextNode('div', 'settings-group-title', title));
  rows.forEach((row) => group.appendChild(row));
  return group;
}

function createSettingsRow(icon, title, subtitle, handler, actionLabel) {
  const row = document.createElement('div');
  row.className = 'settings-row';
  const iconNode = document.createElement('div');
  iconNode.className = 'settings-row-icon';
  iconNode.innerHTML = iconMarkup(icon);
  const copy = document.createElement('div');
  copy.className = 'settings-row-copy';
  copy.append(createTextNode('div', 'settings-row-title', title), createTextNode('div', 'settings-row-subtitle', subtitle));
  const button = createButton(actionLabel, null, 'secondary');
  button.addEventListener('click', handler);
  row.append(iconNode, copy, button);
  return row;
}

function createDetailListSection(title, items, icon) {
  const section = document.createElement('section');
  section.className = 'detail-section';
  section.appendChild(createTextNode('h2', '', title));
  const list = document.createElement('ul');
  list.className = icon === 'shield' ? 'permission-list' : 'feature-list';
  (Array.isArray(items) ? items : []).forEach((item) => {
    const row = document.createElement('li');
    row.innerHTML = iconMarkup(icon);
    row.appendChild(document.createTextNode(item));
    list.appendChild(row);
  });
  section.appendChild(list);
  return section;
}

function createCompatibilityLabel(listing) {
  const node = document.createElement('div');
  const tested = listing.compatibility === 'tested';
  node.className = tested ? 'compatibility' : 'compatibility experimental';
  const unreviewed = listing.compatibility === 'unreviewed';
  node.innerHTML = iconMarkup(tested ? 'badge-check' : (unreviewed ? 'shield-alert' : 'flask'));
  node.appendChild(document.createTextNode(tested
    ? 'Tested with AddonPort for FACEIT'
    : (unreviewed ? 'Not reviewed in the catalog' : 'Experimental compatibility')));
  return node;
}

function createScreen() {
  const screen = document.createElement('div');
  screen.className = 'screen';
  return screen;
}

function createScreenHeader(title, subtitle) {
  const header = document.createElement('header');
  header.className = 'screen-header';
  header.appendChild(createTextNode('h1', 'screen-title', title));
  if (subtitle) header.appendChild(createTextNode('p', 'screen-subtitle', subtitle));
  return header;
}

function createBackHeader(title, onBack) {
  const header = document.createElement('header');
  header.className = 'screen-header compact';
  const back = createIconButton('arrow-left', 'Back');
  back.classList.add('back-button');
  back.addEventListener('click', onBack);
  header.append(back, createTextNode('h1', 'screen-title', title));
  return header;
}

function createEmptyState(icon, title, copy) {
  const empty = document.createElement('div');
  empty.className = 'empty';
  const iconNode = document.createElement('div');
  iconNode.className = 'empty-icon';
  iconNode.innerHTML = iconMarkup(icon);
  empty.append(iconNode, createTextNode('h2', '', title), createTextNode('p', '', copy));
  return empty;
}

function createMarketplaceIcon(listing, large = false) {
  const icon = document.createElement('div');
  icon.className = large ? 'mod-icon large' : 'mod-icon';
  icon.style.setProperty('--accent', listing.accent || '#3b3b42');
  icon.textContent = listing.monogram || String(listing.name || '?').slice(0, 1);
  if (listing.iconUrl) {
    const image = new Image();
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => image.remove(), { once: true });
    icon.appendChild(image);
    image.src = listing.iconUrl;
  }
  return icon;
}

function createInstalledIcon(extension, listing, state) {
  const icon = createMarketplaceIcon(listing || { accent: '#3b3b42', monogram: String(extension.name || '?').slice(0, 1) });
  if (!extension.id || extension.state !== 'loaded') return icon;
  const tabId = state.actionState && Number.isFinite(state.actionState.activeTabId) ? state.actionState.activeTabId : -1;
  const image = new Image();
  image.alt = '';
  image.addEventListener('load', () => { replaceChildren(icon); icon.appendChild(image); }, { once: true });
  image.src = `crx://extension-icon/${encodeURIComponent(extension.id)}/64/2?${new URLSearchParams({ tabId: String(tabId), partition: '_self' })}`;
  return icon;
}

function appendMeta(container, ...values) {
  values.filter(Boolean).forEach((value) => {
    if (container.childNodes.length) {
      const dot = document.createElement('span');
      dot.className = 'meta-dot';
      container.appendChild(dot);
    }
    container.appendChild(document.createTextNode(String(value)));
  });
}

function createButton(label, icon, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = ['button', className].filter(Boolean).join(' ');
  if (icon) button.innerHTML = iconMarkup(icon);
  const text = document.createElement('span');
  text.textContent = label;
  button.appendChild(text);
  return button;
}

function createIconButton(icon, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = iconMarkup(icon);
  return button;
}

function createTextNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(text || '');
  return node;
}

function getMarketplaceListings(state) {
  return state && state.marketplace && Array.isArray(state.marketplace.extensions) ? state.marketplace.extensions : [];
}

async function runExtensionOperation(extension, request, successMessage, requiresReload = true) {
  if (!extension || !extension.key || runtimeState.busyKeys.has(extension.key)) return null;
  runtimeState.busyKeys.add(extension.key);
  renderPanelState(runtimeState.latestState);
  const result = await runManagerOperation({ ...request, key: extension.key }, { successMessage, requiresReload });
  runtimeState.busyKeys.delete(extension.key);
  renderPanelState(runtimeState.latestState);
  return result;
}

async function runManagerOperation(request, options = {}) {
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
    showToast('AddonPort bridge is unavailable.', 'error');
    return null;
  }
  logRenderer('manager operation requested', {
    operation: request.operation,
    marketplaceId: request.marketplaceId,
    key: request.key,
    hasInput: Boolean(request.input),
  });
  try {
    const result = await ipcRenderer.invoke(IPC_MANAGE_EXTENSION, request);
    if (result && result.cancelled) return result;
    if (result && result.state) runtimeState.latestState = result.state;
    if (result && result.pageReloadRequired && options.requiresReload !== false) runtimeState.pendingPageReload = true;
    renderPanelState(runtimeState.latestState);
    if (options.successMessage) showToast(options.successMessage);
    logRenderer('manager operation completed', {
      operation: request.operation,
      marketplaceId: request.marketplaceId,
      key: request.key,
      pageReloadRequired: Boolean(result && result.pageReloadRequired),
    });
    return result;
  } catch (error) {
    showToast(error.message || String(error), 'error');
    logRenderer('manager operation failed', { operation: request.operation, error: serializeError(error) });
    renderPanelState(runtimeState.latestState);
    return null;
  }
}

function confirmRemoveExtension(extension) {
  const managed = ['marketplace', 'webstore'].includes(extension.source);
  showConfirmation({
    title: `Remove ${extension.name || 'mod'}?`,
    copy: managed ? 'The mod and its managed files will be removed from FACEIT.' : 'The mod will be detached from FACEIT. Its original folder will stay untouched.',
    onConfirm: async () => {
      const result = await runExtensionOperation(extension, { operation: 'remove' }, 'Mod removed.');
      if (result) setActiveView('installed');
    },
  });
}

function showConfirmation({ title, copy, onConfirm }) {
  const overlay = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="confirmation"]');
  const action = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="confirm-action"]');
  if (!overlay || !action) return;
  setText('[data-role="confirm-title"]', title);
  setText('[data-role="confirm-copy"]', copy);
  const replacement = action.cloneNode(true);
  action.replaceWith(replacement);
  replacement.addEventListener('click', async () => { hideConfirmation(); await onConfirm(); }, { once: true });
  overlay.setAttribute('data-visible', 'true');
  replacement.focus({ preventScroll: true });
}

function hideConfirmation() {
  const overlay = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="confirmation"]');
  if (overlay) overlay.setAttribute('data-visible', 'false');
}

function renderReloadBanner() {
  const banner = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="reload-banner"]');
  if (banner) banner.setAttribute('data-visible', runtimeState.pendingPageReload ? 'true' : 'false');
}

function renderFatalError(error) {
  const content = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="content"]');
  if (!content) return;
  replaceChildren(content);
  content.appendChild(createEmptyState('alert-triangle', 'AddonPort did not start', error.message || String(error)));
}

function showToast(message, type = 'info') {
  if (!message) return;
  const container = runtimeState.panelRoot && runtimeState.panelRoot.querySelector('[data-role="toasts"]');
  if (!container) return;
  const toast = createTextNode('div', type === 'error' ? 'toast error' : 'toast', message);
  container.appendChild(toast);
  window.setTimeout(() => toast.remove(), 3800);
}

function updateButtonBadge(state) {
  const count = getMarketplaceListings(state).filter((listing) => listing && listing.updateAvailable).length;
  const fallback = runtimeState.buttonRoot && runtimeState.buttonRoot.querySelector('.badge');
  if (fallback) {
    fallback.textContent = String(count);
    fallback.dataset.visible = count > 0 ? 'true' : 'false';
  }
}

function normalizeExtensionState(state) {
  return ['loaded', 'disabled', 'failed', 'invalid'].includes(state) ? state : 'unknown';
}

function extensionStatusLabel(state) {
  return { loaded: 'Active', disabled: 'Disabled', failed: 'Failed', invalid: 'Invalid' }[state] || 'Unknown';
}

function summarizeState(state) {
  const extensions = Array.isArray(state && state.extensions) ? state.extensions : [];
  const listings = getMarketplaceListings(state);
  return {
    extensionCount: extensions.length,
    activeCount: extensions.filter((extension) => extension.state === 'loaded').length,
    marketplaceCount: listings.length,
    updateCount: listings.filter((listing) => listing.updateAvailable).length,
  };
}

function setText(selector, value) {
  const node = runtimeState.panelRoot && runtimeState.panelRoot.querySelector(selector);
  if (node) node.textContent = String(value);
}

function replaceChildren(node) {
  if (!node) return;
  while (node.firstChild) node.firstChild.remove();
}

function basename(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function logRenderer(message, details) {
  try {
    if (ipcRenderer && typeof ipcRenderer.send === 'function') {
      ipcRenderer.send(IPC_RENDERER_LOG, { message, details, href: location.href, readyState: document.readyState });
    }
  } catch (_error) {
    // Diagnostics must never affect FACEIT rendering.
  }
}

function serializeError(error) {
  return error ? { name: error.name, message: error.message || String(error), stack: error.stack } : null;
}

function describeElement(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) return String(element && element.nodeName ? element.nodeName : element);
  const parts = [element.tagName.toLowerCase()];
  if (element.id) parts.push(`#${element.id}`);
  if (typeof element.className === 'string' && element.className) parts.push(`.${element.className.trim().split(/\s+/).slice(0, 3).join('.')}`);
  return parts.join('');
}

// Lucide paths are inlined because this preload runs in FACEIT's sandboxed renderer.
function iconMarkup(name) {
  const icons = {
    'alert-triangle': '<path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'badge-check': '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
    boxes: '<path d="M2.97 12.92 7 15.25l4.03-2.33"/><path d="m7 10.58-4.03-2.33L7 5.92l4.03 2.33Z"/><path d="M7 15.25v4.66"/><path d="M12.97 19.25 17 21.58l4.03-2.33"/><path d="m17 16.92-4.03-2.33L17 12.25l4.03 2.34Z"/><path d="M17 21.58v-4.66"/><path d="M12.97 5.25 17 7.58l4.03-2.33"/><path d="M17 7.58V2.92"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-1.84 5.54-5.54 1.84 1.84-5.54Z"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    'external-link': '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    flask: '<path d="M9 3h6"/><path d="M10 9V3h4v6l5 8a2 2 0 0 1-1.7 3H6.7A2 2 0 0 1 5 17Z"/><path d="M7.5 15h9"/>',
    'folder-open': '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.46 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2A2 2 0 0 0 12.1 6H18a2 2 0 0 1 2 2v2"/>',
    'folder-plus': '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2A2 2 0 0 0 12.1 6H18a2 2 0 0 1 2 2Z"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.22-8.56"/>',
    'monitor-down': '<path d="M12 13V7"/><path d="m9 10 3 3 3-3"/><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'panel-top-open': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="m15 14 2 2 4-4"/>',
    'refresh-cw': '<path d="M21 12a9 9 0 0 0-15.17-6.56L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.17 6.56L21 16"/><path d="M16 16h5v5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/>',
    'shield-alert': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };
  const paths = icons[name] || icons.boxes;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
