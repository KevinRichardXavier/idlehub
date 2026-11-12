'use strict';

// Registro de plugins por jogo. Para suportar um jogo novo, crie um arquivo
// como pokeidle.js (id, name, hosts, rareItems, special, detect) e adicione-o
// à lista abaixo.
const PLUGINS = [require('./pokeidle')];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pluginForUrl(url) {
  const host = hostOf(url);
  if (!host) return null;
  return PLUGINS.find((p) => p.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
}

function pluginById(id) {
  return PLUGINS.find((p) => p.id === id) || null;
}

function meta() {
  return PLUGINS.map((p) => ({
    id: p.id,
    name: p.name,
    hosts: p.hosts,
    defaultUrl: p.defaultUrl,
    accountLimit: p.accountLimit ?? null,
    rareItems: p.rareItems,
  }));
}

module.exports = { PLUGINS, pluginForUrl, pluginById, meta, hostOf };
