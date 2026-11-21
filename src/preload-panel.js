'use strict';

// Preload das telas de jogo. Se a página pertence a um jogo com plugin,
// instala o observador de WebSocket no mundo da página e encaminha os eventos
// detectados ao processo principal.
//
// As telas rodam com sandbox: true, então este arquivo não é carregado direto:
// scripts/montar-preload.js junta ele, os plugins e o observador em
// src/gerado/preload-panel.js. Aqui só dá para carregar "electron" e arquivos
// de src/ por caminho relativo fixo.
const { ipcRenderer, webFrame } = require('electron');
const { pluginForUrl } = require('./plugins');
const { installHook } = require('./plugins/hook');

const plugin = pluginForUrl(window.location.href);

// Estado real deste renderer, lido aqui no mundo isolado (a página não alcança).
// O processo principal usa no log de diagnóstico e o teste de fumaça exige sandbox.
ipcRenderer.send('panel:ready', {
  pluginId: plugin ? plugin.id : null,
  sandboxed: process.sandboxed === true,
  contextIsolated: process.contextIsolated === true,
});

if (plugin) {
  const code = `(${installHook.toString()})(${plugin.detect.toString()}, ${JSON.stringify(
    plugin.special,
  )}, ${JSON.stringify(plugin.id)});`;
  webFrame.executeJavaScript(code).catch(() => {});

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__idleHub !== true) return;
    if (ev.data.pluginId !== plugin.id || !Array.isArray(ev.data.events)) return;
    ipcRenderer.send('panel:events', { pluginId: plugin.id, events: ev.data.events.slice(0, 50) });
  });
}
