'use strict';

// Proxy das telas de jogo: validação dos campos, aplicação nas sessões, ausência de fallback para conexão
// direta, login do proxy, "Testar proxy", onde a senha fica guardada e que ela não aparece em logs.
// As senhas daqui são valores de teste, nunca senhas de verdade. A prova no Chromium de verdade (proxy
// http com senha, socks5, proxy fora do ar) é o teste de fumaça (src/smoke-proxy.js), que roda no CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const proxy = require('../src/proxy');
const { ProxySecret, FILE_NAME } = require('../src/proxy-secret');
const { ProxyManager } = require('../src/proxy-manager');
const { normalizeConfig, defaultConfig } = require('../src/config');
const plugins = require('../src/plugins');

const SRC = path.join(__dirname, '..', 'src');
const SENHA = 'senha-de-teste-NAO-REAL-123';
const USUARIO = 'usuario-de-teste';

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-proxy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// safeStorage falso: "criptografa" invertendo o texto (só para os testes saberem que passou por ele).
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret', failDecrypt = false } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (s) => Buffer.from(`ENC:${[...s].reverse().join('')}`),
    decryptStringAsync: async (b) => {
      if (failDecrypt) throw new Error('chave mudou');
      return { result: [...b.toString().slice(4)].reverse().join(''), shouldReEncrypt: false };
    },
  };
}

// Sessão falsa. `request(url)` simula uma requisição de rede nova da sessão passando pelo onBeforeRequest
// registrado (se houver): devolve 'cancelada' ou 'livre'.
function fakeSession() {
  const calls = [];
  const s = {
    calls,
    listeners: 0,
    setProxy: async (cfg) => calls.push(['setProxy', cfg]),
    closeAllConnections: async () => calls.push(['closeAllConnections']),
    clearAuthCache: async () => calls.push(['clearAuthCache']),
    webRequest: {
      onBeforeRequest: (filter, fn) => {
        s.listeners++;
        s.filter = filter;
        s.listener = fn;
      },
    },
    request(url) {
      if (!s.listener) return 'livre';
      let out = null;
      s.listener({ url }, (r) => (out = r));
      return out && out.cancel ? 'cancelada' : 'livre';
    },
  };
  return s;
}

function makeManager(t, { settings = proxy.defaultProxy(), secret, net, ses, log } = {}) {
  let current = settings;
  const sec = secret || new ProxySecret(tmpDir(t), { safeStorage: fakeSafeStorage(), platform: 'linux' });
  const m = new ProxyManager({
    secret: sec,
    getSettings: () => current,
    setSettings: (p) => {
      current = p;
    },
    net,
    makeTestSession: ses ? async () => ses : null,
    log: log || (() => {}),
  });
  return { m, sec, get: () => current };
}

const ON = { enabled: true, type: 'http', host: 'proxy.exemplo.com', port: 8080, username: '' };

// ---------- validação dos campos ----------

test('validação: aceita http, https e socks5 com host e porta', () => {
  for (const type of ['http', 'https', 'socks5']) {
    const r = proxy.validateProxy({ enabled: true, type, host: ' Proxy.Exemplo.com ', port: '8080' });
    assert.deepEqual(r, { ok: true, value: { enabled: true, type, host: 'proxy.exemplo.com', port: 8080, username: '' } });
  }
  assert.equal(proxy.validateProxy({ enabled: true, type: 'http', host: '203.0.113.10', port: 3128 }).value.host, '203.0.113.10');
  assert.equal(proxy.validateProxy({ enabled: true, type: 'http', host: '[2001:db8::1]', port: 3128 }).value.host, '2001:db8::1');
  assert.equal(proxy.validateProxy({ enabled: true, type: 'http', host: '2001:DB8::1', port: 3128 }).value.host, '2001:db8::1');
});

test('validação: recusa tipo, host e porta inválidos com o campo certo', () => {
  const cases = [
    [{ type: 'socks4', host: 'a.com', port: 1 }, 'type'],
    [{ type: 'ftp', host: 'a.com', port: 1 }, 'type'],
    [{ type: 'http', host: '', port: 8080 }, 'host'],
    [{ type: 'http', host: 'http://a.com', port: 8080 }, 'host'],
    [{ type: 'http', host: 'socks5://a.com', port: 8080 }, 'host'],
    [{ type: 'http', host: 'user:pass@a.com', port: 8080 }, 'host'],
    [{ type: 'http', host: 'a com', port: 8080 }, 'host'],
    [{ type: 'http', host: 'a.com/caminho', port: 8080 }, 'host'],
    [{ type: 'http', host: 'a.com:8080', port: 8080 }, 'host'],
    [{ type: 'http', host: '1.2.3', port: 8080 }, 'host'],
    [{ type: 'http', host: '-a.com', port: 8080 }, 'host'],
    [{ type: 'http', host: 'a.com', port: '' }, 'port'],
    [{ type: 'http', host: 'a.com', port: 0 }, 'port'],
    [{ type: 'http', host: 'a.com', port: 65536 }, 'port'],
    [{ type: 'http', host: 'a.com', port: '80a' }, 'port'],
    [{ type: 'http', host: 'a.com', port: -1 }, 'port'],
    [{ type: 'http', host: 'a.com', port: 1.5 }, 'port'],
  ];
  for (const [input, field] of cases) {
    const r = proxy.validateProxy({ enabled: true, ...input });
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.field, field, JSON.stringify(input));
    assert.ok(r.error.length > 10);
  }
});

test('validação: usuário e senha andam juntos; senha salva conta só com usuário', () => {
  const base = { enabled: true, type: 'http', host: 'a.com', port: 8080 };
  assert.equal(proxy.validateProxy({ ...base, username: USUARIO, password: SENHA }).ok, true);
  assert.equal(proxy.validateProxy({ ...base, password: SENHA }).field, 'username');
  assert.equal(proxy.validateProxy({ ...base, username: USUARIO }).field, 'password');
  assert.equal(proxy.validateProxy({ ...base, username: USUARIO }, { hasSavedPassword: true }).ok, true);
  assert.equal(proxy.validateProxy({ ...base, username: USUARIO, clearPassword: true }, { hasSavedPassword: true }).field, 'password');
  assert.equal(proxy.validateProxy({ ...base, username: 'a\nb', password: SENHA }).field, 'username');
  assert.equal(proxy.validateProxy({ ...base, username: USUARIO, password: 'x'.repeat(300) }).field, 'password');
  // O valor validado nunca carrega a senha.
  assert.equal('password' in proxy.validateProxy({ ...base, username: USUARIO, password: SENHA }).value, false);
});

test('validação: socks5 com usuário ou senha é recusado com aviso claro (o Chromium não suporta)', () => {
  const base = { enabled: true, type: 'socks5', host: 'a.com', port: 1080 };
  for (const extra of [{ username: USUARIO, password: SENHA }, { username: USUARIO }, { password: SENHA }]) {
    const r = proxy.validateProxy({ ...base, ...extra }, { hasSavedPassword: true });
    assert.equal(r.ok, false);
    assert.equal(r.error, proxy.SOCKS_AUTH_ERROR);
    assert.match(r.error, /não suporta socks5 com usuário e senha/);
  }
  // Senha salva de um proxy http anterior não atrapalha trocar para socks5 sem usuário.
  assert.equal(proxy.validateProxy(base, { hasSavedPassword: true }).ok, true);
});

test('validação: desligado e vazio pode salvar; desligado com campos é validado do mesmo jeito', () => {
  assert.deepEqual(proxy.validateProxy({ enabled: false, type: 'http', host: '', port: '' }), { ok: true, value: proxy.defaultProxy() });
  assert.equal(proxy.validateProxy({ enabled: false, type: 'http', host: 'a.com', port: 'x' }).field, 'port');
  assert.equal(proxy.validateProxy({ enabled: false, type: 'http', host: 'a.com', port: 1 }).value.enabled, false);
});

test('validação: nenhuma mensagem de erro repete a senha ou o usuário digitados', () => {
  const inputs = [
    { type: 'socks5', host: 'a.com', port: 1, username: USUARIO, password: SENHA },
    { type: 'http', host: `${USUARIO}:${SENHA}@a.com`, port: 1 },
    { type: 'http', host: `${SENHA} ${USUARIO}`, port: 1, username: USUARIO, password: SENHA },
    { type: 'http', host: 'a.com', port: SENHA, username: USUARIO, password: SENHA },
    { type: 'http', host: 'a.com', port: 1, password: SENHA },
    { type: 'http', host: 'a.com', port: 1, username: USUARIO, password: `${SENHA}\n` },
  ];
  for (const input of inputs) {
    const r = proxy.validateProxy({ enabled: true, ...input });
    assert.equal(r.ok, false);
    assert.ok(!r.error.includes(SENHA) && !r.error.includes(USUARIO), r.error);
  }
});

// ---------- configuração salva ----------

test('config.json: proxy padrão desligado, sem senha e sem nenhum campo extra', () => {
  const metas = plugins.meta();
  assert.deepEqual(defaultConfig(metas).proxy, proxy.defaultProxy());
  const cfg = normalizeConfig({ proxy: { ...ON, username: USUARIO, password: SENHA, senha: SENHA } }, metas);
  assert.deepEqual(cfg.proxy, { ...ON, username: USUARIO });
  assert.ok(!JSON.stringify(cfg).includes(SENHA));
});

test('config.json: proxy ligado e inválido continua ligado (marcado inválido), nunca vira conexão direta', () => {
  const metas = plugins.meta();
  for (const bad of [
    { ...ON, host: 'http://a.com' },
    { ...ON, port: 0 },
    { ...ON, type: 'socks4' },
    { ...ON, type: 'socks5', username: USUARIO },
    { enabled: true },
  ]) {
    const p = normalizeConfig({ proxy: bad }, metas).proxy;
    assert.equal(p.enabled, true, JSON.stringify(bad));
    assert.equal(p.invalid, true, JSON.stringify(bad));
    assert.throws(() => proxy.sessionProxyConfig(p), /inválida/);
  }
  assert.equal(normalizeConfig({ proxy: { ...ON, enabled: 'sim' } }, metas).proxy.enabled, false);
  assert.equal(normalizeConfig({ proxy: ON }, metas).proxy.invalid, undefined);
});

// ---------- regras para o Chromium: sem fallback para conexão direta ----------

test('regras do proxy: um único proxy, sem direct:// e sem exceção de localhost', () => {
  for (const type of proxy.PROXY_TYPES) {
    const cfg = proxy.sessionProxyConfig({ ...ON, type });
    assert.deepEqual(cfg, { mode: 'fixed_servers', proxyRules: `${type}://proxy.exemplo.com:8080`, proxyBypassRules: '<-loopback>' });
    assert.doesNotMatch(cfg.proxyRules, /direct|[,;]/i, 'qualquer item a mais na lista seria um caminho alternativo');
    assert.doesNotMatch(cfg.proxyBypassRules, /<local>|\*/);
  }
  assert.equal(proxy.sessionProxyConfig({ ...ON, host: '2001:db8::1' }).proxyRules, 'http://[2001:db8::1]:8080');
  // Usuário e senha nunca vão na regra (o Chromium ignoraria e eles ficariam expostos).
  assert.doesNotMatch(proxy.sessionProxyConfig({ ...ON, username: USUARIO }).proxyRules, /@|usuario/);
  assert.deepEqual(proxy.sessionProxyConfig({ ...ON, enabled: false }), { mode: 'system' });
});

test('WebRTC: com o proxy ligado, nada de UDP fora do proxy', () => {
  assert.equal(proxy.webRtcPolicy(ON), 'disable_non_proxied_udp');
  assert.equal(proxy.webRtcPolicy({ ...ON, enabled: false }), 'default');
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  assert.match(main, /app\.on\('web-contents-created', \(_e, wc\) => \{\s*if \(config\) setWebRtcPolicy\(wc\);/, 'toda janela nova (popups inclusos) recebe a política');
  assert.match(main, /for \(const wc of webContents\.getAllWebContents\(\)\) setWebRtcPolicy\(wc\);/, 'mudança ao vivo reaplica em todas as janelas');
});

// ---------- aplicação nas sessões ----------

test('sessões: aplica a regra do proxy antes de carregar e reaplica ao vivo derrubando conexões antigas', async (t) => {
  const { m } = makeManager(t, { settings: ON });
  const a = fakeSession();
  const b = fakeSession();
  assert.deepEqual(await m.applyToSession(a), proxy.sessionProxyConfig(ON));
  assert.deepEqual(a.calls, [['setProxy', proxy.sessionProxyConfig(ON)]]);

  a.calls.length = 0;
  const failed = await m.applyLive([a, b, a]); // sessão repetida (popup da mesma conta) é aplicada uma vez
  assert.deepEqual(failed, []);
  for (const s of [a, b])
    assert.deepEqual(s.calls, [['setProxy', proxy.sessionProxyConfig(ON)], ['closeAllConnections'], ['clearAuthCache']]);
});

test('sessões: proxy ligado e inválido não é aplicado; a sessão inteira fica bloqueada e a tela não carrega o jogo', async (t) => {
  const { m } = makeManager(t, { settings: { ...ON, invalid: true } });
  const s = fakeSession();
  await assert.rejects(m.applyToSession(s));
  assert.deepEqual(
    s.calls,
    [['setProxy', proxy.BLOCK_CONFIG], ['closeAllConnections']],
    'nem "system" nem a rota anterior: só o bloqueio, e as conexões abertas caem',
  );
  assert.equal(m.isBlocked(s), true);
  assert.equal(s.request('http://jogo.example/'), 'cancelada', 'nenhuma requisição nova sai da sessão');
  s.calls.length = 0;
  assert.deepEqual(await m.applyLive([s]), [s], 'a sessão volta como falha e a tela vai para a página sem conexão');
  assert.deepEqual(s.calls, [['setProxy', proxy.BLOCK_CONFIG], ['closeAllConnections'], ['clearAuthCache']]);
});

test('sessões: o bloqueio só sai quando uma regra válida é aplicada com sucesso', async (t) => {
  let current = { ...ON, invalid: true };
  const m = new ProxyManager({ secret: { getFor: () => '', has: () => false }, getSettings: () => current, setSettings: () => {} });
  const s = fakeSession();
  await assert.rejects(m.applyToSession(s));
  assert.equal(s.request('wss://jogo.example/socket'), 'cancelada');
  current = ON;
  await m.applyToSession(s);
  assert.equal(m.isBlocked(s), false);
  assert.equal(s.request('wss://jogo.example/socket'), 'livre');
  assert.equal(s.listeners, 1, 'um único ouvinte por sessão');
});

test('sessões: o bloqueio não tem saída direta nem exceção', () => {
  const b = proxy.BLOCK_CONFIG;
  assert.equal(b.mode, 'fixed_servers');
  assert.equal(b.proxyRules, 'http://127.0.0.1:9');
  assert.ok(!/direct/i.test(b.proxyRules));
  assert.equal(b.proxyBypassRules, '<-loopback>', 'nem o loopback escapa do bloqueio');
  assert.ok(Object.isFrozen(b));
});

test('sessões: falha do setProxy numa sessão não deixa a tela na rota antiga', async (t) => {
  const { m } = makeManager(t, { settings: ON });
  const ok = fakeSession();
  const ruim = { ...fakeSession(), setProxy: async () => Promise.reject(new Error('falhou')) };
  assert.deepEqual(await m.applyLive([ruim, ok]), [ruim]);
  assert.equal(ok.calls[0][0], 'setProxy');
});

test('sessões: setProxy que falha com a configuração nova troca a sessão pelo bloqueio (popups da conta não ficam na rota antiga)', async (t) => {
  const { m } = makeManager(t, { settings: ON });
  const s = fakeSession();
  const real = s.setProxy;
  s.setProxy = async (cfg) => {
    if (cfg !== proxy.BLOCK_CONFIG) throw new Error('falhou');
    return real(cfg);
  };
  await assert.rejects(m.applyToSession(s), /falhou/);
  assert.deepEqual(s.calls, [['setProxy', proxy.BLOCK_CONFIG], ['closeAllConnections']]);
});

test('sessões: se nem o bloqueio entra, ainda derruba as conexões e esquece a autenticação', async (t) => {
  const { m } = makeManager(t, { settings: ON });
  const s = fakeSession();
  s.setProxy = async () => {
    throw new Error('falhou');
  };
  assert.deepEqual(await m.applyLive([s]), [s]);
  assert.deepEqual(s.calls, [['closeAllConnections'], ['clearAuthCache']]);
  // A regra anterior continua no Chromium, mas nenhuma requisição nova da sessão sai (telas, popups e
  // páginas de fundo de extensão usam o mesmo ouvinte da sessão).
  assert.equal(m.isBlocked(s), true);
  for (const url of ['http://jogo.example/', 'https://discord.com/oauth2', 'ws://jogo.example/', 'wss://jogo.example/'])
    assert.equal(s.request(url), 'cancelada', url);
});

test('request-gate: bloqueadores de chaves diferentes convivem num só ouvinte da sessão', () => {
  const gate = require('../src/request-gate');
  const s = fakeSession();
  gate.setBlocker(s, 'fumaca', (d) => !d.url.startsWith('http://127.0.0.1:1/'));
  gate.setBlocker(s, 'proxy', () => true);
  assert.equal(s.listeners, 1);
  assert.deepEqual(s.filter, { urls: gate.NETWORK_URLS });
  assert.equal(s.request('http://127.0.0.1:1/x'), 'cancelada', 'o bloqueio do proxy vale mesmo para o que a fumaça libera');
  gate.removeBlocker(s, 'proxy');
  assert.equal(s.request('http://127.0.0.1:1/x'), 'livre');
  assert.equal(s.request('https://exemplo.com/'), 'cancelada', 'tirar o bloqueio do proxy não apaga o da fumaça');
  assert.equal(gate.hasBlocker(s, 'fumaca'), true);
});

test('request-gate: se o registro do ouvinte falhar uma vez, a tentativa seguinte instala o bloqueio', () => {
  const gate = require('../src/request-gate');
  const s = fakeSession();
  const register = s.webRequest.onBeforeRequest;
  s.webRequest.onBeforeRequest = () => {
    throw new Error('falha simulada no registro');
  };
  assert.throws(() => gate.setBlocker(s, 'proxy', () => true), /falha simulada/);
  assert.equal(gate.hasBlocker(s, 'proxy'), false, 'sem ouvinte, a sessão não pode constar como bloqueada');
  s.webRequest.onBeforeRequest = register;
  gate.setBlocker(s, 'proxy', () => true);
  assert.equal(s.listeners, 1);
  assert.equal(gate.hasBlocker(s, 'proxy'), true);
  assert.equal(s.request('https://jogo.example/'), 'cancelada');
});

test('sessões: blockSession que falhou ao registrar o ouvinte bloqueia de verdade na tentativa seguinte', async (t) => {
  const { m } = makeManager(t);
  const s = fakeSession();
  const register = s.webRequest.onBeforeRequest;
  s.webRequest.onBeforeRequest = () => {
    throw new Error('falha simulada no registro');
  };
  await m.blockSession(s);
  assert.equal(m.isBlocked(s), false, 'a primeira tentativa não conseguiu barrar as requisições');
  s.webRequest.onBeforeRequest = register;
  await m.blockSession(s);
  assert.equal(m.isBlocked(s), true);
  for (const url of ['http://jogo.example/', 'https://jogo.example/', 'ws://jogo.example/', 'wss://jogo.example/'])
    assert.equal(s.request(url), 'cancelada', url);
});

test('request-gate: nenhum código registra onBeforeRequest por fora dele', () => {
  for (const f of fs.readdirSync(SRC).filter((n) => n.endsWith('.js') && n !== 'request-gate.js')) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    assert.ok(!/webRequest\.onBeforeRequest/.test(code), `${f} registra onBeforeRequest direto (o Electron guarda um só por sessão)`);
  }
});

test('sessões: aplicações em sequência terminam na última configuração pedida', async (t) => {
  let current = ON;
  const order = [];
  const m = new ProxyManager({ secret: { get: () => '', has: () => false }, getSettings: () => current, setSettings: () => {} });
  const slow = {
    setProxy: (cfg) => new Promise((r) => setTimeout(() => r(order.push(cfg.mode)), cfg.mode === 'fixed_servers' ? 30 : 0)),
  };
  const p1 = m.applyToSession(slow);
  current = { ...ON, enabled: false };
  const p2 = m.applyToSession(slow);
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['system', 'system'], 'cada aplicação lê a configuração na sua vez, em ordem');
});

test('main.js: tela de jogo só carrega o jogo depois do proxy aplicado; se falhar, página sem conexão', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
  const loadPanel = main.slice(main.indexOf('function loadPanel('), main.indexOf('function createView('));
  assert.match(loadPanel, /return proxyManager\.applyToSession\(wc\.session\)\.then\(\s*\(\) => \{\s*if \(!wc\.isDestroyed\(\)\) wc\.loadURL\(v\.url\)/);
  assert.match(loadPanel, /\(\) => \{\s*closePopupsOf\(new Set\(\[wc\.session\]\)\);\s*if \(!wc\.isDestroyed\(\)\) wc\.loadURL\(proxyBlockedPage\(\)\)/);
  // Fora do loadPanel, nenhum loadURL leva a tela a um endereço: só à página sem conexão.
  const outside = main.replace(loadPanel, '');
  for (const call of outside.match(/\.loadURL\([^)]*\)/g) || []) assert.equal(call, '.loadURL(proxyBlockedPage()', call);
  // Criação, edição do endereço, recarregar depois de travar e mudança do proxy usam o loadPanel.
  const create = main.slice(main.indexOf('function createView('), main.indexOf('function destroyView('));
  assert.ok(create.indexOf('proxyManager.applyToSession(wc.session).then(') < create.indexOf('loadPanel(entry)'));
  const sync = main.slice(main.indexOf('function syncViews('), main.indexOf('function applyLayout('));
  assert.match(sync, /v\.url = p\.url;\s*runtime\.delete\(p\.id\);\s*loadPanel\(v\);/);
  assert.match(main, /if \(wc\.isCrashed\(\) \|\| wc\.getURL\(\)\.startsWith\('data:'\)\) loadPanel\(v\);\s*else wc\.reload\(\);/);
  assert.match(main, /if \(failed\.has\(wc\.session\)\) wc\.loadURL\(proxyBlockedPage\(\)\)\.catch\(\(\) => \{\}\);\s*else loads\.push\(loadPanel\(v\)\);/);
  // Mudança ao vivo: fecha os popups das sessões que falharam e só termina depois que cada tela começou a
  // carregar de novo (uma recarga atrasada não derruba a navegação seguinte).
  const live = main.slice(main.indexOf('async function applyProxyLive('), main.indexOf('function closePopupsOf('));
  assert.match(live, /closePopupsOf\(failed\);/);
  assert.ok(live.indexOf('await Promise.all(loads);') > live.indexOf('loads.push(loadPanel(v))'), 'espera as recargas');
  assert.ok(live.indexOf('await Promise.all(loads);') < live.indexOf('return list.length;'));
  const close = main.slice(main.indexOf('function closePopupsOf('), main.indexOf('function loadPanel('));
  assert.match(close, /panelWcs\.has\(wc\) \|\| !sessions\.has\(wc\.session\) \|\| wc\.getType\(\) !== 'window'/);
  assert.match(close, /if \(popup && popup !== win\) popup\.destroy\(\);/, 'destroy: o beforeunload não cancela');
  // Popups de login usam a mesma partição (e portanto o mesmo proxy) da conta.
  assert.match(create, /webPreferences: \{ partition, sandbox: true, contextIsolation: true \}/);
  // O config:set da interface não muda o proxy por fora do proxy:save.
  assert.match(main, /normalizeConfig\(\{ \.\.\.\(next && typeof next === 'object' \? next : \{\}\), proxy: config\.proxy \}/);
});

// ---------- login do proxy ----------

test('login: usuário e senha só para o proxy configurado, e com limite de tentativas', async (t) => {
  const { m, sec } = makeManager(t, { settings: { ...ON, username: USUARIO } });
  await sec.set(SENHA, { ...ON, username: USUARIO });
  const ours = { isProxy: true, host: 'proxy.exemplo.com', port: 8080, scheme: 'basic' };
  assert.deepEqual(m.credentialsFor(ours, 'tela-1'), { username: USUARIO, password: SENHA });
  assert.equal(m.credentialsFor({ ...ours, isProxy: false }, 'tela-1'), null, 'login de site não recebe a senha do proxy');
  assert.equal(m.credentialsFor({ ...ours, host: 'outro.com' }, 'tela-1'), null);
  assert.equal(m.credentialsFor({ ...ours, port: 3128 }, 'tela-1'), null);
  for (let i = 0; i < 4; i++) assert.ok(m.credentialsFor(ours, 'tela-1'));
  assert.equal(m.credentialsFor(ours, 'tela-1'), null, 'a 6.ª tentativa em 1 minuto é cancelada (senha errada não vira laço)');
  assert.equal(m.authRefused, true);
  assert.ok(m.credentialsFor(ours, 'tela-2'), 'o limite é por tela');
  await m.applyLive([]);
  assert.equal(m.authRefused, false, 'mudar o proxy zera o limite');
});

test('login: sem senha salva ou com proxy desligado, cancela (a requisição falha, não sai direto)', (t) => {
  const ours = { isProxy: true, host: 'proxy.exemplo.com', port: 8080 };
  assert.equal(makeManager(t, { settings: { ...ON, username: USUARIO } }).m.credentialsFor(ours), null);
  assert.equal(makeManager(t, { settings: { ...ON, enabled: false, username: USUARIO } }).m.credentialsFor(ours), null);
  const gate = new proxy.AuthGate({ max: 2, windowMs: 1000, now: () => 0 });
  assert.equal(gate.allow('x'), true);
  assert.equal(gate.allow('x'), true);
  assert.equal(gate.allow('x'), false);
});

// ---------- salvar ----------

test('salvar: guarda a senha fora do config.json, não reexibe e informa onde ficou', async (t) => {
  const dir = tmpDir(t);
  const sec = new ProxySecret(dir, { safeStorage: fakeSafeStorage(), platform: 'linux' });
  const { m, get } = makeManager(t, { secret: sec });
  const r = await m.save({ ...ON, username: USUARIO, password: SENHA });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.deepEqual(get(), { ...ON, username: USUARIO });
  assert.ok(!JSON.stringify(r).includes(SENHA));

  const file = path.join(dir, FILE_NAME);
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw).modo, 'safeStorage');
  assert.ok(!raw.includes(SENHA));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const info = await sec.info();
  assert.deepEqual(Object.keys(info).sort(), ['hasPassword', 'storage', 'storageLabel', 'unreadable']);
  assert.equal(info.hasPassword, true);
  assert.ok(!JSON.stringify(info).includes(SENHA));

  // Carregar de novo (app reiniciado) devolve a mesma senha.
  const again = new ProxySecret(dir, { safeStorage: fakeSafeStorage(), platform: 'linux' });
  await again.load();
  assert.equal(again.getFor({ ...ON, username: USUARIO }), SENHA);

  // Campo vazio mantém a senha; nada mudou = não recarrega as telas.
  assert.equal((await m.save({ ...ON, username: USUARIO, password: '' })).changed, false);
  assert.equal(sec.getFor({ ...ON, username: USUARIO }), SENHA);
  // Apagar a senha exige outra (usuário sem senha não fecha).
  assert.equal((await m.save({ ...ON, username: USUARIO, clearPassword: true })).ok, false);
  // Tirar o usuário apaga a senha guardada.
  assert.equal((await m.save({ ...ON, type: 'socks5' })).ok, true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(sec.has(), false);
});

test('senha: no Linux sem chaveiro (basic_text) fica num arquivo 600, em base64, e isso é dito com clareza', async (t) => {
  for (const ss of [fakeSafeStorage({ backend: 'basic_text' }), fakeSafeStorage({ available: false }), null]) {
    const dir = tmpDir(t);
    const sec = new ProxySecret(dir, { safeStorage: ss, platform: 'linux' });
    await sec.set(SENHA, { ...ON, username: USUARIO });
    const raw = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
    assert.equal(JSON.parse(raw).modo, 'arquivo');
    assert.ok(!raw.includes(SENHA));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, FILE_NAME)).mode & 0o777, 0o600);
    const info = await sec.info();
    assert.equal(info.storage, 'arquivo');
    assert.match(info.storageLabel, /não é criptografia/);
    const again = new ProxySecret(dir, { safeStorage: ss, platform: 'linux' });
    await again.load();
    assert.equal(again.getFor({ ...ON, username: USUARIO }), SENHA);
  }
});

test('senha: Windows usa o safeStorage (DPAPI); senha ilegível vira aviso, não erro com a senha', async (t) => {
  const dir = tmpDir(t);
  await new ProxySecret(dir, { safeStorage: fakeSafeStorage({ backend: 'unknown' }), platform: 'win32' }).set(SENHA, { ...ON, username: USUARIO });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8')).modo, 'safeStorage');
  const broken = new ProxySecret(dir, { safeStorage: fakeSafeStorage({ failDecrypt: true }), platform: 'win32' });
  await broken.load();
  assert.equal(broken.has(), false);
  assert.equal((await broken.info()).unreadable, true);
});

// ---------- Testar proxy ----------

// `net` falso do Electron: cada requisição segue o roteiro `script(url)`.
function fakeNet(script) {
  const seen = [];
  return {
    seen,
    request(opts) {
      const req = new EventEmitter();
      req.abort = () => {};
      req.end = () =>
        setImmediate(async () => {
          seen.push(opts);
          const step = script(opts.url);
          if (step.login) {
            const creds = await new Promise((r) => req.emit('login', step.login, (u, p) => r(u === undefined ? null : { u, p })));
            seen.push({ creds });
            if (!creds) return req.emit('response', Object.assign(new EventEmitter(), { statusCode: 407 }));
          }
          if (step.error) return req.emit('error', new Error(step.error));
          const res = new EventEmitter();
          res.statusCode = step.status || 200;
          req.emit('response', res);
          setImmediate(() => {
            res.emit('data', Buffer.from(step.body || ''));
            res.emit('end');
          });
        });
      return req;
    },
  };
}

test('Testar proxy: mostra o IP de saída visto pelo serviço, pelo proxy do formulário', async (t) => {
  const ses = fakeSession();
  const net = fakeNet(() => ({
    login: { isProxy: true, host: 'proxy.exemplo.com', port: 8080 },
    body: JSON.stringify({ ip: '203.0.113.7', country: 'BR', city: 'São Paulo', org: 'AS0 Provedor Residencial' }),
  }));
  const { m, sec } = makeManager(t, { net, ses });
  await sec.set(SENHA, { ...ON, username: USUARIO });
  const r = await m.test({ type: 'http', host: 'proxy.exemplo.com', port: '8080', username: USUARIO, password: '' });
  assert.deepEqual(r, { ok: true, ip: '203.0.113.7', country: 'BR', region: undefined, city: 'São Paulo', org: 'AS0 Provedor Residencial', servico: 'ipinfo.io' });
  assert.deepEqual(ses.calls[0], ['setProxy', proxy.sessionProxyConfig(ON)], 'o teste usa uma sessão própria com o proxy');
  assert.deepEqual(net.seen[1], { creds: { u: USUARIO, p: SENHA } }, 'senha vazia no formulário = senha salva');
  assert.equal(net.seen[0].session, ses);
  assert.equal(net.seen[0].useSessionCookies, false);
});

test('Testar proxy: login pedido por outro servidor não recebe a senha', async (t) => {
  const net = fakeNet(() => ({ login: { isProxy: true, host: 'outro.com', port: 8080 }, body: '{"ip":"1.1.1.1"}' }));
  const { m } = makeManager(t, { net, ses: fakeSession() });
  const r = await m.test({ type: 'http', host: 'proxy.exemplo.com', port: 8080, username: USUARIO, password: SENHA });
  assert.deepEqual(net.seen[1], { creds: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /407/);
});

test('Testar proxy: erro do proxy vira mensagem clara, sem tentar outro caminho e sem a senha', async (t) => {
  const net = fakeNet(() => ({ error: `net::ERR_PROXY_CONNECTION_FAILED ${SENHA}` }));
  const { m } = makeManager(t, { net, ses: fakeSession() });
  const r = await m.test({ type: 'https', host: 'proxy.exemplo.com', port: 8080, username: USUARIO, password: SENHA });
  assert.equal(r.ok, false);
  assert.match(r.error, /Não consegui conectar ao proxy .*ERR_PROXY_CONNECTION_FAILED/);
  assert.ok(!r.error.includes(SENHA));
  assert.equal(net.seen.length, 1, 'erro de proxy não tenta o segundo serviço (passaria pelo mesmo proxy)');

  const pw = `${SENHA}/+`;
  const net2 = fakeNet(() => ({ error: `falha esquisita com ${pw} e ${encodeURIComponent(pw)}` }));
  const r2 = await makeManager(t, { net: net2, ses: fakeSession() }).m.test({ type: 'http', host: 'a.com', port: 1, username: USUARIO, password: pw });
  assert.ok(!r2.error.includes(pw) && !r2.error.includes(encodeURIComponent(pw)), r2.error);
});

test('Testar proxy: se o serviço de IP falhar, tenta o próximo; socks5 com senha nem tenta', async (t) => {
  const net = fakeNet((url) => (url.includes('ipinfo') ? { status: 429 } : { body: '{"ip":"203.0.113.8"}' }));
  const { m } = makeManager(t, { net, ses: fakeSession() });
  const r = await m.test({ type: 'socks5', host: 'proxy.exemplo.com', port: 1080 });
  assert.equal(r.ok, true);
  assert.equal(r.ip, '203.0.113.8');
  assert.equal(r.servico, 'api.ipify.org');

  const net2 = fakeNet(() => ({ body: '{}' }));
  const r2 = await makeManager(t, { net: net2, ses: fakeSession() }).m.test({ type: 'socks5', host: 'a.com', port: 1080, username: USUARIO, password: SENHA });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, proxy.SOCKS_AUTH_ERROR);
  assert.equal(net2.seen.length, 0);
});

test('Testar proxy: respostas que não são IP são recusadas', () => {
  assert.equal(proxy.parseIpEcho('{"ip":"não é ip"}'), null);
  assert.equal(proxy.parseIpEcho('<html>'), null);
  assert.equal(proxy.parseIpEcho('{"ip":"2001:db8::5"}').ip, '2001:db8::5');
});

// ---------- a senha não aparece em logs ----------

test('logs: nenhuma operação do proxy escreve a senha ou o usuário', async (t) => {
  const written = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => written.push(a.join(' '));
  t.after(() => Object.assign(console, orig));

  const logged = [];
  const ses = fakeSession();
  const net = fakeNet(() => ({ login: { isProxy: true, host: 'proxy.exemplo.com', port: 8080 }, error: 'net::ERR_TUNNEL_CONNECTION_FAILED' }));
  const { m } = makeManager(t, { net, ses, log: (s) => logged.push(s) });
  await m.save({ ...ON, username: USUARIO, password: SENHA });
  await m.applyToSession(ses);
  await m.applyLive([ses]);
  for (let i = 0; i < 8; i++) m.credentialsFor({ isProxy: true, host: 'proxy.exemplo.com', port: 8080 }, 't');
  const r = await m.test({ ...ON, username: USUARIO, password: SENHA });
  await m.save({ ...ON, type: 'socks5', username: USUARIO, password: SENHA }); // erro de validação

  assert.ok(logged.length >= 3, 'o log de diagnóstico foi chamado');
  const all = [...written, ...logged, r.error].join('\n');
  assert.ok(!all.includes(SENHA), 'a senha apareceu no log');
  assert.ok(!all.includes(USUARIO), 'o usuário apareceu no log');
});

test('logs: nenhum console.* do código de proxy recebe senha, usuário ou credenciais', () => {
  const files = ['main.js', 'proxy.js', 'proxy-manager.js', 'proxy-secret.js', 'smoke-proxy.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8');
    for (const call of code.match(/(?:console\.\w+|this\.log|log)\([^;]*\);/g) || [])
      assert.doesNotMatch(call, /password|senha\b|username|creds|secret\.get/i, `${f}: ${call}`);
  }
});

test('interface: o campo de senha nunca é preenchido com a senha salva', () => {
  const ui = fs.readFileSync(path.join(SRC, 'ui', 'app.js'), 'utf8');
  assert.match(ui, /<input type="password" id="p-pass" value="" autocomplete="new-password"/);
  assert.doesNotMatch(ui, /p-pass[^\n]*\.value\s*=/, 'nada escreve no campo de senha');
  const preload = fs.readFileSync(path.join(SRC, 'preload-shell.js'), 'utf8');
  assert.match(preload, /proxyInfo: \(\) => ipcRenderer\.invoke\('proxy:info'\)/);
});

// ---------- senha presa ao proxy em que foi digitada (revisão da Nina) ----------

test('senha: mudar tipo, host, porta ou usuário com a senha em branco pede a senha de novo', async (t) => {
  const { m, sec, get } = makeManager(t);
  assert.equal((await m.save({ ...ON, username: USUARIO, password: SENHA })).ok, true);
  for (const change of [{ host: 'outro.exemplo.com' }, { port: 3128 }, { type: 'https' }, { username: 'outro-usuario' }]) {
    const r = await m.save({ ...ON, username: USUARIO, password: '', ...change });
    assert.deepEqual(r, { ok: false, field: 'password', error: proxy.REBIND_ERROR }, JSON.stringify(change));
    assert.deepEqual(get(), { ...ON, username: USUARIO }, 'nada foi salvo');
  }
  // Com a senha digitada de novo, o destino novo vale e a senha fica presa a ele.
  const outro = { ...ON, host: 'outro.exemplo.com', username: USUARIO };
  assert.equal((await m.save({ ...outro, password: 'outra-senha-de-teste' })).ok, true);
  assert.equal(sec.getFor(outro), 'outra-senha-de-teste');
  assert.equal(sec.getFor({ ...ON, username: USUARIO }), '');
});

test('senha: "Testar proxy" com outro destino não usa a senha salva', async (t) => {
  const net = fakeNet(() => ({ login: { isProxy: true, host: 'outro.exemplo.com', port: 8080 }, body: '{"ip":"203.0.113.9"}' }));
  const { m, sec } = makeManager(t, { net, ses: fakeSession() });
  await sec.set(SENHA, { ...ON, username: USUARIO });
  const r = await m.test({ type: 'http', host: 'outro.exemplo.com', port: 8080, username: USUARIO, password: '' });
  assert.deepEqual(r, { ok: false, field: 'password', error: proxy.REBIND_ERROR });
  assert.equal(net.seen.length, 0, 'nenhuma requisição saiu');
});

test('senha: config.json editado à mão para outro proxy não recebe a senha salva', async (t) => {
  const { m, sec } = makeManager(t, { settings: { ...ON, host: 'outro.exemplo.com', username: USUARIO } });
  await sec.set(SENHA, { ...ON, username: USUARIO });
  assert.equal(m.credentialsFor({ isProxy: true, host: 'outro.exemplo.com', port: 8080 }, 'tela-1'), null);
  assert.equal((await sec.info({ ...ON, host: 'outro.exemplo.com', username: USUARIO })).hasPassword, false);
  assert.equal((await sec.info({ ...ON, username: USUARIO })).hasPassword, true);
});

test('senha: o arquivo guarda o destino; sem destino (ou sem usuário) a senha não é usada', async (t) => {
  const dir = tmpDir(t);
  const sec = new ProxySecret(dir, { safeStorage: null, platform: 'linux' });
  await assert.rejects(sec.set(SENHA, { ...ON }), /sem destino/);
  await sec.set(SENHA, { ...ON, username: USUARIO, enabled: false });
  const data = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), 'utf8'));
  assert.deepEqual(data.destino, { type: 'http', host: 'proxy.exemplo.com', port: 8080, username: USUARIO });
  delete data.destino;
  fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify(data));
  const again = new ProxySecret(dir, { safeStorage: null, platform: 'linux' });
  await again.load();
  assert.equal(again.has(), false);
  assert.equal(again.unreadable, true);
});

test('senha: trocar para outro destino sem usuário apaga a senha antiga', async (t) => {
  const { m, sec } = makeManager(t);
  await m.save({ ...ON, username: USUARIO, password: SENHA });
  assert.equal((await m.save({ ...ON, host: 'outro.exemplo.com' })).ok, true);
  assert.equal(sec.has(), false);
});

// ---------- proxy inválido continua bloqueado depois de reiniciar (revisão da Nina) ----------

test('config.json: proxy inválido gravado continua inválido nas próximas leituras, até um Salvar válido', async (t) => {
  const metas = plugins.meta();
  for (const bad of [{ ...ON, type: 'socks4' }, { ...ON, type: 42 }, { ...ON, username: 'a\nb' }]) {
    let cfg = normalizeConfig({ proxy: bad }, metas);
    for (let i = 0; i < 3; i++) {
      cfg = normalizeConfig(JSON.parse(JSON.stringify(cfg)), metas); // gravou e leu de novo (reinício)
      assert.equal(cfg.proxy.invalid, true, `${JSON.stringify(bad)} leitura ${i + 2}`);
      assert.throws(() => proxy.sessionProxyConfig(cfg.proxy));
    }
  }
  // Salvar pela tela com dados válidos tira a marca.
  const { m, get } = makeManager(t, { settings: { ...ON, invalid: true } });
  const r = await m.save(ON);
  assert.equal(r.changed, true);
  assert.equal(get().invalid, undefined);
});
