'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const IPC_ACTION_POPUP_HOST = 'faceit-extension-loader:action-popup-host';
const HOST_API_NAME = '__faceitExtensionPopupHost';

function sendClose() {
  ipcRenderer.send(IPC_ACTION_POPUP_HOST, { operation: 'close' });
}

try {
  contextBridge.exposeInMainWorld(HOST_API_NAME, { close: sendClose });
} catch (_error) {
  // The popup still closes from outside clicks if the bridge cannot be exposed.
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') sendClose();
}, true);
