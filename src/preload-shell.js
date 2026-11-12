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
  clearEvents: () => ipcRenderer.invoke('events:clear'),
  onEvent: on('events:new'),
  onEventUpdate: on('events:update'),
  onRuntime: on('runtime:update'),
  version: () => ipcRenderer.invoke('app:version'),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdateReady: on('update:ready'),
});
