'use strict';

// Teste de fumaça: `idlehub --teste-fumaca` (ou `npm run fumaca`).
//
// Abre a janela principal com dados numa pasta temporária, sem nenhuma tela de jogo e com toda a rede
// bloqueada, confere que a interface montou (abas e telas desenhadas pelo preload + IPC) e encerra o
// app pelo caminho normal. Código de saída 0 = passou. O CI roda isto em Linux sob tela virtual
// (xvfb-run) com o sandbox do Chromium ligado; é a prova de que a janela abre.
//
// As funções puras (sem Electron) ficam no topo para dar para testar com `node --test`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLAG = '--teste-fumaca';
const TIMEOUT_MS = 60000;
const POLL_MS = 250;
const RESULT_PREFIX = 'IDLEHUB_FUMACA';
const BLOCKED_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];

const isSmokeTest = (argv = process.argv) => argv.includes(FLAG);

// O teste não vale com o sandbox do Chromium desligado.
function sandboxDisabled(argv = process.argv, env = process.env) {
  return argv.includes('--no-sandbox') || !!env.ELECTRON_DISABLE_SANDBOX;
}

// Mesma configuração, mas sem endereço em nenhuma tela: nenhum jogo é aberto.
function offlineConfig(config) {
  return { ...config, tabs: config.tabs.map((t) => ({ ...t, panels: t.panels.map((p) => ({ ...p, url: '' })) })) };
}

// Decide se o teste passou. Retorna { ok, problems }.
function verdict({ ui, expectedPanels, visible, blocked, sandboxOff }) {
  const problems = [];
  if (sandboxOff) problems.push('sandbox do Chromium desligado (--no-sandbox ou ELECTRON_DISABLE_SANDBOX)');
  if (!visible) problems.push('a janela principal não está visível');
  if (!ui || !(ui.tabs >= 1)) problems.push('a interface não desenhou nenhuma aba');
  if (!ui || ui.panels !== expectedPanels) problems.push(`esperava ${expectedPanels} telas na aba, achei ${ui ? ui.panels : 0}`);
  if (blocked.length) problems.push(`tentou acessar a rede: ${blocked.slice(0, 5).join(', ')}`);
  return { ok: problems.length === 0, problems };
}

// ---------- parte que usa o Electron ----------

// Chamar antes de app.whenReady() e de requestSingleInstanceLock(): dados temporários (não toca nos
// dados reais nem conflita com um IdleHub aberto) e rede bloqueada no processo principal e nas sessões.
function setup(app) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-fumaca-'));
  app.setPath('userData', dir);
  app.setPath('sessionData', dir);

  const blocked = [];
  globalThis.fetch = async (url) => {
    blocked.push(String(url?.url || url));
    throw new Error('rede bloqueada no teste de fumaça');
  };
  const guard = (ses) =>
    ses.webRequest.onBeforeRequest({ urls: BLOCKED_URLS }, (details, cb) => {
      blocked.push(details.url);
      cb({ cancel: true });
    });
  app.on('session-created', guard);
  app.whenReady().then(() => guard(require('electron').session.defaultSession));

  app.on('will-quit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, blocked };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readUi(wc) {
  return wc
    .executeJavaScript(
      `({ tabs: document.querySelectorAll('#tabs .tab').length, panels: document.querySelectorAll('#grid .cell').length })`,
    )
    .catch(() => null);
}

async function run({ app, win, ctx, expectedPanels }) {
  const started = Date.now();
  const report = (ok, extra) => {
    const line = `${RESULT_PREFIX}_${ok ? 'OK' : 'FALHOU'} ${JSON.stringify({ ms: Date.now() - started, ...extra })}`;
    (ok ? console.log : console.error)(line);
  };
  let done = false;
  const fail = (problems) => {
    if (done) return;
    done = true;
    report(false, { problems });
    app.exit(1);
  };

  const watchdog = setTimeout(() => fail([`tempo esgotado (${TIMEOUT_MS / 1000} s)`]), TIMEOUT_MS);
  win.webContents.on('render-process-gone', (_e, d) => fail([`a interface caiu: ${d.reason}`]));
  // Depois do veredito, a saída é a do app; nada mais muda o resultado.

  try {
    const wc = win.webContents;
    if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));

    let ui = null;
    while (Date.now() - started < TIMEOUT_MS - 5000) {
      ui = await readUi(wc);
      if (ui && ui.tabs >= 1 && ui.panels === expectedPanels) break;
      await sleep(POLL_MS);
    }

    const shot = process.env.IDLEHUB_FUMACA_CAPTURA;
    if (shot) {
      const img = await wc.capturePage();
      fs.writeFileSync(shot, img.toPNG());
    }

    const res = verdict({
      ui,
      expectedPanels,
      visible: win.isVisible(),
      blocked: ctx.blocked,
      sandboxOff: sandboxDisabled() || app.commandLine.hasSwitch('no-sandbox'),
    });
    clearTimeout(watchdog);
    if (!res.ok) return fail(res.problems);
    done = true;
    report(true, { ui, plataforma: `${process.platform}-${process.arch}`, electron: process.versions.electron });
    app.quit(); // caminho normal de saída (before-quit salva os arquivos); código 0
  } catch (err) {
    clearTimeout(watchdog);
    fail([`erro: ${err.message}`]);
  }
}

module.exports = { FLAG, isSmokeTest, sandboxDisabled, offlineConfig, verdict, setup, run };
