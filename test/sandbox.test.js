'use strict';

// Telas de jogo em sandbox: webPreferences, preload montado num arquivo só e o que ele faz rodando num
// ambiente parecido com o de um preload em sandbox (só "electron" no require).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { panelWebPreferences, PANEL_PRELOAD } = require('../src/panel-prefs');
const montar = require('../scripts/montar-preload');
const plugins = require('../src/plugins');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// ---------- webPreferences ----------

test('telas de jogo: sandbox, contextIsolation e nodeIntegration nunca afrouxados', () => {
  // Comparação do objeto inteiro: mudar ou acrescentar qualquer opção reprova e obriga a rever este teste.
  assert.deepEqual(panelWebPreferences('persist:panel-x'), {
    partition: 'persist:panel-x',
    preload: PANEL_PRELOAD,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false,
  });
  assert.equal(PANEL_PRELOAD, path.join(SRC, 'gerado', 'preload-panel.js'));
});

test('main.js cria as telas de jogo com panelWebPreferences', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /new WebContentsView\(\{ webPreferences: panelWebPreferences\(partition\) \}\)/);
  assert.equal((main.match(/new WebContentsView\(/g) || []).length, 1, 'toda tela de jogo passa por panelWebPreferences');
  assert.doesNotMatch(main, /preload-panel\.js/, 'o main não aponta para a fonte do preload, só para o arquivo montado');
});

test('nenhum arquivo de src/ desliga sandbox, contextIsolation ou liga nodeIntegration', () => {
  const files = fs.readdirSync(SRC, { recursive: true }).filter((f) => f.endsWith('.js') && !f.startsWith('gerado'));
  assert.ok(files.length > 5);
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.doesNotMatch(code, /sandbox\s*:\s*false/, f);
    assert.doesNotMatch(code, /contextIsolation\s*:\s*false/, f);
    assert.doesNotMatch(code, /nodeIntegration\w*\s*:\s*true/, f);
    // smoke-test.js cita --no-sandbox só para reprovar quem o usa; ligar a opção é que não pode.
    assert.doesNotMatch(code, /appendSwitch\(\s*['"](no-sandbox|disable-gpu-sandbox)|ELECTRON_DISABLE_SANDBOX\s*=|enableSandbox\s*=\s*false/, f);
  }
});

// ---------- montagem ----------

test('preload montado está em dia com as fontes', () => {
  assert.ok(fs.existsSync(montar.OUT), 'falta src/gerado/preload-panel.js: rode npm run montar (npm test já roda sozinho)');
  assert.ok(montar.isFresh(), 'src/gerado/preload-panel.js está desatualizado: rode npm run montar');
  assert.equal(montar.build(), montar.build(), 'montagem determinística');
});

test('montagem leva a entrada, o registro, cada plugin e o observador', () => {
  const ids = montar.collect().map((m) => m.id);
  assert.equal(ids[0], 'preload-panel.js');
  for (const id of ['plugins/index.js', 'plugins/hook.js', 'plugins/pokeidle.js']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('main.js'));
});

test('scripts do npm montam o preload antes de rodar, testar e empacotar', () => {
  for (const s of ['start', 'test', 'fumaca', 'dist', 'dist:linux', 'release'])
    assert.equal(pkg.scripts[`pre${s}`], 'node scripts/montar-preload.js', `pre${s}`);
  // O empacotamento leva src/ inteiro, inclusive src/gerado/.
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\/src\/gerado\/$/m);
});

function withFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-montar-'));
  try {
    for (const [name, code] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), code);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('montagem recusa módulo que não existe em sandbox, require dinâmico e caminho fora de src/', () => {
  withFixture({ 'src/e.js': "require('fs');" }, (d) =>
    assert.throws(() => montar.build(path.join(d, 'src'), 'e.js'), /"fs" não existe num preload em sandbox/),
  );
  withFixture({ 'src/e.js': "const n = './a'; require(n);" }, (d) =>
    assert.throws(() => montar.build(path.join(d, 'src'), 'e.js'), /require sem um texto fixo/),
  );
  withFixture({ 'src/e.js': "require('../fora');", 'fora.js': '' }, (d) =>
    assert.throws(() => montar.build(path.join(d, 'src'), 'e.js'), /sai de src/),
  );
  withFixture({ 'src/e.js': "require('./nao-existe');" }, (d) =>
    assert.throws(() => montar.build(path.join(d, 'src'), 'e.js'), /não achei o módulo/),
  );
  withFixture({ 'src/e.js': "module.exports = require('./a').x + require('./b');", 'src/a/index.js': 'exports.x = 1;', 'src/b.js': "require('./a'); module.exports = 2;" }, (d) => {
    const code = montar.build(path.join(d, 'src'), 'e.js');
    assert.deepEqual(
      montar.collect(path.join(d, 'src'), 'e.js').map((m) => m.id),
      ['e.js', 'a/index.js', 'b.js'],
    );
    assert.doesNotThrow(() => new vm.Script(code));
  });
});

// ---------- o preload montado rodando como em sandbox ----------

// Executa o arquivo montado com um require que só conhece "electron" (como num preload em sandbox) e uma
// janela falsa. Devolve o que ele mandou por IPC, o código injetado na página e o ouvinte de mensagens.
function runPreload(url, { sandboxed = true } = {}) {
  const sent = [];
  const injected = [];
  const listeners = [];
  const electron = {
    // JSON: como o IPC de verdade, só dados; e tira os objetos do contexto do vm (outro "realm").
    ipcRenderer: { send: (channel, data) => sent.push({ channel, data: JSON.parse(JSON.stringify(data)) }) },
    webFrame: {
      executeJavaScript: (code) => {
        injected.push(code);
        return Promise.resolve();
      },
    },
  };
  const required = [];
  const sandboxRequire = (name) => {
    required.push(name);
    if (name === 'electron') return electron;
    throw new Error(`módulo ${name} não existe num preload em sandbox`);
  };
  const window = {
    location: { href: url },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  };
  const context = vm.createContext({ window, process: { sandboxed, contextIsolated: true }, URL });
  const fn = vm.runInContext(`(function (require) {\n${fs.readFileSync(PANEL_PRELOAD, 'utf8')}\n})`, context, {
    filename: PANEL_PRELOAD,
  });
  fn(sandboxRequire);
  return { sent, injected, listeners, required, window };
}

test('preload montado roda só com o require de sandbox e resolve o plugin de cada jogo', () => {
  assert.ok(plugins.PLUGINS.length >= 1);
  for (const p of plugins.PLUGINS) {
    const r = runPreload(`https://${p.hosts[0]}/app`);
    assert.deepEqual([...new Set(r.required)], ['electron'], 'nenhum outro módulo pedido ao require');
    assert.deepEqual(r.sent[0], {
      channel: 'panel:ready',
      data: { pluginId: p.id, sandboxed: true, contextIsolated: true },
    });
    assert.equal(r.injected.length, 1);
    assert.ok(r.injected[0].includes(JSON.stringify(p.id)));
    assert.equal(r.listeners.filter((l) => l.type === 'message').length, 1);
  }
});

test('preload montado informa quando a tela não está em sandbox', () => {
  const r = runPreload(`https://${plugins.PLUGINS[0].hosts[0]}/`, { sandboxed: false });
  assert.equal(r.sent[0].data.sandboxed, false);
});

test('preload montado não injeta nada em site sem plugin', () => {
  const r = runPreload('https://exemplo.test/');
  assert.deepEqual(r.sent, [{ channel: 'panel:ready', data: { pluginId: null, sandboxed: true, contextIsolated: true } }]);
  assert.equal(r.injected.length, 0);
  assert.equal(r.listeners.length, 0);
});

test('do WebSocket do jogo ao IPC: código injetado + ouvinte do preload montado', () => {
  const pokeidle = plugins.pluginById('pokeidle');
  const r = runPreload('https://pokeidle.io/app');

  // Mundo da página: WebSocket nativo falso; postMessage entrega ao ouvinte do preload.
  class FakeWS extends EventTarget {
    constructor(u) {
      super();
      this.url = u;
    }
  }
  const page = {
    WebSocket: FakeWS,
    location: { origin: 'https://pokeidle.io' },
    postMessage: (data) => r.listeners.forEach((l) => l.fn({ source: r.window, data })),
  };
  vm.runInContext(r.injected[0], vm.createContext({ window: page, TextDecoder, JSON, Date, Object, Array }));
  assert.equal(page.__idleHubHook, true);

  const ws = new page.WebSocket('wss://pokeidle.io');
  const ev = new Event('message');
  ev.data = JSON.stringify({ t: 'batalha', ev: [{ k: 'capturado', pokemon: { nome: 'Mew', shiny: true } }] });
  ws.dispatchEvent(ev);

  const events = r.sent.filter((s) => s.channel === 'panel:events');
  assert.equal(events.length, 1);
  assert.equal(events[0].data.pluginId, pokeidle.id);
  assert.deepEqual(
    events[0].data.events.map((e) => e.type),
    ['alive', 'shiny'],
  );

  // Mensagem de outra janela ou de outro plugin é ignorada.
  r.listeners[0].fn({ source: {}, data: { __idleHub: true, pluginId: 'pokeidle', events: [] } });
  r.listeners[0].fn({ source: r.window, data: { __idleHub: true, pluginId: 'outro', events: [] } });
  assert.equal(r.sent.filter((s) => s.channel === 'panel:events').length, 1);
});
