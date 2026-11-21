'use strict';

// Teste de fumaça: `idlehub --teste-fumaca` (ou `npm run fumaca`).
//
// Abre a janela principal com dados numa pasta temporária, sem nenhuma tela de jogo, com toda a rede
// bloqueada e o Discord desligado, confere que a interface montou (abas e telas desenhadas pelo
// preload + IPC) com a janela principal em sandbox e contextIsolation, e encerra o app pelo caminho
// normal. As telas de jogo (sandbox: false, ver main.js) não são abertas e ficam fora deste teste. Código de saída 0 = passou. O CI roda isto em Linux sob tela virtual
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

// Mesma configuração, mas sem endereço em nenhuma tela (nenhum jogo é aberto) e sem webhook.
function offlineConfig(config) {
  const out = { ...config, tabs: config.tabs.map((t) => ({ ...t, panels: t.panels.map((p) => ({ ...p, url: '' })) })) };
  if (config.discord) out.discord = { ...config.discord, webhookUrl: '' };
  return out;
}

// Para o diagnóstico, só a origem do endereço (esquema + host). O caminho pode conter segredo: a URL de um
// webhook do Discord leva o token no caminho.
function redactUrl(url) {
  try {
    const u = new URL(String(url?.url || url));
    return /^(https?|wss?):$/.test(u.protocol) ? u.origin : `${u.protocol}…`;
  } catch {
    return '(endereço inválido)';
  }
}

// Substitui a fila do Discord no teste de fumaça: nada é enviado, nem pelo botão de teste nem pelo resumo.
// Qualquer tentativa reprova o teste.
function blockedDiscordQueue(ctx) {
  return {
    send: async (url) => {
      ctx.blocked.push(`${redactUrl(url)} (envio ao Discord)`);
      return { ok: false, error: 'Discord desligado no teste de fumaça.' };
    },
  };
}

// Decide se o teste passou. Retorna { ok, problems }.
function verdict({ ui, expectedPanels, visible, blocked, sandboxOff }) {
  const problems = [];
  if (sandboxOff) problems.push('sandbox do Chromium desligado (--no-sandbox ou ELECTRON_DISABLE_SANDBOX)');
  if (!visible) problems.push('a janela principal não está visível');
  if (!ui || !(ui.tabs >= 1)) problems.push('a interface não desenhou nenhuma aba');
  if (!ui || ui.panels !== expectedPanels) problems.push(`esperava ${expectedPanels} telas na aba, achei ${ui ? ui.panels : 0}`);
  // Estado real do renderer da janela principal, lido pelo preload (não só as opções pedidas).
  if (!ui || ui.sandboxed !== true) problems.push('a janela principal não está em sandbox (process.sandboxed)');
  if (!ui || ui.contextIsolated !== true) problems.push('a janela principal não está com contextIsolation (process.contextIsolated)');
  if (!ui || ui.node !== false) problems.push('a página da janela principal enxerga require/process (nodeIntegration)');
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
    blocked.push(redactUrl(url));
    throw new Error('rede bloqueada no teste de fumaça');
  };
  const guard = (ses) =>
    ses.webRequest.onBeforeRequest({ urls: BLOCKED_URLS }, (details, cb) => {
      blocked.push(redactUrl(details.url));
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
      `({
        tabs: document.querySelectorAll('#tabs .tab').length,
        panels: document.querySelectorAll('#grid .cell').length,
        sandboxed: window.hub?.rendererInfo?.sandboxed,
        contextIsolated: window.hub?.rendererInfo?.contextIsolated,
        node: typeof require !== 'undefined' || typeof process !== 'undefined',
      })`,
    )
    .catch(() => null);
}

// Captura da janela, só como evidência extra (o CI guarda o PNG). Sob tela virtual o compositor pode
// demorar a ter o primeiro quadro, então tenta algumas vezes; se não der, avisa e segue.
async function capture(wc, file) {
  let last;
  for (let i = 0; i < 10; i++) {
    try {
      const img = await wc.capturePage();
      if (!img.isEmpty()) {
        fs.writeFileSync(file, img.toPNG());
        return 'ok';
      }
      last = 'imagem vazia';
    } catch (err) {
      last = err.message;
    }
    await sleep(500);
  }
  console.warn(`[fumaça] não consegui capturar a janela: ${last}`);
  return `falhou: ${last}`;
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
      if (ui && ui.tabs >= 1 && ui.panels === expectedPanels && ui.sandboxed !== undefined) break;
      await sleep(POLL_MS);
    }

    const shot = process.env.IDLEHUB_FUMACA_CAPTURA;
    const captura = shot ? await capture(wc, shot) : undefined;

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
    report(true, { ui, captura, plataforma: `${process.platform}-${process.arch}`, electron: process.versions.electron });
    app.quit(); // caminho normal de saída (before-quit salva os arquivos); código 0
  } catch (err) {
    clearTimeout(watchdog);
    fail([`erro: ${err.message}`]);
  }
}

module.exports = { FLAG, isSmokeTest, sandboxDisabled, offlineConfig, redactUrl, blockedDiscordQueue, verdict, setup, run };
