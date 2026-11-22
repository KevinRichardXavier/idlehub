'use strict';

// Parte do teste de fumaça (--teste-fumaca) que prova o proxy no Chromium de verdade, sem internet.
//
// Sobe três servidores só em 127.0.0.1, dentro do próprio processo:
// - "direto": um site comum. Se alguma requisição chegar nele, houve conexão direta (vazamento) e o teste
//   reprova. Ele só é alcançável direto: os proxies de teste respondem por ele.
// - proxy http com usuário e senha (Basic): responde ele mesmo, com a página "VIA-PROXY" ou o IP de teste.
// - proxy socks5 sem autenticação: responde ele mesmo, com a página "VIA-SOCKS".
//
// Com o proxy configurado pela mesma função do botão Salvar, a tela de jogo de teste (sandbox: true) abre o
// endereço do site "direto". Passa se a página vier do proxy, se o login do proxy funcionou pelo evento
// `login`, se o "Testar proxy" mostrar o IP do proxy, se com o proxy fora do ar a tela ficar sem conexão,
// se a senha errada não virar laço e se o site "direto" nunca for tocado. Confere também onde a senha ficou
// guardada e que ela não apareceu na saída do app. A senha é gerada na hora (não é senha de verdade).

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { FILE_NAME } = require('./proxy-secret');

const USER = 'fumaca';
const ECO_IP = '203.0.113.10'; // TEST-NET-3 (RFC 5737): nunca é um IP de verdade
const STEP_MS = 10000;
const HOST = '127.0.0.1';

const html = (title) => `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${title}</p>`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve(server.address().port));
  });
}

async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

function directServer() {
  const st = { hits: 0 };
  st.server = http.createServer((req, res) => {
    st.hits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html('DIRETO'));
  });
  return st;
}

function httpProxy(password) {
  const st = { authed: 0, noAuth: 0, badAuth: 0 };
  const expected = `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}`;
  st.server = http.createServer((req, res) => {
    const got = req.headers['proxy-authorization'];
    if (got !== expected) {
      if (got) st.badAuth++;
      else st.noAuth++;
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="idlehub-fumaca"', 'content-type': 'text/html' });
      return res.end(html('PROXY-407'));
    }
    st.authed++;
    if (/\/ip(\?|$)/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ip: ECO_IP, org: 'proxy do teste de fumaça' }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html('VIA-PROXY'));
  });
  st.server.on('connect', (_req, sock) => sock.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'));
  return st;
}

// SOCKS5 mínimo (RFC 1928), só o método "sem autenticação" e CONNECT. Depois do CONNECT ele mesmo responde
// como o site pedido.
function socksProxy() {
  const st = { hits: 0, authOffered: [] };
  st.server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let stage = 0;
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2 || buf.length < 2 + buf[1]) return;
        const methods = [...buf.subarray(2, 2 + buf[1])];
        st.authOffered.push(methods);
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(0)) return sock.end(Buffer.from([5, 0xff]));
        sock.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const len = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buf[4];
        if (buf.length < 4 + len + 2) return;
        buf = buf.subarray(4 + len + 2);
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        stage = 2;
      }
      if (stage === 2 && buf.includes('\r\n\r\n')) {
        st.hits++;
        const body = html('VIA-SOCKS');
        sock.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        stage = 3;
      }
    });
  });
  return st;
}

const withTimeout = (p, ms, what) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`tempo esgotado: ${what}`), { code: 'TEMPO' })), ms))]);

// Abre `url` na tela e diz o que apareceu: { ok: true, title } ou { ok: false, code }.
async function load(wc, url) {
  try {
    await withTimeout(wc.loadURL(url), STEP_MS, 'carregar a tela');
    const title = await withTimeout(wc.executeJavaScript('document.title'), STEP_MS, 'ler a tela');
    return { ok: true, title };
  } catch (err) {
    return { ok: false, code: err.code || err.message };
  }
}

// Guarda tudo o que o app escreve na saída, para conferir que nenhuma senha apareceu.
function captureOutput() {
  const chunks = [];
  const orig = { out: process.stdout.write, err: process.stderr.write };
  const wrap = (stream, original) =>
    function (chunk, ...rest) {
      try {
        chunks.push(String(chunk));
      } catch {
        /* ignora */
      }
      return original.call(stream, chunk, ...rest);
    };
  process.stdout.write = wrap(process.stdout, orig.out);
  process.stderr.write = wrap(process.stderr, orig.err);
  return {
    text: () => chunks.join(''),
    stop: () => {
      process.stdout.write = orig.out;
      process.stderr.write = orig.err;
    },
  };
}

// manager: ProxyManager. saveProxy(input): o mesmo caminho do botão Salvar (valida, guarda e reaplica nas
// sessões abertas, recarregando as telas). panelWc(): webContents da tela de jogo de teste. dir: pasta de dados
// (temporária). ctx: contexto do teste de fumaça (allowed = origens locais liberadas na trava de rede).
// Retorna { problems, report } (report sem segredo).
async function run({ manager, saveProxy, panelWc, dir, ctx }) {
  const problems = [];
  const report = {};
  const password = crypto.randomBytes(12).toString('hex');
  const wrongPassword = `errada-${crypto.randomBytes(6).toString('hex')}`;
  const out = captureOutput();
  const direct = directServer();
  const hp = httpProxy(password);
  const sp = socksProxy();
  try {
    const [dPort, hPort, sPort, deadPort] = [await listen(direct.server), await listen(hp.server), await listen(sp.server), await freePort()];
    const site = `http://${HOST}:${dPort}`;
    ctx.allowed.push(site); // a trava de rede do teste deixa passar só este endereço local
    const wc = panelWc();
    if (!wc) return { problems: ['proxy: a tela de jogo de teste não existe'], report };

    // 1. http com usuário e senha, aplicado pela mesma função do botão Salvar.
    let r = await saveProxy({ enabled: true, type: 'http', host: HOST, port: hPort, username: USER, password });
    if (!r.ok) problems.push(`proxy http: não salvou (${r.error})`);
    report.rota = await wc.session.resolveProxy(`${site}/`);
    if (report.rota !== `PROXY ${HOST}:${hPort}`) problems.push(`proxy http: a sessão da tela não usa o proxy (${report.rota})`);
    report.webrtc = wc.getWebRTCIPHandlingPolicy();
    if (report.webrtc !== 'disable_non_proxied_udp') problems.push(`proxy: política de WebRTC ${report.webrtc}, esperava disable_non_proxied_udp`);
    let page = await load(wc, `${site}/pagina`);
    report.http = page;
    if (page.title !== 'VIA-PROXY') problems.push(`proxy http: a tela não carregou pelo proxy (${JSON.stringify(page)})`);
    if (hp.authed < 1) problems.push('proxy http: o login do proxy (evento login) não entregou usuário e senha');

    // Onde a senha ficou.
    const secretFile = path.join(dir, FILE_NAME);
    if (!fs.existsSync(secretFile)) problems.push('senha do proxy: proxy-senha.json não foi criado');
    else {
      const raw = fs.readFileSync(secretFile, 'utf8');
      report.senha = { modo: JSON.parse(raw).modo };
      if (raw.includes(password)) problems.push('senha do proxy: aparece em texto puro em proxy-senha.json');
      if (process.platform !== 'win32') {
        report.senha.permissao = (fs.statSync(secretFile).mode & 0o777).toString(8);
        if (report.senha.permissao !== '600') problems.push(`senha do proxy: permissão ${report.senha.permissao}, esperava 600`);
      }
    }
    const configJson = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    if (configJson.includes(password)) problems.push('senha do proxy: aparece no config.json');

    // 2. "Testar proxy": sessão própria, login pelo ClientRequest, senha salva.
    let t = await manager.test({ type: 'http', host: HOST, port: hPort, username: USER, password: '' }, { ecoUrls: [`${site}/ip`], timeoutMs: STEP_MS });
    report.testar = t.ok ? { ok: true, ip: t.ip } : t;
    if (!t.ok || t.ip !== ECO_IP) problems.push(`Testar proxy: esperava o IP ${ECO_IP} do proxy, veio ${JSON.stringify(report.testar)}`);

    // 3. socks5 sem autenticação.
    r = await saveProxy({ enabled: true, type: 'socks5', host: HOST, port: sPort, username: '', password: '' });
    if (!r.ok) problems.push(`proxy socks5: não salvou (${r.error})`);
    page = await load(wc, `${site}/pagina`);
    report.socks5 = page;
    if (page.title !== 'VIA-SOCKS') problems.push(`proxy socks5: a tela não carregou pelo proxy (${JSON.stringify(page)})`);
    if (fs.existsSync(secretFile)) problems.push('senha do proxy: continuou guardada depois de tirar o usuário');

    // 4. Proxy fora do ar: a tela fica sem conexão, não sai direto.
    r = await saveProxy({ enabled: true, type: 'http', host: HOST, port: deadPort, username: '', password: '' });
    if (!r.ok) problems.push(`proxy fora do ar: não salvou (${r.error})`);
    page = await load(wc, `${site}/pagina`);
    report.foraDoAr = page;
    if (page.ok || !/PROXY_CONNECTION_FAILED/.test(String(page.code)))
      problems.push(`proxy fora do ar: esperava ERR_PROXY_CONNECTION_FAILED, veio ${JSON.stringify(page)}`);
    t = await manager.test({ type: 'http', host: HOST, port: deadPort }, { ecoUrls: [`${site}/ip`], timeoutMs: STEP_MS });
    report.testarForaDoAr = t.ok ? t : { ok: false };
    if (t.ok) problems.push('Testar proxy: passou com o proxy fora do ar');

    // 5. Senha errada: o app desiste depois de algumas tentativas (sem laço) e não sai direto.
    r = await saveProxy({ enabled: true, type: 'http', host: HOST, port: hPort, username: USER, password: wrongPassword });
    if (!r.ok) problems.push(`proxy com senha errada: não salvou (${r.error})`);
    const before = hp.badAuth;
    page = await load(wc, `${site}/pagina`);
    report.senhaErrada = { ...page, tentativas: hp.badAuth - before, recusado: manager.authRefused };
    if (page.ok && page.title !== 'PROXY-407') problems.push(`proxy com senha errada: a tela mostrou ${JSON.stringify(page)}`);
    if (hp.badAuth - before < 1 || hp.badAuth - before > 12)
      problems.push(`proxy com senha errada: ${hp.badAuth - before} tentativas de login (esperava de 1 a 12)`);

    // Nada pode ter chegado direto ao site.
    report.acessosDiretos = direct.hits;
    if (direct.hits !== 0) problems.push(`vazamento: o site de teste recebeu ${direct.hits} acesso(s) direto(s), fora do proxy`);
  } catch (err) {
    problems.push(`proxy: erro ${err.message}`);
  } finally {
    out.stop();
    for (const s of [direct, hp, sp]) {
      try {
        s.server.close();
        s.server.closeAllConnections?.();
      } catch {
        /* já fechado */
      }
    }
  }
  const text = out.text();
  if (text.includes(password) || text.includes(wrongPassword)) problems.push('senha do proxy: apareceu na saída do app (log)');
  return { problems, report };
}

module.exports = { run, ECO_IP, USER };
