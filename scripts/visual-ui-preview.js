'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const packageJson = require('../package.json');

const toolbarPath = path.join(__dirname, '..', 'mod', 'extension-toolbar-preload.js');
const toolbarSource = fs.readFileSync(toolbarPath, 'utf8')
  .replace("const { ipcRenderer } = safeRequireElectron();", `const ipcRenderer = {
    async invoke(channel, request) {
      if (channel === 'faceit-extension-loader:get-state') return globalThis.__previewState;
      if (channel === 'faceit-extension-loader:manage-extension') {
        globalThis.__previewManagerRequests ||= [];
        globalThis.__previewManagerRequests.push(request);
      }
      if (channel === 'faceit-extension-loader:manage-extension'
        && request && request.operation === 'open-extension-surface' && request.surface === 'action') {
        const extension = globalThis.__previewState.extensions.find((candidate) => candidate.key === request.key);
        return {
          state: globalThis.__previewState,
          surface: {
            mode: 'embed',
            extensionId: extension.id,
            name: extension.name,
            width: 420,
            height: 560,
          },
        };
      }
      return { state: globalThis.__previewState };
    },
    on(channel, listener) {
      globalThis.__previewListeners ||= {};
      globalThis.__previewListeners[channel] = listener;
    },
    send() {},
  };`)
  .replace('if (shouldInject()) {', 'if (true) {');

const previewState = {
  actionState: { activeTabId: 7, actions: [] },
  capabilities: { desktopShortcuts: true },
  diagnostics: { recentLogs: [] },
  extensions: [
    { key: 'peekstats', id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'PeekStats', version: '2.1.6', enabled: true, state: 'loaded', hasAction: true, hasOptions: true, source: 'marketplace', marketplaceId: 'peekstats' },
    { key: 'forecast', id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'FACEIT Forecast', version: '2.1.3', enabled: true, state: 'loaded', hasAction: true, hasOptions: false, source: 'marketplace', marketplaceId: 'faceit-forecast' },
    { key: 'repeek', id: 'cccccccccccccccccccccccccccccccc', name: 'Repeek', version: '5.6.10', enabled: false, state: 'disabled', hasAction: true, hasOptions: true, source: 'marketplace', marketplaceId: 'repeek' },
  ],
  loader: { version: packageJson.version },
  marketplace: {
    extensions: [
      { id: 'peekstats', extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'PeekStats', monogram: 'P', accent: '#4f7fe8', category: 'Statistics', audience: 'Players', tagline: 'Player statistics and match insights', installed: true },
      { id: 'faceit-forecast', extensionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'FACEIT Forecast', monogram: 'F', accent: '#2878c7', category: 'Prediction', audience: 'Players', tagline: 'Match forecasts', installed: true, pageLauncherSelectors: ['#fc-logo-button'] },
      { id: 'repeek', extensionId: 'cccccccccccccccccccccccccccccccc', name: 'Repeek', monogram: 'R', accent: '#f2f2f2', category: 'Utility', audience: 'Players', tagline: 'Ready-up and ELO tools', installed: true },
    ],
  },
  userDataPath: 'C:\\Users\\dimit\\AppData\\Roaming\\FACEIT\\extension-loader',
};

for (let index = 0; index < 7; index += 1) {
  const letter = String.fromCharCode('d'.charCodeAt(0) + index);
  const id = letter.repeat(32);
  const marketplaceId = `preview-mod-${index + 1}`;
  previewState.extensions.push({ key: marketplaceId, id, name: `Preview Mod ${index + 1}`, version: '1.0.0', enabled: true, state: 'loaded', hasAction: true, hasOptions: false, source: 'marketplace', marketplaceId });
  previewState.marketplace.extensions.push({ id: marketplaceId, extensionId: id, name: `Preview Mod ${index + 1}`, monogram: String(index + 1), accent: '#3d566e', category: 'Utility', audience: 'Players', tagline: 'Preview extension', installed: true });
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:#0f0f0f;color:#fff;font-family:Inter,Arial,sans-serif}.app{display:grid;grid-template-columns:220px 1fr;height:100%;padding-right:64px}.nav{background:#161616;border-right:1px solid #292929;padding:18px 10px}.logo{font-size:20px;font-weight:800;padding:8px 12px 20px}.styles__ScrollableNavSectionWrapper-demo{display:flex;flex-direction:column;gap:2px}.NavSectionItem__Wrapper-demo{height:48px}.styles__Holder-demo{height:100%}.styles__NavControlBackground-demo{align-items:center;color:#aaa;display:flex;height:100%;width:100%}.styles__NavControlContainer-demo{align-items:center;display:flex;gap:12px;height:100%;padding:0 12px;position:relative}.styles__IconWrapper-demo{align-items:center;display:flex;height:24px;justify-content:center;width:24px}.styles__NavControlText-demo{font-size:14px;font-weight:600}.content-preview{background:#111;padding:34px}.content-preview h1{font-size:24px;margin:0 0 12px}.content-preview p{color:#888;margin:0}.NavSectionItem__Wrapper-demo:hover .styles__NavControlBackground-demo{background:#242424;color:#fff}.styles__SideBarContainer-demo{align-items:center;background:#121212;border-left:1px solid #292929;bottom:0;display:flex;flex-direction:column;position:fixed;right:0;top:40px;width:64px;z-index:10}.styles__SideBarContainer-hidden{visibility:hidden}.styles__TopContent-demo{height:68px}.styles__ButtonsContainer-demo{display:flex;flex-direction:column;width:100%}.RightNavSectionItem__Wrapper-demo{height:48px;width:64px}.RightHolder-demo{height:100%}.RightButtonBase-demo{align-items:center;background:transparent;border:0;border-radius:4px;color:#aaa;cursor:pointer;display:flex;height:48px;justify-content:center;padding:0;width:64px}.RightButtonBase-demo:hover,.RightButtonBase-demo[aria-pressed="true"]{background:#272727;color:#fff}.RightIconWrapper-demo{align-items:center;display:flex;justify-content:center}.RightIconWrapper-demo svg{height:24px;width:24px}#fc-logo-button{align-items:center;background:#1c1c1c;border:1px solid rgba(255,106,0,.42);border-radius:8px;color:#ff6a00;cursor:pointer;display:flex;font-weight:800;height:44px;justify-content:center;margin:0 10px 10px;width:44px}.fc-logo-gradient{align-items:center;display:flex;height:100%;justify-content:center;width:100%}
@media(max-width:700px){.app{grid-template-columns:72px 1fr}.nav{padding:18px 8px}.logo{font-size:0;padding:8px 0 20px;text-align:center}.logo:after{content:'F';font-size:20px}.styles__NavControlContainer-demo{justify-content:center;padding:0}.styles__NavControlText-demo{display:none}}
</style></head><body><div class="app"><aside class="nav"><div class="logo">FACEIT</div><div class="styles__ScrollableNavSectionWrapper-demo">
<div class="NavSectionItem__Wrapper-demo"><a aria-label="Play"><div class="styles__Holder-demo"><span class="styles__NavControlBackground-demo"><div class="styles__NavControlContainer-demo"><div class="styles__IconWrapper-demo"><i><svg viewBox="0 0 24 24" height="24" width="24"><path fill="currentColor" d="m8 5 11 7-11 7z"/></svg></i></div><span class="styles__NavControlText-demo">Play</span></div></span></div></a></div>
<div class="NavSectionItem__Wrapper-demo"><a aria-label="Rank"><div class="styles__Holder-demo"><span class="styles__NavControlBackground-demo"><div class="styles__NavControlContainer-demo"><div class="styles__IconWrapper-demo"><i><svg viewBox="0 0 24 24" height="24" width="24"><path fill="currentColor" d="M4 19h16v2H4zM6 12h3v7H6zm5-5h3v12h-3zm5 3h3v9h-3z"/></svg></i></div><span class="styles__NavControlText-demo">Rank</span></div></span></div></a></div>
<div class="styles__MobileFooterNavSection-demo"></div>
</div></aside><main class="content-preview"><h1>Matchroom</h1><p>FACEIT page preview</p></main></div>
<aside class="styles__SideBarContainer-demo styles__SideBarContainer-hidden"><div class="styles__ButtonsContainer-hidden"></div></aside>
<aside class="styles__SideBarContainer-demo"><div class="styles__TopContent-demo"></div><div class="styles__ButtonsContainer-demo">
<div class="RightNavSectionItem__Wrapper-demo"><div class="RightHolder-demo"><button type="button" class="RightButtonBase-demo" aria-label="Matches"><div class="RightIconWrapper-demo"><i><svg viewBox="0 0 24 24"><path fill="currentColor" d="M4 7h16v10H4z"/></svg></i></div></button></div></div>
<div class="RightNavSectionItem__Wrapper-demo"><div class="RightHolder-demo"><button type="button" class="RightButtonBase-demo" aria-label="Notifications"><div class="RightIconWrapper-demo"><i><svg viewBox="0 0 24 24"><path fill="currentColor" d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg></i><div class="styles__StartIconLabelWrapper-demo"><span class="Badge__Holder-demo">2</span></div></div></button></div></div>
<div class="RightNavSectionItem__Wrapper-demo"><div class="RightHolder-demo"><button type="button" class="RightButtonBase-demo" aria-label="Social"><div class="RightIconWrapper-demo"><i><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8m-7 8a7 7 0 0 1 14 0z"/></svg></i></div></button></div></div>
</div><div id="fc-logo-button" class="fc-logo-container" title="FORECAST"><div class="fc-logo-gradient">F</div></div></aside></body></html>`;

async function render() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of [
      { name: 'wide', width: 1280, height: 800 },
      { name: 'narrow', width: 520, height: 760 },
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.setContent(html);
      await page.evaluate((state) => {
        globalThis.__previewState = state;
        globalThis.__forecastLauncherClicks = 0;
        document.getElementById('fc-logo-button').addEventListener('click', () => {
          globalThis.__forecastLauncherClicks += 1;
          const existing = document.getElementById('forecast-popup-container');
          if (existing) {
            existing.remove();
            return;
          }
          const launcher = document.querySelector('.fc-logo-container');
          const rect = launcher.getBoundingClientRect();
          const popup = document.createElement('div');
          popup.id = 'forecast-popup-container';
          Object.assign(popup.style, {
            background: '#101010',
            height: '400px',
            position: 'fixed',
            width: '480px',
            zIndex: '9999',
          });
          let top = rect.bottom + 10;
          let left = rect.left;
          if (top + 400 > innerHeight) top = Math.max(10, innerHeight - 410);
          if (left + 480 > innerWidth) left = Math.max(10, innerWidth - 490);
          popup.style.top = `${top}px`;
          popup.style.left = `${left}px`;
          document.body.appendChild(popup);
        });
      }, previewState);
      await page.addScriptTag({ content: toolbarSource });
      await page.locator('#faceit-extension-loader-button-host').evaluate((node) => node.remove());
      await page.waitForTimeout(300);
      await page.locator('#faceit-extension-loader-button-host .mods-button').click();
      await page.waitForTimeout(350);
      const metrics = await page.evaluate(() => {
        const host = document.getElementById('faceit-extension-loader-panel-host');
        const panel = host.shadowRoot.querySelector('.panel');
        const buttonHost = document.getElementById('faceit-extension-loader-button-host');
        const dockRoot = buttonHost.shadowRoot;
        const modsButton = dockRoot.querySelector('.mods-button');
        const dock = dockRoot.querySelector('.dock');
        const sidebar = Array.from(document.querySelectorAll('[class*="SideBarContainer"]')).find((candidate) => {
          const style = getComputedStyle(candidate);
          return candidate.getBoundingClientRect().width > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const rect = panel.getBoundingClientRect();
        const dockRect = dock.getBoundingClientRect();
        const buttonRect = modsButton.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const dockActions = dockRoot.querySelectorAll('.dock-action');
        const integratedLaunchers = buttonHost.querySelectorAll('[slot="extension-launcher"]');
        const forecastAnchor = document.getElementById('fc-logo-button');
        const forecastProxy = buttonHost.querySelector('[data-loader-launcher-proxy="#fc-logo-button"]');
        const dockActionsContainer = dockRoot.querySelector('[data-role="dock-actions"]');
        const dockStyle = getComputedStyle(dock);
        const separatorStyle = getComputedStyle(modsButton, '::before');
        const generatedActionStyle = getComputedStyle(dockActions[0]);
        const integratedLauncherStyle = getComputedStyle(integratedLaunchers[0]);
        const modsButtonStyle = getComputedStyle(modsButton);
        return {
          panel: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          dock: { left: dockRect.left, top: dockRect.top, right: dockRect.right, bottom: dockRect.bottom, width: dockRect.width, height: dockRect.height },
          modsButton: { left: buttonRect.left, top: buttonRect.top, right: buttonRect.right, bottom: buttonRect.bottom, width: buttonRect.width, height: buttonRect.height },
          buttonOwnedByBody: buttonHost.parentElement === document.body,
          modsMatchesNativeInset: Math.abs(buttonRect.right - (sidebarRect.right - 10)) < 1 && Math.abs(buttonRect.bottom - (sidebarRect.bottom - 8)) < 1 && buttonRect.width === 44 && buttonRect.height === 44,
          dockHasBackdrop: dockStyle.backgroundColor === getComputedStyle(sidebar).backgroundColor && dockStyle.borderTopWidth === '0px' && dockStyle.borderRadius === '0px' && dockStyle.boxShadow === 'none' && dockRect.width === sidebarRect.width,
          dockChildCount: dock.children.length,
          groupsSeparated: separatorStyle.content === '""' && separatorStyle.width === '24px' && separatorStyle.height === '1px',
          actionsBorderless: generatedActionStyle.borderTopWidth === '0px' && integratedLauncherStyle.borderTopWidth === '0px',
          buttonsPreserved: generatedActionStyle.backgroundColor === 'rgb(32, 32, 32)' && integratedLauncherStyle.backgroundColor === 'rgb(32, 32, 32)',
          modsContrasted: modsButtonStyle.backgroundColor !== generatedActionStyle.backgroundColor,
          dockActionCount: dockActions.length + integratedLaunchers.length,
          dockScrollable: dockActionsContainer.scrollHeight > dockActionsContainer.clientHeight,
          forecastIntegrated: forecastProxy?.parentElement === buttonHost,
          forecastAnchorPreserved: forecastAnchor?.closest('[class*="SideBarContainer"]') === sidebar && getComputedStyle(forecastAnchor).position === 'fixed' && getComputedStyle(forecastAnchor).opacity === '0',
          forecastGeneratedDuplicate: Boolean(dockRoot.querySelector('[data-extension-id="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]')),
          integratedLauncherDepth: forecastProxy?.parentElement === buttonHost ? 1 : -1,
          panelGapFromSidebar: Math.abs(rect.right - (sidebarRect.left - 8)) < 1,
          activeTab: host.shadowRoot.querySelector('[data-view][data-active="true"]')?.dataset.view,
        };
      });
      if (metrics.panel.left < 0 || metrics.panel.top < 0 || metrics.panel.right > viewport.width || metrics.panel.bottom > viewport.height) {
        throw new Error(`${viewport.name} panel is outside viewport: ${JSON.stringify(metrics.panel)}`);
      }
      if (metrics.activeTab !== 'installed' || metrics.dockActionCount !== 9 || !metrics.dockScrollable || !metrics.buttonOwnedByBody || !metrics.modsMatchesNativeInset || !metrics.dockHasBackdrop || metrics.dockChildCount !== 2 || !metrics.groupsSeparated || !metrics.actionsBorderless || !metrics.buttonsPreserved || !metrics.modsContrasted || !metrics.panelGapFromSidebar || !metrics.forecastIntegrated || !metrics.forecastAnchorPreserved || metrics.forecastGeneratedDuplicate || metrics.integratedLauncherDepth !== 1 || metrics.panel.height >= viewport.height) {
        throw new Error(`${viewport.name} preview state is invalid: ${JSON.stringify(metrics)}`);
      }
      const screenshot = path.join('/tmp', `faceit-mods-${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      console.log(JSON.stringify({ screenshot, viewport, ...metrics }));

      await page.locator('#faceit-extension-loader-panel-host [title="Create desktop shortcut"]').first().evaluate((node) => node.click());
      const shortcutRequest = await page.evaluate(() => globalThis.__previewManagerRequests.at(-1));
      if (!shortcutRequest || shortcutRequest.operation !== 'create-shortcut' || !shortcutRequest.key) {
        throw new Error(`${viewport.name} extension shortcut request failed: ${JSON.stringify(shortcutRequest)}`);
      }
      await page.evaluate(() => {
        const root = document.getElementById('faceit-extension-loader-panel-host').shadowRoot;
        root.querySelector('[data-role="toasts"]').replaceChildren();
      });

      await page.locator('[data-loader-launcher-proxy="#fc-logo-button"]').evaluate((node) => node.click());
      const launcherClick = await page.evaluate(() => ({
        clicks: globalThis.__forecastLauncherClicks,
        modsOpen: document.getElementById('faceit-extension-loader-panel-host').hasAttribute('data-open'),
        popup: (() => {
          const rect = document.getElementById('forecast-popup-container')?.getBoundingClientRect();
          return rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        })(),
      }));
      if (launcherClick.clicks !== 1 || launcherClick.modsOpen || !launcherClick.popup || launcherClick.popup.left < 0 || launcherClick.popup.top < 0 || launcherClick.popup.right > viewport.width || launcherClick.popup.bottom > viewport.height) {
        throw new Error(`${viewport.name} integrated launcher click failed: ${JSON.stringify(launcherClick)}`);
      }
      const popupScreenshot = path.join('/tmp', `faceit-mods-launcher-popup-${viewport.name}.png`);
      await page.screenshot({ path: popupScreenshot, fullPage: true });
      console.log(JSON.stringify({ screenshot: popupScreenshot, viewport, launcherClick }));
      await page.locator('#forecast-popup-container').evaluate((node) => node.remove());

      await page.locator('#faceit-extension-loader-button-host .dock-action[data-extension-id="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]').click();
      await page.waitForTimeout(200);
      const embeddedPopup = await page.evaluate(() => {
        globalThis.__previewListeners['faceit-extension-loader:action-popup-state']({}, {
          open: true,
          extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          name: 'PeekStats',
          width: 720,
          height: 540,
        });
        const host = document.getElementById('faceit-extension-loader-action-popup-host');
        const surface = host.shadowRoot.querySelector('.surface');
        surface.innerHTML = `<style>*{box-sizing:border-box}.layout{background:#101010;color:#f4f4f5;display:grid;font:14px Inter,Arial,sans-serif;grid-template-columns:180px 1fr;height:100%}.nav{background:#191919;border-right:1px solid #303030;padding:20px 12px}.brand{font-size:22px;font-weight:800;margin-bottom:28px}.nav div+div{color:#aaa;margin-top:18px}.content{padding:26px}.content h2{font-size:19px;margin:0 0 22px}.setting{border-top:1px solid #303030;padding:20px 0}.switch{background:#4f7fe8;border-radius:10px;float:right;height:20px;width:36px}</style><div class="layout"><div class="nav"><div class="brand">PEEKSTATS</div><div>Overview</div><div>Players</div><div>Settings</div></div><div class="content"><h2>Match insights</h2><div class="setting"><span class="switch"></span>Recent form</div><div class="setting"><span class="switch"></span>Player comparison</div><div class="setting">Map performance</div></div></div>`;
        const rect = host.getBoundingClientRect();
        return {
          open: host.hasAttribute('data-open'),
          panelOpen: document.getElementById('faceit-extension-loader-panel-host').hasAttribute('data-open'),
          hasSurface: Boolean(surface),
          hasIframe: Boolean(host.shadowRoot.querySelector('iframe')),
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        };
      });
      const expectedPopupWidth = Math.min(720, viewport.width - 20);
      if (!embeddedPopup.open || embeddedPopup.panelOpen || !embeddedPopup.hasSurface || embeddedPopup.hasIframe
        || Math.abs(embeddedPopup.rect.width - expectedPopupWidth) > 1 || Math.abs(embeddedPopup.rect.height - 540) > 1
        || Math.abs(embeddedPopup.rect.right - (viewport.width - 10)) > 1 || Math.abs(embeddedPopup.rect.bottom - (viewport.height - 10)) > 1
        || embeddedPopup.rect.left < 0 || embeddedPopup.rect.top < 0) {
        throw new Error(`${viewport.name} embedded action popup is invalid: ${JSON.stringify(embeddedPopup)}`);
      }
      const embeddedScreenshot = path.join('/tmp', `faceit-mods-embedded-popup-${viewport.name}.png`);
      await page.screenshot({ path: embeddedScreenshot, fullPage: true });
      console.log(JSON.stringify({ screenshot: embeddedScreenshot, viewport, embeddedPopup }));
      await page.locator('.content-preview h1').click();
      const popupClosed = await page.evaluate(() => !document.getElementById('faceit-extension-loader-action-popup-host').hasAttribute('data-open'));
      if (!popupClosed) throw new Error(`${viewport.name} embedded popup did not close on outside click`);

      await page.locator('#faceit-extension-loader-button-host .mods-button').click();

      await page.locator('#faceit-extension-loader-panel-host [data-view="browse"]').click();
      await page.waitForTimeout(100);
      const addMetrics = await page.evaluate(() => {
        const root = document.getElementById('faceit-extension-loader-panel-host').shadowRoot;
        return {
          activeTab: root.querySelector('[data-view][data-active="true"]')?.dataset.view,
          inputPlaceholder: root.querySelector('.webstore-install input')?.placeholder,
          hasInstallButton: Boolean(root.querySelector('.webstore-install .button')),
          hasDetailScreen: Boolean(root.querySelector('.detail-stats')),
        };
      });
      if (addMetrics.activeTab !== 'browse' || addMetrics.inputPlaceholder !== 'Chrome Web Store link or extension ID' || !addMetrics.hasInstallButton || addMetrics.hasDetailScreen) {
        throw new Error(`${viewport.name} add view is invalid: ${JSON.stringify(addMetrics)}`);
      }
      const addScreenshot = path.join('/tmp', `faceit-mods-add-${viewport.name}.png`);
      await page.screenshot({ path: addScreenshot, fullPage: true });
      console.log(JSON.stringify({ screenshot: addScreenshot, viewport, addMetrics }));

      const testExtensionId = 'abcdefghijklmnopabcdefghijklmnop';
      await page.locator('#faceit-extension-loader-panel-host .webstore-install input').fill(testExtensionId);
      await page.locator('#faceit-extension-loader-panel-host .webstore-install .button').click();
      await page.waitForTimeout(100);
      const installRequest = await page.evaluate(() => globalThis.__previewManagerRequests.at(-1));
      if (!installRequest || installRequest.operation !== 'install-webstore' || installRequest.input !== testExtensionId) {
        throw new Error(`${viewport.name} Chrome Web Store submit failed: ${JSON.stringify(installRequest)}`);
      }

      await page.evaluate(() => {
        const listing = globalThis.__previewState.marketplace.extensions[0];
        globalThis.__previewState.pendingInstall = {
          token: 'preview-install-token',
          requestedAt: new Date().toISOString(),
          marketplaceId: listing.id,
          source: 'marketplace',
          listing: {
            ...listing,
            author: 'PeekStats',
            compatibility: 'tested',
            permissions: ['Read FACEIT match and player pages', 'Store extension preferences'],
          },
        };
        globalThis.__previewListeners['faceit-extension-loader:deep-link']({}, { marketplaceId: listing.id });
      });
      await page.waitForTimeout(250);
      const installMetrics = await page.evaluate(() => {
        const root = document.getElementById('faceit-extension-loader-panel-host').shadowRoot;
        return {
          heading: root.querySelector('.screen-title')?.textContent,
          actions: Array.from(root.querySelectorAll('.install-actions .button')).map((button) => button.textContent.trim()),
          source: root.querySelector('.install-source')?.textContent,
          hasLegacyCopy: Boolean(root.querySelector('.install-request-note, .detail-tagline')),
          tabsHidden: root.querySelector('[data-role="tabs"]')?.style.display === 'none',
        };
      });
      if (installMetrics.heading !== 'Install extension'
        || installMetrics.actions.join(',') !== 'Done'
        || installMetrics.source !== 'AddonPort catalog · Reviewed for FACEIT'
        || installMetrics.hasLegacyCopy
        || !installMetrics.tabsHidden) {
        throw new Error(`${viewport.name} install request is invalid: ${JSON.stringify(installMetrics)}`);
      }
      const installScreenshot = path.join('/tmp', `faceit-mods-install-${viewport.name}.png`);
      await page.screenshot({ path: installScreenshot, fullPage: true });
      console.log(JSON.stringify({ screenshot: installScreenshot, viewport, ...installMetrics }));

      await page.evaluate(() => {
        const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
        globalThis.__previewState.pendingInstall = {
          extensionId,
          requestedAt: new Date().toISOString(),
          source: 'webstore',
          token: 'preview-webstore-install-token',
          listing: {
            accent: '#5a5a62',
            author: 'Chrome Web Store',
            compatibility: 'unreviewed',
            extensionId,
            id: `webstore-${extensionId}`,
            installed: false,
            monogram: 'C',
            name: 'Chrome Web Store extension',
            permissions: [
              'Permissions declared by the downloaded extension package',
              'Only supported FACEIT origins are granted by AddonPort for FACEIT',
            ],
            source: 'webstore',
            tagline: `Extension id ${extensionId}`,
          },
        };
        globalThis.__previewListeners['faceit-extension-loader:deep-link']({}, { extensionId });
      });
      await page.waitForTimeout(250);
      const webstoreMetrics = await page.evaluate(() => {
        const root = document.getElementById('faceit-extension-loader-panel-host').shadowRoot;
        return {
          actions: Array.from(root.querySelectorAll('.install-actions .button')).map((button) => button.textContent.trim()),
          source: root.querySelector('.install-source')?.textContent,
          permissionCount: root.querySelectorAll('.install-permissions li').length,
          hasLegacyCopy: Boolean(root.querySelector('.install-request-note, .detail-tagline')),
        };
      });
      if (webstoreMetrics.actions.join(',') !== 'Cancel,Install'
        || webstoreMetrics.source !== 'Chrome Web Store · Not reviewed by AddonPort'
        || webstoreMetrics.permissionCount !== 2
        || webstoreMetrics.hasLegacyCopy) {
        throw new Error(`${viewport.name} direct Store install request is invalid: ${JSON.stringify(webstoreMetrics)}`);
      }
      await page.evaluate(() => {
        const root = document.getElementById('faceit-extension-loader-panel-host').shadowRoot;
        root.querySelector('[data-role="toasts"]').replaceChildren();
      });
      const webstoreScreenshot = path.join('/tmp', `faceit-mods-install-webstore-${viewport.name}.png`);
      await page.screenshot({ path: webstoreScreenshot, fullPage: true });
      console.log(JSON.stringify({ screenshot: webstoreScreenshot, viewport, ...webstoreMetrics }));
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

render().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
