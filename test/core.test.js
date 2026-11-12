'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugins = require('../src/plugins');
const { normalizeConfig, isWebhookUrl } = require('../src/config');
const { SummaryTracker } = require('../src/summary');
const discord = require('../src/discord');

const meta = plugins.meta();

test('config padrão: 1 aba do Pokeidle com 4 telas', () => {
  const c = normalizeConfig(null, meta);
  assert.equal(c.tabs.length, 1);
  assert.equal(c.tabs[0].panels.length, 4);
  assert.equal(c.tabs[0].panels[0].url, 'https://pokeidle.io/app');
  assert.equal(c.activeTabId, c.tabs[0].id);
  assert.equal(c.plugins.pokeidle.rareItems['70000'], false); // Bronze Boss Token desligado
  assert.equal(c.plugins.pokeidle.rareItems['70090'], true);
});

test('normalize completa telas, remove URLs inválidas e IDs duplicados', () => {
  const c = normalizeConfig(
    {
      tabs: [
        { id: 'a', name: 'X', panels: [{ id: 'p1', url: 'javascript:alert(1)' }, { id: 'p1', url: 'https://ok.com' }] },
      ],
      discord: { webhookUrl: 'https://evil.com/x', summaryMinutes: 7 },
    },
    meta,
  );
  const ps = c.tabs[0].panels;
  assert.equal(ps.length, 4);
  assert.equal(ps[0].url, '');
  assert.equal(ps[1].url, 'https://ok.com');
  assert.equal(new Set(ps.map((p) => p.id)).size, 4);
  assert.equal(c.discord.webhookUrl, '');
  assert.equal(c.discord.summaryMinutes, 60);
});

test('normalize preserva escolhas de itens raros', () => {
  const c = normalizeConfig({ tabs: [], plugins: { pokeidle: { rareItems: { 70000: true, 70090: false } } } }, meta);
  assert.equal(c.plugins.pokeidle.rareItems['70000'], true);
  assert.equal(c.plugins.pokeidle.rareItems['70090'], false);
  assert.equal(c.tabs.length, 1);
});

test('valida URL de webhook', () => {
  assert.ok(isWebhookUrl('https://discord.com/api/webhooks/123/abc-DEF_9'));
  assert.ok(isWebhookUrl('https://canary.discord.com/api/webhooks/1/x'));
  assert.ok(!isWebhookUrl('https://discord.com.evil.io/api/webhooks/1/x'));
  assert.ok(!isWebhookUrl('http://discord.com/api/webhooks/1/x'));
});

test('resumo agrega por conta e marca contas inativas', () => {
  const t0 = 1_000_000;
  const tr = new SummaryTracker(t0);
  tr.record({ panelId: 'a', type: 'shiny', name: 'Pikachu' });
  tr.record({ panelId: 'a', type: 'drop', item: 'Mystic Ticket', qty: 1 });
  tr.record({ panelId: 'a', type: 'drop', item: 'Mystic Ticket', qty: 2 });
  const now = t0 + 60 * 60000;
  const s = tr.build(
    [
      { panelId: 'a', panelName: 'Conta 1', tabName: 'Pokeidle', nick: 'Ash', tracked: true, lastSeen: now - 1000 },
      { panelId: 'b', panelName: 'Conta 2', tabName: 'Pokeidle', nick: null, tracked: true, lastSeen: now - 20 * 60000 },
      { panelId: 'c', panelName: 'Outro', tabName: 'X', nick: null, tracked: false, lastSeen: null },
    ],
    now,
  );
  assert.equal(s.minutes, 60);
  assert.match(s.description, /\*\*1\*\* shiny.*\*\*3\*\* drop/);
  assert.equal(s.fields.length, 2); // conta sem plugin e sem eventos fica de fora
  assert.match(s.fields[0].value, /Pikachu/);
  assert.match(s.fields[0].value, /Mystic Ticket ×3/);
  assert.match(s.fields[0].value, /🟢/);
  assert.match(s.fields[1].value, /🔴 sem atividade há 20 min/);
});

test('resumo vazio retorna null', () => {
  assert.equal(new SummaryTracker().build([]), null);
});

test('payloads do Discord', () => {
  const evt = { ts: 0, panelName: 'Conta 1', nick: 'Ash', name: 'Gyarados', level: 40, quality: 90, source: 'captura' };
  const p = discord.shinyPayload(evt, 'Pokeidle');
  assert.equal(p.embeds[0].title, '✨ Shiny capturado!');
  assert.match(p.embeds[0].description, /\*\*Gyarados\*\* · Nv 40 · qualidade 90/);
  assert.equal(p.embeds[0].footer.text, 'Conta 1 (Ash) · Pokeidle');
  const d = discord.dropPayload({ ...evt, item: 'TM Disk Piece', qty: 2, from: 'boss', source: 'Entei' }, 'Pokeidle');
  assert.equal(d.embeds[0].title, '🎁 Drop raro: TM Disk Piece ×2');
  assert.equal(d.embeds[0].description, 'Boss: Entei');
});

test('fila do Discord respeita 429 e reporta erro', async () => {
  const calls = [];
  const responses = [
    { status: 429, ok: false, json: async () => ({ retry_after: 0.01 }) },
    { status: 204, ok: true },
    { status: 404, ok: false },
  ];
  const q = new discord.DiscordQueue({
    gapMs: 1,
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return responses.shift();
    },
  });
  const [a, b] = await Promise.all([q.send('u', { n: 1 }), q.send('u', { n: 2 })]);
  assert.deepEqual(a, { ok: true });
  assert.deepEqual(b, { ok: false, error: 'Discord respondeu HTTP 404' });
  assert.deepEqual(calls.map((c) => c.n), [1, 1, 2]);
});

test('fila do Discord trata falha de rede', async () => {
  const q = new discord.DiscordQueue({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await q.send('u', {}), { ok: false, error: 'offline' });
});
