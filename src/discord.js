'use strict';

const COLORS = { shiny: 0xf5c542, drop: 0x38bdf8, summary: 0x8b5cf6, test: 0x22c55e };
const USERNAME = 'IdleHub';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? '').replace(/[*_~`|>]/g, '').slice(0, 100);

function accountLabel(evt) {
  return evt.nick ? `${clean(evt.panelName)} (${clean(evt.nick)})` : clean(evt.panelName);
}

function shinyPayload(evt, pluginName) {
  const parts = [`**${clean(evt.name)}**`];
  if (evt.level != null) parts.push(`Nv ${evt.level}`);
  if (evt.quality != null && evt.quality !== '') parts.push(`qualidade ${clean(evt.quality)}`);
  if (evt.source === 'ovo') parts.push('chocado de ovo');
  return {
    username: USERNAME,
    embeds: [
      {
        title: '✨ Shiny capturado!',
        description: parts.join(' · '),
        color: COLORS.shiny,
        footer: { text: `${accountLabel(evt)} · ${pluginName}` },
        timestamp: new Date(evt.ts).toISOString(),
      },
    ],
  };
}

function dropPayload(evt, pluginName) {
  return {
    username: USERNAME,
    embeds: [
      {
        title: `🎁 Drop raro: ${clean(evt.item)} ×${evt.qty}`,
        description: `${evt.from === 'boss' ? 'Boss' : 'Hunt'}: ${clean(evt.source)}`,
        color: COLORS.drop,
        footer: { text: `${accountLabel(evt)} · ${pluginName}` },
        timestamp: new Date(evt.ts).toISOString(),
      },
    ],
  };
}

function testPayload() {
  return {
    username: USERNAME,
    embeds: [
      {
        title: '✅ Webhook conectado',
        description: 'O IdleHub vai enviar shinies, drops raros e resumos para este canal.',
        color: COLORS.test,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function summaryPayload(summary) {
  return {
    username: USERNAME,
    embeds: [
      {
        title: `📊 Resumo — últimos ${summary.minutes} min`,
        description: summary.description,
        color: COLORS.summary,
        fields: summary.fields.slice(0, 25),
        timestamp: new Date(summary.ts).toISOString(),
      },
    ],
  };
}

// Fila sequencial: respeita o rate limit do Discord (HTTP 429 + retry_after).
class DiscordQueue {
  constructor({ fetchImpl = globalThis.fetch, gapMs = 1100, maxRetries = 3 } = {}) {
    this.fetch = fetchImpl;
    this.gapMs = gapMs;
    this.maxRetries = maxRetries;
    this.queue = [];
    this.busy = false;
  }

  send(url, payload) {
    return new Promise((resolve) => {
      this.queue.push({ url, payload, resolve });
      this.pump();
    });
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      job.resolve(await this.post(job.url, job.payload));
      if (this.queue.length) await sleep(this.gapMs);
    }
    this.busy = false;
  }

  async post(url, payload, attempt = 0) {
    try {
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        const body = await res.json().catch(() => ({}));
        const wait = Math.min(Number(body.retry_after) || 2, 60);
        await sleep(wait * 1000);
        return this.post(url, payload, attempt + 1);
      }
      if (res.ok) return { ok: true };
      return { ok: false, error: `Discord respondeu HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }
}

module.exports = { DiscordQueue, shinyPayload, dropPayload, testPayload, summaryPayload, COLORS };
