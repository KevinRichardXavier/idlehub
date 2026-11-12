'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell } = require('electron');
const path = require('node:path');
const plugins = require('./plugins');
const { JsonFile } = require('./jsonfile');
const { normalizeConfig, isWebhookUrl, newId } = require('./config');
const discord = require('./discord');
const { SummaryTracker } = require('./summary');
const { startUpdater } = require('./updater');
const extensions = require('./extensions');

const MAX_EVENTS = 300;

let win = null;
let config = null;
let configFile = null;
let eventsFile = null;
let events = [];
const views = new Map(); // panelId -> { view, url }
const runtime = new Map(); // panelId -> { nick, lastSeen }
const tracker = new SummaryTracker();
const queue = new discord.DiscordQueue();
let lastSummaryAt = Date.now();
let extStore = null;
const extReady = new Map(); // id da Web Store -> Promise<{ version, path } | null>
const extStatus = new Map(); // id da Web Store -> { version, updatedTo, error }
const extLoaded = new WeakMap(); // session -> Map(id da Web Store -> id carregado no Electron)

// ---------- helpers ----------

function panelsWithTab() {
  return config.tabs.flatMap((t) => t.panels.map((p) => ({ ...p, tabId: t.id, tabName: t.name })));
}

function findPanel(panelId) {
  return panelsWithTab().find((p) => p.id === panelId) || null;
}

function panelIdForSender(sender) {
  for (const [id, v] of views) if (v.view.webContents === sender) return id;
  return null;
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function sendRuntime(panelId) {
  send('runtime:update', { panelId, ...runtime.get(panelId) });
}

// O Electron se identifica como "Electron/x.y" no user agent; alguns sites
// (login Google, Cloudflare) recusam esse UA. Removemos só esse sufixo.
function cleanUserAgent(ua) {
  return ua.replace(/\s(?:Electron|idlehub|IdleHub)\/\S+/g, '');
}

// ---------- extensões do Chrome ----------

function prepareExtensions() {
  extStore = new extensions.ExtensionStore(path.join(app.getPath('userData'), 'extensions'), {
    chromeVersion: process.versions.chrome,
  });
  for (const ext of extensions.CATALOG) {
    const p = extStore
      .prepare(ext.id, (v) => {
        extStatus.set(ext.id, { ...extStatus.get(ext.id), updatedTo: v.version });
        send('extensions:update', extensionsState());
      })
      .then((v) => {
        extStatus.set(ext.id, v ? { version: v.version } : { error: 'Não foi possível baixar a extensão.' });
        send('extensions:update', extensionsState());
        return v;
      });
    extReady.set(ext.id, p);
  }
}

function extensionsState() {
  return extensions.catalogMeta().map((e) => ({ ...e, ...(extStatus.get(e.id) || { pending: true }) }));
}

// Deixa a sessão com exatamente as extensões ligadas na configuração. Retorna true se mudou algo.
async function syncSessionExtensions(ses) {
  const api = ses.extensions || ses;
  let loaded = extLoaded.get(ses);
  if (!loaded) extLoaded.set(ses, (loaded = new Map()));
  let changed = false;
  for (const ext of extensions.CATALOG) {
    const want = !!config.extensions[ext.id];
    if (want && !loaded.has(ext.id)) {
      const info = await extReady.get(ext.id);
      if (!info || !config.extensions[ext.id] || loaded.has(ext.id)) continue;
      loaded.set(ext.id, null); // reserva: evita carregar duas vezes se outra chamada correr junto
      try {
        const e = await api.loadExtension(info.path);
        loaded.set(ext.id, e.id);
        changed = true;
      } catch (err) {
        loaded.delete(ext.id);
        console.error(`[extensões] falha ao carregar ${ext.name}: ${err.message}`);
        extStatus.set(ext.id, { ...extStatus.get(ext.id), error: `Falha ao carregar: ${err.message}` });
      }
    } else if (!want && loaded.get(ext.id)) {
      try {
        api.removeExtension(loaded.get(ext.id));
      } catch {
        /* já removida */
      }
      loaded.delete(ext.id);
      changed = true;
    }
  }
  return changed;
}

// Liga/desliga extensões nos painéis abertos e recarrega só os que mudaram.
async function applyExtensionSettings() {
  for (const v of views.values()) {
    const wc = v.view.webContents;
    if (wc.isDestroyed()) continue;
    if (await syncSessionExtensions(wc.session)) wc.reload();
  }
}

// ---------- telas de jogo ----------

function createView(panel) {
  const partition = `persist:panel-${panel.id}`;
  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'preload-panel.js'),
      sandbox: false, // o preload precisa de require() para carregar os plugins
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // jogos idle precisam continuar rodando escondidos
    },
  });
  const wc = view.webContents;
  wc.session.setUserAgent(cleanUserAgent(wc.session.getUserAgent()));

  wc.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) return { action: 'deny' };
    // Popups (ex.: login com Discord/Google) usam a mesma sessão da conta.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: win,
        width: 520,
        height: 760,
        autoHideMenuBar: true,
        webPreferences: { partition, sandbox: true, contextIsolation: true },
      },
    };
  });

  wc.on('render-process-gone', () => {
    const r = runtime.get(panel.id) || {};
    runtime.set(panel.id, { ...r, crashed: true });
    sendRuntime(panel.id);
  });
  wc.on('did-start-loading', () => {
    const r = runtime.get(panel.id);
    if (r?.crashed) {
      runtime.set(panel.id, { ...r, crashed: false });
      sendRuntime(panel.id);
    }
  });

  if (process.env.IDLEHUB_DEBUG) {
    wc.on('did-finish-load', async () => {
      const hooked = await wc.executeJavaScript('!!window.__idleHubHook').catch(() => 'erro');
      const hunt = await wc.executeJavaScript('!!window.__pokeidleHunt').catch(() => 'erro');
      console.log(`[debug] painel ${panel.name} carregou ${wc.getURL()} | observador: ${hooked} | Hunt for PokeIdle: ${hunt}`);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame) console.log(`[debug] painel ${panel.name} falhou ${code} ${desc} ${url}`);
    });
  }

  view.setVisible(false);
  win.contentView.addChildView(view);
  // A extensão precisa estar carregada antes da página, para os content scripts entrarem já no início.
  syncSessionExtensions(wc.session)
    .catch(() => {})
    .finally(() => {
      if (!wc.isDestroyed()) wc.loadURL(panel.url).catch(() => {});
    });
  return view;
}

function destroyView(panelId) {
  const v = views.get(panelId);
  if (!v) return;
  try {
    win.contentView.removeChildView(v.view);
  } catch {
    /* já removida */
  }
  try {
    v.view.webContents.close();
  } catch {
    /* já fechada */
  }
  views.delete(panelId);
  runtime.delete(panelId);
}

// Deixa as telas abertas exatamente iguais ao que está na configuração.
function syncViews() {
  const wanted = new Map(panelsWithTab().filter((p) => p.url).map((p) => [p.id, p]));
  for (const id of [...views.keys()]) if (!wanted.has(id)) destroyView(id);
  for (const p of wanted.values()) {
    const v = views.get(p.id);
    if (!v) {
      views.set(p.id, { view: createView(p), url: p.url });
    } else if (v.url !== p.url) {
      v.url = p.url;
      runtime.delete(p.id);
      v.view.webContents.loadURL(p.url).catch(() => {});
    }
  }
}

function applyLayout(rects) {
  for (const [id, v] of views) {
    const r = rects && rects[id];
    if (r && r.width > 0 && r.height > 0) {
      v.view.setBounds({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      v.view.setVisible(true);
    } else {
      v.view.setVisible(false);
    }
  }
}

// ---------- eventos ----------

function saveEvents() {
  eventsFile.write(events);
}

function updateEvent(id, patch) {
  const evt = events.find((e) => e.id === id);
  if (!evt) return;
  Object.assign(evt, patch);
  saveEvents();
  send('events:update', { id, ...patch });
}

function notifyDiscord(evt, plugin) {
  const d = config.discord;
  const wants = (evt.type === 'shiny' && d.notifyShiny) || (evt.type === 'drop' && d.notifyDrops);
  if (!d.webhookUrl || !wants) return 'off';
  const payload =
    evt.type === 'shiny' ? discord.shinyPayload(evt, plugin.name) : discord.dropPayload(evt, plugin.name);
  queue.send(d.webhookUrl, payload).then((res) => {
    updateEvent(evt.id, { discord: res.ok ? 'ok' : 'erro', discordError: res.ok ? undefined : res.error });
  });
  return 'pendente';
}

function handlePanelEvents(sender, data) {
  const panelId = panelIdForSender(sender);
  const panel = panelId && findPanel(panelId);
  const plugin = data && plugins.pluginById(data.pluginId);
  if (process.env.IDLEHUB_DEBUG) console.log(`[debug] eventos de ${panel?.name}:`, JSON.stringify(data?.events));
  if (!panel || !plugin || !Array.isArray(data.events)) return;

  const r = runtime.get(panelId) || {};
  r.lastSeen = Date.now();
  r.pluginId = plugin.id;
  runtime.set(panelId, r);
  let runtimeChanged = true;

  for (const raw of data.events) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.type === 'account' && typeof raw.nick === 'string') {
      r.nick = raw.nick.slice(0, 40);
      runtimeChanged = true;
      continue;
    }
    if (raw.type !== 'shiny' && raw.type !== 'drop') continue;
    if (raw.type === 'drop') {
      const enabled = config.plugins[plugin.id]?.rareItems?.[String(raw.itemId)];
      if (!enabled) continue;
    }

    const evt = {
      ...raw,
      id: newId(),
      ts: Date.now(),
      pluginId: plugin.id,
      tabId: panel.tabId,
      tabName: panel.tabName,
      panelId,
      panelName: panel.name,
      nick: r.nick || null,
    };
    evt.discord = notifyDiscord(evt, plugin);
    events.unshift(evt);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    tracker.record(evt);
    saveEvents();
    send('events:new', evt);
  }
  if (runtimeChanged) sendRuntime(panelId);
}

// ---------- resumo ----------

function buildSummary(now = Date.now()) {
  const accounts = panelsWithTab()
    .filter((p) => p.url)
    .map((p) => {
      const r = runtime.get(p.id) || {};
      return {
        panelId: p.id,
        panelName: p.name,
        tabName: p.tabName,
        nick: r.nick || null,
        lastSeen: r.lastSeen || null,
        tracked: !!plugins.pluginForUrl(p.url),
      };
    });
  return tracker.build(accounts, now);
}

async function sendSummary() {
  const url = config.discord.webhookUrl;
  if (!url) return { ok: false, error: 'Configure o webhook do Discord primeiro.' };
  const now = Date.now();
  const summary = buildSummary(now);
  lastSummaryAt = now;
  if (!summary) return { ok: false, error: 'Nenhuma conta de jogo com plugin aberta.' };
  const res = await queue.send(url, discord.summaryPayload(summary));
  if (res.ok) tracker.reset(now);
  return res;
}

function checkSummaryTimer() {
  const mins = config.discord.summaryMinutes;
  if (!mins || !config.discord.webhookUrl) return;
  if (Date.now() - lastSummaryAt >= mins * 60000) sendSummary().catch(() => {});
}

// ---------- janela e IPC ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1020',
    title: 'IdleHub',
    webPreferences: {
      preload: path.join(__dirname, 'preload-shell.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  if (process.env.IDLEHUB_DEBUG) {
    win.webContents.on('console-message', (e) => {
      console.log(`[ui:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`);
    });
  }
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.webContents.once('did-finish-load', syncViews);
  win.on('closed', () => {
    win = null;
    views.clear();
  });
}

function registerIpc() {
  ipcMain.handle('app:getState', () => ({
    config,
    events,
    runtime: Object.fromEntries(runtime),
    plugins: plugins.meta(),
    extensions: extensionsState(),
  }));

  ipcMain.handle('config:set', (_e, next) => {
    const prevExt = JSON.stringify(config.extensions);
    config = normalizeConfig(next, plugins.meta());
    configFile.write(config);
    syncViews();
    if (JSON.stringify(config.extensions) !== prevExt) applyExtensionSettings().catch(() => {});
    return config;
  });

  ipcMain.on('layout:set', (_e, rects) => applyLayout(rects));

  ipcMain.on('panel:reload', (_e, panelId) => {
    const v = views.get(panelId);
    if (!v) return;
    const wc = v.view.webContents;
    if (wc.isCrashed()) wc.loadURL(v.url).catch(() => {});
    else wc.reload();
  });

  ipcMain.handle('discord:test', async (_e, url) => {
    if (!isWebhookUrl(url)) return { ok: false, error: 'URL de webhook inválida.' };
    return queue.send(url.trim(), discord.testPayload());
  });

  ipcMain.handle('discord:summaryNow', () => sendSummary());

  ipcMain.handle('events:clear', () => {
    events = [];
    saveEvents();
    return true;
  });

  ipcMain.on('panel:events', (e, data) => handlePanelEvents(e.sender, data));

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.on('update:install', () => {
    configFile.flush();
    eventsFile.flush();
    updater.install();
  });
}

let updater = { install: () => {} };

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    const dir = app.getPath('userData');
    configFile = new JsonFile(path.join(dir, 'config.json'));
    eventsFile = new JsonFile(path.join(dir, 'events.json'), 1500);
    config = normalizeConfig(configFile.read(null), plugins.meta());
    configFile.writeNow(config);
    const stored = eventsFile.read([]);
    events = Array.isArray(stored) ? stored.slice(0, MAX_EVENTS) : [];

    prepareExtensions();
    registerIpc();
    createWindow();
    setInterval(checkSummaryTimer, 30000);
    updater = startUpdater(send);
  });

  app.on('before-quit', () => {
    configFile?.flush();
    eventsFile?.flush();
  });

  app.on('window-all-closed', () => app.quit());
}
