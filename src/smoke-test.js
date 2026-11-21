'use strict';

// Teste de fumaça: `idlehub --teste-fumaca` (ou `npm run fumaca`).
//
// Abre a janela principal com dados numa pasta temporária, com toda a rede bloqueada e o Discord
// desligado, e confere que a interface montou (abas e telas desenhadas pelo preload + IPC) com a janela
// principal em sandbox e contextIsolation. Abre também UMA tela de jogo, apontada para uma página local
// de teste (esquema idlehub-fumaca://, que só existe neste modo; nenhum jogo, nenhuma rede), e confere
// que ela roda em sandbox com contextIsolation, que o preload montado carregou e resolveu o plugin, que o
// observador entrou na página e que um evento da página chegou ao processo principal. Depois encerra o
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
// Página local da tela de jogo de teste. O host é o de um jogo com plugin para o preload resolver o plugin
// pelo endereço, como faz com o jogo de verdade; o conteúdo vem do próprio app, nunca da rede.
const TEST_SCHEME = 'idlehub-fumaca';
const TEST_NICK = 'conta-de-teste';

const testPageUrl = (plugin) => `${TEST_SCHEME}://${plugin.hosts[0]}/tela-de-teste`;

// A página manda à própria janela uma mensagem no formato do observador (uma conta "logada"); o preload a
// repassa ao processo principal, que guarda o apelido da tela. Prova o caminho página → preload → IPC.
function testPageHtml(plugin) {
  const msg = JSON.stringify({ __idleHub: true, pluginId: plugin.id, events: [{ type: 'account', nick: TEST_NICK }] });
  return `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><title>IdleHub: tela de teste</title>
<body style="font:16px sans-serif;background:#123;color:#fff;padding:16px">
<p>Tela de jogo de teste do IdleHub (teste de fumaça). Nenhum jogo é aberto.</p>
<script>window.postMessage(${msg}, location.origin);</script>
</body></html>`;
}

const isSmokeTest = (argv = process.argv) => argv.includes(FLAG);

// O teste não vale com o sandbox do Chromium desligado.
function sandboxDisabled(argv = process.argv, env = process.env) {
  return argv.includes('--no-sandbox') || !!env.ELECTRON_DISABLE_SANDBOX;
}

// Mesma configuração, sem webhook e sem endereço de jogo: só a primeira tela da primeira aba recebe
// `testUrl` (a página local de teste); as demais ficam vazias.
function offlineConfig(config, testUrl = '') {
  const out = {
    ...config,
    tabs: config.tabs.map((t, ti) => ({ ...t, panels: t.panels.map((p, pi) => ({ ...p, url: ti === 0 && pi === 0 ? testUrl : '' })) })),
  };
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

// Problemas da tela de jogo de teste. `panel` = { ready, page, nick } lidos do app:
//   ready: o que o preload da tela informou ({ pluginId, sandboxed, contextIsolated }), ou null;
//   page:  o que se vê no mundo da página ({ hook, node }), ou null;
//   nick:  apelido que chegou ao processo principal pelo IPC da tela.
function panelProblems(panel, expectedPlugin) {
  if (!panel) return ['a tela de jogo de teste não abriu'];
  const { ready, page, nick } = panel;
  const problems = [];
  if (!ready) problems.push('o preload da tela de jogo não rodou (src/gerado/preload-panel.js)');
  else {
    if (ready.sandboxed !== true) problems.push('a tela de jogo não está em sandbox (process.sandboxed)');
    if (ready.contextIsolated !== true) problems.push('a tela de jogo não está com contextIsolation (process.contextIsolated)');
    if (ready.pluginId !== expectedPlugin) problems.push(`o preload da tela de jogo resolveu o plugin ${ready.pluginId}, esperava ${expectedPlugin}`);
  }
  if (!page || page.hook !== true) problems.push('o observador do plugin não entrou na página da tela de jogo');
  if (!page || page.node !== false) problems.push('a página da tela de jogo enxerga require/process (nodeIntegration)');
  if (nick !== TEST_NICK) problems.push('o evento da página de teste não chegou ao processo principal (IPC da tela de jogo)');
  return problems;
}

// Decide se o teste passou. Retorna { ok, problems }.
function verdict({ ui, expectedPanels, visible, blocked, sandboxOff, panel, expectedPlugin }) {
  const problems = [];
  if (sandboxOff) problems.push('sandbox do Chromium desligado (--no-sandbox ou ELECTRON_DISABLE_SANDBOX)');
  if (!visible) problems.push('a janela principal não está visível');
  if (!ui || !(ui.tabs >= 1)) problems.push('a interface não desenhou nenhuma aba');
  if (!ui || ui.panels !== expectedPanels) problems.push(`esperava ${expectedPanels} telas na aba, achei ${ui ? ui.panels : 0}`);
  // Estado real do renderer da janela principal, lido pelo preload (não só as opções pedidas).
  if (!ui || ui.sandboxed !== true) problems.push('a janela principal não está em sandbox (process.sandboxed)');
  if (!ui || ui.contextIsolated !== true) problems.push('a janela principal não está com contextIsolation (process.contextIsolated)');
  if (!ui || ui.node !== false) problems.push('a página da janela principal enxerga require/process (nodeIntegration)');
  problems.push(...panelProblems(panel, expectedPlugin));
  if (blocked.length) problems.push(`tentou acessar a rede: ${blocked.slice(0, 5).join(', ')}`);
  return { ok: problems.length === 0, problems };
}

// ---------- parte que usa o Electron ----------

// Chamar antes de app.whenReady() e de requestSingleInstanceLock(): dados temporários (não toca nos
// dados reais nem conflita com um IdleHub aberto), rede bloqueada no processo principal e nas sessões e a
// página local da tela de jogo de teste. `plugin` é o jogo cujo plugin a tela de teste deve resolver.
function setup(app, plugin) {
  const { protocol } = require('electron');
  // Esquema "standard" para a página ter host (o preload resolve o plugin pelo host) e origem própria.
  protocol.registerSchemesAsPrivileged([{ scheme: TEST_SCHEME, privileges: { standard: true, secure: true } }]);
  const html = testPageHtml(plugin);
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
  app.on('session-created', (ses) => {
    guard(ses);
    try {
      ses.protocol.handle(TEST_SCHEME, () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    } catch (err) {
      // Sem a página a tela de teste não carrega e o veredito reprova; aqui só registra o motivo.
      console.warn(`[fumaça] não consegui registrar ${TEST_SCHEME}:// numa sessão: ${err.message}`);
    }
  });
  app.whenReady().then(() => guard(require('electron').session.defaultSession));

  app.on('will-quit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, blocked, testUrl: testPageUrl(plugin), pluginId: plugin.id };
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

// Lê a tela de jogo de teste: o que o app guardou (preload e IPC) e o mundo da página.
async function readPanel(testPanel) {
  const p = testPanel();
  if (!p) return null;
  const page =
    p.wc.isDestroyed() || p.wc.isLoading()
      ? null
      : await p.wc
          .executeJavaScript(
            `({ hook: window.__idleHubHook === true, node: typeof require !== 'undefined' || typeof process !== 'undefined' })`,
          )
          .catch(() => null);
  return { ready: p.ready, page, nick: p.nick };
}

const panelDone = (panel, expectedPlugin) => panelProblems(panel, expectedPlugin).length === 0;

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

async function run({ app, win, ctx, expectedPanels, testPanel }) {
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
    let panel = null;
    while (Date.now() - started < TIMEOUT_MS - 5000) {
      ui = await readUi(wc);
      panel = await readPanel(testPanel);
      const uiDone = ui && ui.tabs >= 1 && ui.panels === expectedPanels && ui.sandboxed !== undefined;
      if (uiDone && panelDone(panel, ctx.pluginId)) break;
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
      panel,
      expectedPlugin: ctx.pluginId,
    });
    clearTimeout(watchdog);
    if (!res.ok) return fail(res.problems);
    done = true;
    report(true, { ui, tela: panel, captura, plataforma: `${process.platform}-${process.arch}`, electron: process.versions.electron });
    app.quit(); // caminho normal de saída (before-quit salva os arquivos); código 0
  } catch (err) {
    clearTimeout(watchdog);
    fail([`erro: ${err.message}`]);
  }
}

module.exports = {
  FLAG,
  TEST_SCHEME,
  TEST_NICK,
  isSmokeTest,
  sandboxDisabled,
  testPageUrl,
  testPageHtml,
  offlineConfig,
  redactUrl,
  blockedDiscordQueue,
  panelProblems,
  verdict,
  setup,
  run,
};
