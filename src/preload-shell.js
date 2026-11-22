'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('hub', {
  getState: () => ipcRenderer.invoke('app:getState'),
  setConfig: (config) => ipcRenderer.invoke('config:set', config),
  setLayout: (rects) => ipcRenderer.send('layout:set', rects),
  reloadPanel: (panelId) => ipcRenderer.send('panel:reload', panelId),
  testDiscord: (url) => ipcRenderer.invoke('discord:test', url),
  summaryNow: () => ipcRenderer.invoke('discord:summaryNow'),
  // Proxy: a senha vai para o processo principal e nunca volta (proxyInfo só diz se existe senha salva).
  saveProxy: (input) => ipcRenderer.invoke('proxy:save', input),
  testProxy: (input) => ipcRenderer.invoke('proxy:test', input),
  proxyInfo: () => ipcRenderer.invoke('proxy:info'),
  onProxy: on('proxy:update'),
  clearEvents: () => ipcRenderer.invoke('events:clear'),
  onEvent: on('events:new'),
  onEventUpdate: on('events:update'),
  onRuntime: on('runtime:update'),
  version: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateReady: on('update:ready'),
  onExtensions: on('extensions:update'),
  // Estado real deste renderer; o teste de fumaça exige os dois true.
  rendererInfo: Object.freeze({ sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true }),
});
