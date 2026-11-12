'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installHook } = require('../src/plugins/hook');
const pokeidle = require('../src/plugins/pokeidle');

// Simula o ambiente da página: window, WebSocket nativo e postMessage.
function fakePage() {
  const posted = [];
  class FakeWS extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = url;
      this.protocols = protocols;
      FakeWS.last = this;
    }
    receive(data) {
      const ev = new Event('message');
      ev.data = data;
      this.dispatchEvent(ev);
    }
  }
  FakeWS.OPEN = 1;
  const win = {
    WebSocket: FakeWS,
    location: { origin: 'https://pokeidle.io' },
    postMessage: (msg, origin) => posted.push({ msg, origin }),
  };
  return { win, FakeWS, posted };
}

function run(win, fn) {
  const prev = globalThis.window;
  globalThis.window = win;
  try {
    return fn();
  } finally {
    globalThis.window = prev;
  }
}

test('observador repassa shiny e não altera o WebSocket do jogo', () => {
  const { win, FakeWS, posted } = fakePage();
  run(win, () => {
    const hook = new Function(`return (${installHook.toString()})`)();
    const detect = new Function(`return (${pokeidle.detect.toString()})`)();
    hook(detect, pokeidle.special, 'pokeidle');
    hook(detect, pokeidle.special, 'pokeidle'); // instalar duas vezes não duplica

    const ws = new window.WebSocket('wss://pokeidle.io', ['p']);
    assert.ok(ws instanceof FakeWS, 'o jogo continua recebendo um WebSocket nativo');
    assert.equal(window.WebSocket.OPEN, 1, 'constantes estáticas preservadas');
    assert.deepEqual(ws.protocols, ['p']);

    let gameSaw = 0;
    ws.addEventListener('message', () => gameSaw++);
    ws.receive(JSON.stringify({ t: 'batalha', ev: [{ k: 'capturado', pokemon: { nome: 'Mew', shiny: true } }] }));
    ws.receive('não é json');
    ws.receive(new TextEncoder().encode(JSON.stringify({ t: 'pong' })).buffer);

    assert.equal(gameSaw, 3, 'o jogo recebe todas as mensagens normalmente');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].origin, 'https://pokeidle.io');
    assert.equal(posted[0].msg.pluginId, 'pokeidle');
    assert.deepEqual(
      posted[0].msg.events.map((e) => e.type),
      ['alive', 'shiny'],
    );
  });
});
