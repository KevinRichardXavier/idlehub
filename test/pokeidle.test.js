'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const pokeidle = require('../src/plugins/pokeidle');
const { pluginForUrl } = require('../src/plugins');

const detect = (m) => pokeidle.detect(m, pokeidle.special);

test('detecta shiny capturado', () => {
  const out = detect({
    t: 'batalha',
    ev: [{ k: 'capturado', pokemon: { nome: 'Gyarados', level: 42, quality: 87, shiny: true } }],
  });
  assert.deepEqual(out, [{ type: 'shiny', name: 'Gyarados', level: 42, quality: 87, source: 'captura' }]);
});

test('ignora captura normal (não shiny)', () => {
  assert.deepEqual(detect({ t: 'batalha', ev: [{ k: 'capturado', pokemon: { nome: 'Rattata', shiny: false } }] }), []);
});

test('detecta shiny chocado de ovo', () => {
  const out = detect({ t: 'batalha', ev: [{ k: 'ovoChocou', pokemon: { nome: 'Eevee', shiny: true } }] });
  assert.equal(out[0].source, 'ovo');
});

test('detecta drop raro de hunt e ignora drops comuns', () => {
  const out = detect({
    t: 'batalha',
    ev: [
      {
        k: 'morte',
        quem: 'selvagem',
        nome: 'Zubat',
        drops: [
          { itemId: 1, nome: 'Bat Wing', qtd: 3 },
          { itemId: 70012, nome: 'Shiny Stone Fragment', qtd: 1 },
        ],
      },
    ],
  });
  assert.deepEqual(out, [
    { type: 'drop', itemId: 70012, item: 'Shiny Stone Fragment', qty: 1, from: 'hunt', source: 'Zubat' },
  ]);
});

test('detecta drop raro de boss', () => {
  const out = detect({
    t: 'batalha',
    ev: [{ k: 'bossMorto', nome: 'Entei', drops: [{ itemId: 70090, qtd: 2 }] }],
  });
  assert.deepEqual(out, [
    { type: 'drop', itemId: 70090, item: 'Mystic Ticket', qty: 2, from: 'boss', source: 'Entei' },
  ]);
});

test('ignora morte do próprio pokémon, safari e drops com qtd 0', () => {
  assert.deepEqual(
    detect({
      t: 'batalha',
      ev: [
        { k: 'morte', quem: 'meu', drops: [{ itemId: 70012, qtd: 1 }] },
        { k: 'morte', quem: 'selvagem', safari: true, drops: [{ itemId: 70012, qtd: 1 }] },
        { k: 'bossMorto', drops: [{ itemId: 70090, qtd: 0 }] },
      ],
    }),
    [],
  );
});

test('lê o nick no welcome', () => {
  assert.deepEqual(detect({ t: 'welcome', estado: { eu: { nick: 'Ash' } } }), [{ type: 'account', nick: 'Ash' }]);
});

test('mensagens irrelevantes ou malformadas não quebram', () => {
  for (const m of [null, 42, 'x', {}, { t: 'pong' }, { t: 'batalha' }, { t: 'batalha', ev: [null, 1, {}] }]) {
    assert.deepEqual(detect(m), []);
  }
});

test('detect funciona serializado (como roda dentro da página)', () => {
  const fn = new Function(`return (${pokeidle.detect.toString()})`)();
  const out = fn({ t: 'batalha', ev: [{ k: 'bossMorto', drops: [{ itemId: 59194, qtd: 1 }] }] }, pokeidle.special);
  assert.equal(out[0].item, 'TM Disk Piece');
});

test('pluginForUrl reconhece o Pokeidle', () => {
  assert.equal(pluginForUrl('https://pokeidle.io/app').id, 'pokeidle');
  assert.equal(pluginForUrl('https://www.pokeidle.io/app').id, 'pokeidle');
  assert.equal(pluginForUrl('https://fakepokeidle.io/'), null);
  assert.equal(pluginForUrl('lixo'), null);
});
