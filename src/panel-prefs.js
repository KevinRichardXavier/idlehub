'use strict';

// webPreferences das telas de jogo, separadas do main.js para dar para testar com `node --test`
// (test/sandbox.test.js reprova se alguém afrouxar qualquer uma delas).

const path = require('node:path');

// Arquivo único montado por scripts/montar-preload.js a partir de src/preload-panel.js e dos plugins.
const PANEL_PRELOAD = path.join(__dirname, 'gerado', 'preload-panel.js');

function panelWebPreferences(partition) {
  return {
    partition,
    preload: PANEL_PRELOAD,
    sandbox: true, // o preload é um arquivo só (sem require de arquivos do projeto), então roda em sandbox
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false, // jogos idle precisam continuar rodando escondidos
  };
}

module.exports = { PANEL_PRELOAD, panelWebPreferences };
