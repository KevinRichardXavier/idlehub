'use strict';

const crypto = require('node:crypto');

const PANELS_PER_TAB = 4;
const SUMMARY_OPTIONS = [0, 15, 30, 60, 120, 360, 720];
const WEBHOOK_RE =
  /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;

const newId = () => crypto.randomBytes(5).toString('hex');

const isHttpUrl = (u) => {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
};

const isWebhookUrl = (u) => typeof u === 'string' && WEBHOOK_RE.test(u.trim());

const str = (v, fallback, max = 80) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback;

function makeTab(name, url = '', panelPrefix = 'Conta', offset = 0) {
  return {
    id: newId(),
    name,
    panels: Array.from({ length: PANELS_PER_TAB }, (_, i) => ({
      id: newId(),
      name: `${panelPrefix} ${offset + i + 1}`,
      url,
    })),
  };
}

function defaultPluginSettings(pluginsMeta) {
  return Object.fromEntries(
    pluginsMeta.map((p) => [
      p.id,
      { rareItems: Object.fromEntries(p.rareItems.map((i) => [String(i.id), !!i.defaultOn])) },
    ]),
  );
}

function defaultConfig(pluginsMeta) {
  const first = pluginsMeta[0];
  const tab = first ? makeTab(first.name, first.defaultUrl) : makeTab('Aba 1');
  return {
    version: 1,
    tabs: [tab],
    activeTabId: tab.id,
    feedOpen: true,
    discord: { webhookUrl: '', notifyShiny: true, notifyDrops: true, summaryMinutes: 60 },
    plugins: defaultPluginSettings(pluginsMeta),
  };
}

function normalizePanel(p, i) {
  const src = p && typeof p === 'object' ? p : {};
  const url = typeof src.url === 'string' && isHttpUrl(src.url.trim()) ? src.url.trim() : '';
  return {
    id: typeof src.id === 'string' && /^[\w-]{1,32}$/.test(src.id) ? src.id : newId(),
    name: str(src.name, `Conta ${i + 1}`, 40),
    url,
  };
}

function normalizeTab(t, i) {
  const src = t && typeof t === 'object' ? t : {};
  const panels = Array.isArray(src.panels) ? src.panels.slice(0, PANELS_PER_TAB) : [];
  while (panels.length < PANELS_PER_TAB) panels.push({});
  return {
    id: typeof src.id === 'string' && /^[\w-]{1,32}$/.test(src.id) ? src.id : newId(),
    name: str(src.name, `Aba ${i + 1}`, 40),
    panels: panels.map(normalizePanel),
  };
}

function normalizeConfig(raw, pluginsMeta) {
  const def = defaultConfig(pluginsMeta);
  if (!raw || typeof raw !== 'object') return def;

  let tabs = Array.isArray(raw.tabs) ? raw.tabs.slice(0, 30).map(normalizeTab) : def.tabs;
  if (!tabs.length) tabs = [makeTab('Aba 1')];

  // IDs de painel precisam ser únicos (cada um é uma sessão/conta separada).
  const seen = new Set();
  for (const t of tabs)
    for (const p of t.panels) {
      if (seen.has(p.id)) p.id = newId();
      seen.add(p.id);
    }

  const d = raw.discord && typeof raw.discord === 'object' ? raw.discord : {};
  const webhookUrl = isWebhookUrl(d.webhookUrl) ? d.webhookUrl.trim() : '';
  const summaryMinutes = SUMMARY_OPTIONS.includes(Number(d.summaryMinutes))
    ? Number(d.summaryMinutes)
    : def.discord.summaryMinutes;

  const plugins = def.plugins;
  const rawPlugins = raw.plugins && typeof raw.plugins === 'object' ? raw.plugins : {};
  for (const [pid, settings] of Object.entries(plugins)) {
    const items = rawPlugins[pid] && rawPlugins[pid].rareItems;
    if (items && typeof items === 'object')
      for (const key of Object.keys(settings.rareItems))
        if (typeof items[key] === 'boolean') settings.rareItems[key] = items[key];
  }

  return {
    version: 1,
    tabs,
    activeTabId: tabs.some((t) => t.id === raw.activeTabId) ? raw.activeTabId : tabs[0].id,
    feedOpen: raw.feedOpen !== false,
    discord: {
      webhookUrl,
      notifyShiny: d.notifyShiny !== false,
      notifyDrops: d.notifyDrops !== false,
      summaryMinutes,
    },
    plugins,
  };
}

module.exports = {
  PANELS_PER_TAB,
  SUMMARY_OPTIONS,
  newId,
  isHttpUrl,
  isWebhookUrl,
  makeTab,
  defaultConfig,
  normalizeConfig,
};
