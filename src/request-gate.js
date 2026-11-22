'use strict';

// Um único `webRequest.onBeforeRequest` por sessão. O Electron guarda um só ouvinte por evento e por sessão
// (registrar outro substitui o anterior), então quem precisa barrar requisições de uma sessão registra um
// bloqueador aqui, com uma chave própria, em vez de chamar `ses.webRequest.onBeforeRequest` direto. Hoje são
// dois: o bloqueio do proxy (src/proxy-manager.js) e a rede fechada do teste de fumaça (src/smoke-test.js).
//
// Vale para toda requisição de rede da sessão, de qualquer página que a use: telas, popups de login e páginas
// de fundo de extensão. Não depende do `setProxy`, então segura a sessão mesmo quando o Chromium recusa a
// regra de proxy.

const NETWORK_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

const gates = new WeakMap();

function gateOf(ses) {
  let blockers = gates.get(ses);
  if (!blockers) {
    blockers = new Map();
    gates.set(ses, blockers);
    ses.webRequest.onBeforeRequest({ urls: NETWORK_URLS }, (details, cb) => {
      for (const blocks of blockers.values()) {
        if (blocks(details)) return cb({ cancel: true });
      }
      cb({});
    });
  }
  return blockers;
}

// `blocks(details)` devolve true para cancelar a requisição.
function setBlocker(ses, key, blocks) {
  gateOf(ses).set(key, blocks);
}

function removeBlocker(ses, key) {
  gates.get(ses)?.delete(key);
}

function hasBlocker(ses, key) {
  return !!gates.get(ses)?.has(key);
}

module.exports = { NETWORK_URLS, setBlocker, removeBlocker, hasBlocker };
