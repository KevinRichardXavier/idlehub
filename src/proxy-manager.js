'use strict';

// Aplica o proxy nas sessões das telas de jogo, responde ao login do proxy e faz o "Testar proxy".
// Recebe o que precisa do Electron por parâmetro (`net`, `makeTestSession`) para dar para testar com
// objetos falsos em `node --test` (test/proxy.test.js).
//
// Por onde passa cada coisa (decisão de 22/11/2026, ver README):
// - Telas de jogo (todas as partições de conta, popups de login inclusos, extensões das telas): pelo proxy.
// - "Testar proxy": pelo proxy, numa sessão temporária só dele.
// - Discord (webhook), checagem de atualização e download de extensões: direto, sem proxy.

const {
  validateProxy,
  sessionProxyConfig,
  BLOCK_CONFIG,
  sameSettings,
  isOurProxy,
  REBIND_ERROR,
  AuthGate,
  describeError,
  parseIpEcho,
  proxyRules,
} = require('./proxy');

const ECO_URLS = ['https://ipinfo.io/json', 'https://api.ipify.org?format=json'];
const TEST_TIMEOUT_MS = 15000;
const MAX_BODY = 64 * 1024;

class ProxyManager {
  // secret: ProxySecret. getSettings/setSettings: lê e grava config.proxy. net: o `net` do Electron.
  // makeTestSession: devolve a sessão temporária do "Testar proxy". log: só para diagnóstico, nunca recebe
  // usuário nem senha.
  constructor({ secret, getSettings, setSettings, net = null, makeTestSession = null, log = () => {}, gate = new AuthGate() }) {
    this.secret = secret;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.net = net;
    this.makeTestSession = makeTestSession;
    this.log = log;
    this.gate = gate;
    this.chain = Promise.resolve();
  }

  settings() {
    return this.getSettings();
  }

  // Serializa as chamadas a setProxy: a última configuração pedida é sempre a última aplicada.
  serial(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // Aplica a configuração atual numa sessão. Se não der (proxy ligado mas inválido, ou o setProxy falhou), a
  // sessão inteira é bloqueada antes de rejeitar: a configuração anterior da sessão continuaria valendo para
  // tudo o que usa a mesma partição (popups de login inclusos), então ela é trocada pelo BLOCK_CONFIG e as
  // conexões abertas são derrubadas. Quem chama não pode carregar a tela nesse caso.
  applyToSession(ses) {
    return this.serial(async () => {
      let cfg;
      try {
        cfg = sessionProxyConfig(this.settings());
        await ses.setProxy(cfg);
      } catch (err) {
        await this.blockSession(ses);
        throw err;
      }
      this.log(`[proxy] sessão: ${cfg.mode === 'fixed_servers' ? cfg.proxyRules : cfg.mode}`);
      return cfg;
    });
  }

  // Melhor esforço: cada passo é tentado mesmo se o anterior falhar.
  async blockSession(ses) {
    try {
      await ses.setProxy(BLOCK_CONFIG);
      this.log('[proxy] sessão bloqueada: o proxy não pôde ser aplicado');
    } catch {
      this.log('[proxy] não deu para bloquear a sessão; as janelas dela serão fechadas');
    }
    try {
      await ses.closeAllConnections();
    } catch {
      /* segue: as janelas da sessão são fechadas ou levadas à página sem conexão por quem chamou */
    }
  }

  // Mudança com o app aberto: aplica em cada sessão, derruba as conexões já abertas (que ainda usavam a
  // rota antiga) e esquece a autenticação anterior. Devolve as sessões em que falhou; a tela dessas sessões
  // não pode continuar com a página antiga.
  async applyLive(sessions) {
    this.gate.reset();
    const failed = [];
    for (const ses of new Set(sessions)) {
      try {
        await this.applyToSession(ses);
        await ses.closeAllConnections();
        await ses.clearAuthCache();
      } catch {
        failed.push(ses);
        try {
          await ses.clearAuthCache();
        } catch {
          /* melhor esforço */
        }
      }
    }
    return failed;
  }

  // Login pedido por uma tela de jogo (evento `login` do app). Só responde ao proxy configurado, e no
  // máximo algumas vezes por minuto por tela (senha errada não vira laço).
  credentialsFor(authInfo, key = 'sem-tela') {
    const p = this.settings();
    if (!isOurProxy(p, authInfo)) return null;
    const password = this.secret.getFor(p); // só a senha salva para este mesmo proxy e usuário
    if (!p.username || !password) return null;
    if (!this.gate.allow(key)) return null;
    return { username: p.username, password };
  }

  get authRefused() {
    return this.gate.refused;
  }

  // Valida o formulário considerando a senha salva só se ela for do mesmo destino (tipo, host, porta e
  // usuário). Destino diferente com senha em branco = pedir a senha de novo.
  validate(input, { requireEnabled = false } = {}) {
    const opts = { requireEnabled };
    const draft = validateProxy(input, { ...opts, hasSavedPassword: true });
    if (!draft.ok) return draft;
    const savedOk = input?.clearPassword !== true && this.secret.hasFor(draft.value);
    const res = validateProxy(input, { ...opts, hasSavedPassword: savedOk });
    if (!res.ok && res.field === 'password' && this.secret.has() && !savedOk && input?.clearPassword !== true)
      return { ok: false, field: 'password', error: REBIND_ERROR };
    return res.ok ? { ...res, savedPassword: savedOk ? this.secret.getFor(res.value) : '' } : res;
  }

  // Salva o que veio da tela de configurações. Retorna { ok, changed, settings } ou { ok: false, field, error }.
  async save(input) {
    const res = this.validate(input);
    if (!res.ok) return res;
    const next = res.value;
    const before = this.settings();
    const typed = typeof input.password === 'string' ? input.password : '';
    let passwordChanged = false;
    if (next.username && typed) {
      if (typed !== res.savedPassword) {
        await this.secret.set(typed, next);
        passwordChanged = true;
      }
    } else if (!res.savedPassword && (this.secret.has() || this.secret.unreadable)) {
      // Sem usuário, "Apagar a senha salva" ou senha de outro destino: não fica senha órfã guardada.
      this.secret.clear();
      passwordChanged = true;
    }
    const changed = passwordChanged || !sameSettings(before, next);
    if (changed) {
      this.setSettings(next);
      this.gate.reset();
    }
    return { ok: true, changed, settings: next };
  }

  // "Testar proxy": usa os valores do formulário (mesmo antes de salvar). Senha vazia = a senha salva, só
  // se o formulário for o mesmo proxy e usuário em que ela foi salva.
  // Retorna { ok: true, ip, country, region, city, org, servico } ou { ok: false, error }.
  async test(input, { ecoUrls = ECO_URLS, timeoutMs = TEST_TIMEOUT_MS } = {}) {
    const typed = typeof input?.password === 'string' ? input.password : '';
    const res = this.validate({ ...input, enabled: true }, { requireEnabled: true });
    if (!res.ok) return { ok: false, field: res.field, error: res.error };
    const p = res.value;
    const password = typed || res.savedPassword;
    const creds = p.username && password ? { username: p.username, password } : null;
    const secrets = [password, p.username].filter(Boolean);
    if (!this.net || !this.makeTestSession) return { ok: false, error: 'Teste de proxy indisponível.' };

    let ses;
    try {
      ses = await this.makeTestSession();
      await ses.setProxy(sessionProxyConfig(p));
      await ses.closeAllConnections();
      await ses.clearAuthCache();
    } catch (err) {
      return { ok: false, error: describeError(err, secrets) };
    }
    this.log(`[proxy] testando ${proxyRules(p)}`);

    let lastError = null;
    for (const url of ecoUrls) {
      try {
        const body = await requestText(this.net, ses, url, (authInfo) => (creds && isOurProxy(p, authInfo) ? creds : null), timeoutMs);
        const info = parseIpEcho(body);
        if (info) return { ok: true, ...info, servico: new URL(url).hostname };
        lastError = Object.assign(new Error('O serviço de IP respondeu algo inesperado.'), { servico: true });
      } catch (err) {
        lastError = err;
        if (!err.servico) break; // erro do proxy: o próximo serviço passaria pelo mesmo proxy
      }
    }
    return { ok: false, error: describeError(lastError, secrets) };
  }
}

// GET simples pelo `net` do Electron, na sessão dada (e portanto pelo proxy dela). `credsFor(authInfo)`
// devolve { username, password } para o login do proxy, uma vez só.
function requestText(net, ses, url, credsFor, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let asked = false;
    let req = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        try {
          req?.abort();
        } catch {
          /* já terminou */
        }
        reject(err);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('net::ERR_TIMED_OUT')), timeoutMs);
    try {
      req = net.request({ url, session: ses, useSessionCookies: false, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    } catch (err) {
      finish(err);
      return;
    }
    req.on('login', (authInfo, callback) => {
      const creds = !asked && authInfo?.isProxy ? credsFor(authInfo) : null;
      asked = true;
      if (creds) callback(creds.username, creds.password);
      else callback();
    });
    req.on('response', (res) => {
      if (res.statusCode === 407) return finish(new Error('HTTP 407'));
      if (res.statusCode !== 200)
        return finish(Object.assign(new Error(`O serviço de IP respondeu HTTP ${res.statusCode}.`), { servico: true }));
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) finish(Object.assign(new Error('Resposta grande demais do serviço de IP.'), { servico: true }));
        else chunks.push(Buffer.from(c));
      });
      res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      res.on('error', (err) => finish(err));
    });
    req.on('error', (err) => finish(err));
    req.end();
  });
}

module.exports = { ProxyManager, requestText, ECO_URLS };
