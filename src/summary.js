'use strict';

const INACTIVE_MS = 5 * 60 * 1000;

const clean = (s) => String(s ?? '').replace(/[*_~`|>]/g, '').slice(0, 100);

function minutesAgo(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? 'agora' : `há ${m} min`;
}

// Acumula shinies e drops por conta (painel) entre um resumo e outro.
class SummaryTracker {
  constructor(now = Date.now()) {
    this.reset(now);
  }

  reset(now = Date.now()) {
    this.since = now;
    this.byPanel = new Map();
  }

  entry(panelId) {
    let e = this.byPanel.get(panelId);
    if (!e) {
      e = { shinies: [], drops: new Map() };
      this.byPanel.set(panelId, e);
    }
    return e;
  }

  record(evt) {
    const e = this.entry(evt.panelId);
    if (evt.type === 'shiny') e.shinies.push(evt.name);
    else if (evt.type === 'drop') e.drops.set(evt.item, (e.drops.get(evt.item) || 0) + evt.qty);
  }

  // accounts: [{ panelId, panelName, nick, tabName, tracked, lastSeen }]
  build(accounts, now = Date.now()) {
    const minutes = Math.max(1, Math.round((now - this.since) / 60000));
    let shinyTotal = 0;
    let dropTotal = 0;
    const fields = [];

    for (const a of accounts) {
      const e = this.byPanel.get(a.panelId) || { shinies: [], drops: new Map() };
      if (!a.tracked && !e.shinies.length && !e.drops.size) continue;
      shinyTotal += e.shinies.length;
      const lines = [];
      if (e.shinies.length) {
        const names = e.shinies.slice(0, 8).map(clean).join(', ');
        const more = e.shinies.length > 8 ? ` +${e.shinies.length - 8}` : '';
        lines.push(`✨ Shinies: **${e.shinies.length}** (${names}${more})`);
      }
      if (e.drops.size) {
        const list = [...e.drops].map(([item, qty]) => {
          dropTotal += qty;
          return `${clean(item)} ×${qty}`;
        });
        lines.push(`🎁 Drops: ${list.join(', ')}`);
      }
      if (!lines.length) lines.push('Nada raro neste período');
      if (a.tracked) {
        const idle = !a.lastSeen || now - a.lastSeen > INACTIVE_MS;
        lines.push(
          idle
            ? `🔴 sem atividade ${a.lastSeen ? minutesAgo(now - a.lastSeen) : '(não conectou)'}`
            : '🟢 ativa',
        );
      }
      const label = a.nick ? `${clean(a.panelName)} (${clean(a.nick)})` : clean(a.panelName);
      fields.push({ name: `${clean(a.tabName)} › ${label}`.slice(0, 256), value: lines.join('\n').slice(0, 1024) });
    }

    if (!fields.length) return null;
    return {
      ts: now,
      minutes,
      description: `Total: **${shinyTotal}** shiny(s) · **${dropTotal}** drop(s) raro(s)`,
      fields,
    };
  }
}

module.exports = { SummaryTracker, INACTIVE_MS };
