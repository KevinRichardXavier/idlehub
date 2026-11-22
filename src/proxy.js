'use strict';

// Proxy das telas de jogo: validação dos campos, regras para o Chromium, política de WebRTC, controle das
// tentativas de login no proxy e mensagens de erro. Funções puras (sem Electron) para testar com
// `node --test`; quem aplica nas sessões é src/proxy-manager.js.
//
// O que o Chromium (motor do Electron) faz, conferido em 22/11/2026 em
// https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md:
// - Lista fixa de proxies sem "direct://": se o proxy cair, a requisição falha com
//   ERR_PROXY_CONNECTION_FAILED. Nunca sai direto. Por isso a regra gerada aqui nunca tem "direct://".
// - "No authentication methods are supported for SOCKSv5 in Chrome": socks5 com usuário e senha não
//   funciona. A validação recusa essa combinação com uma mensagem clara.
// - Credenciais escritas na regra (usuário:senha@host) são ignoradas. Usuário e senha de proxy http/https
//   vão pelo evento `login` do Electron.
// - socks5: o nome do site é resolvido pelo próprio proxy (DNS do lado do proxy).
// - https:// = proxy HTTP com a conexão até o proxy protegida por TLS.
// - "<-loopback>" tira a exceção implícita de localhost: até 127.0.0.1 passa pelo proxy.

const net = require('node:net');

const PROXY_TYPES = ['http', 'https', 'socks5'];
const MAX_CRED = 256;
const BYPASS_RULES = '<-loopback>';
const WEBRTC_POLICY_ON = 'disable_non_proxied_udp';
const WEBRTC_POLICY_OFF = 'default';

const SOCKS_AUTH_ERROR =
  'O Chromium (motor do Electron) não suporta socks5 com usuário e senha. Use o endereço http ou https do ' +
  'seu provedor, ou libere o IP desta máquina no painel do provedor e deixe usuário e senha vazios.';
const REBIND_ERROR =
  'O tipo, o host, a porta ou o usuário do proxy mudou: digite a senha de novo. A senha salva só vale para o proxy em que foi digitada.';

function defaultProxy() {
  return { enabled: false, type: 'http', host: '', port: 0, username: '' };
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

// Aceita nome (proxy.exemplo.com), IPv4 ou IPv6 (com ou sem colchetes). Devolve o host normalizado ou null.
function normalizeHost(raw) {
  if (typeof raw !== 'string') return null;
  let h = raw.trim();
  if (!h || h.length > 255) return null;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIP(h) === 6) return h.toLowerCase();
  if (net.isIP(h) === 4) return h;
  if (HOSTNAME_RE.test(h) && !/^\d+(\.\d+)*$/.test(h)) return h.toLowerCase().replace(/\.$/, '');
  return null;
}

function normalizePort(raw) {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

// eslint-disable-next-line no-control-regex
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);

// Valida o que veio da tela de configurações (ou do "Testar proxy").
// `input`: { enabled, type, host, port, username, password, clearPassword }.
// `hasSavedPassword`: existe senha guardada e ela vai continuar valendo se o campo vier vazio.
// Retorna { ok: true, value } (value sem a senha) ou { ok: false, field, error }. A mensagem de erro nunca
// repete o que foi digitado.
function validateProxy(input, { hasSavedPassword = false, requireEnabled = false } = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const enabled = requireEnabled || src.enabled === true;
  const type = typeof src.type === 'string' ? src.type.trim().toLowerCase() : '';
  if (!PROXY_TYPES.includes(type)) return { ok: false, field: 'type', error: 'Escolha o tipo do proxy: http, https ou socks5.' };

  const hostRaw = typeof src.host === 'string' ? src.host.trim() : '';
  const portRaw = src.port === undefined || src.port === null ? '' : String(src.port).trim();
  const username = typeof src.username === 'string' ? src.username.trim() : '';
  const password = typeof src.password === 'string' ? src.password : '';
  const clearPassword = src.clearPassword === true;

  // Desligado e sem nada preenchido: pode salvar assim.
  if (!enabled && !hostRaw && !portRaw && !username && !password)
    return { ok: true, value: { ...defaultProxy(), type } };

  if (!hostRaw) return { ok: false, field: 'host', error: 'Informe o host do proxy (ex.: proxy.exemplo.com).' };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(hostRaw))
    return { ok: false, field: 'host', error: 'No host vai só o nome ou IP, sem "http://" ou "socks5://": o tipo é escolhido ao lado.' };
  if (hostRaw.includes('@'))
    return { ok: false, field: 'host', error: 'No host vai só o nome ou IP. Usuário e senha têm campos próprios.' };
  const host = normalizeHost(hostRaw);
  if (!host) return { ok: false, field: 'host', error: 'Host do proxy inválido. Use um nome (proxy.exemplo.com) ou um IP.' };

  const port = normalizePort(portRaw);
  if (port === null) return { ok: false, field: 'port', error: 'Porta do proxy inválida: use um número de 1 a 65535.' };

  if (username.length > MAX_CRED || hasControl(username))
    return { ok: false, field: 'username', error: `Usuário do proxy inválido (até ${MAX_CRED} caracteres, sem quebras de linha).` };
  if (password.length > MAX_CRED || hasControl(password))
    return { ok: false, field: 'password', error: `Senha do proxy inválida (até ${MAX_CRED} caracteres, sem quebras de linha).` };

  // A senha salva só conta se houver usuário (sem usuário ela é apagada ao salvar).
  const willHavePassword = !!password || (hasSavedPassword && !clearPassword && !!username);
  if (type === 'socks5' && (username || willHavePassword)) {
    return { ok: false, field: username ? 'username' : 'password', error: SOCKS_AUTH_ERROR };
  }
  if (password && !username) return { ok: false, field: 'username', error: 'Informe o usuário do proxy junto com a senha.' };
  if (username && !willHavePassword) return { ok: false, field: 'password', error: 'Informe a senha do proxy junto com o usuário.' };

  return { ok: true, value: { enabled, type, host, port, username } };
}

// Lê o que está em config.json sem nunca transformar "ligado" em "desligado": se o proxy estava ligado e
// os campos não fecham, ele continua ligado e marcado como inválido, e as telas ficam sem conexão até
// alguém corrigir (desligar sozinho faria as telas saírem pelo IP direto).
function normalizeProxy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = src.enabled === true;
  const type = PROXY_TYPES.includes(src.type) ? src.type : 'http';
  const host = normalizeHost(typeof src.host === 'string' ? src.host : '') || '';
  const port = normalizePort(src.port) || 0;
  const username = typeof src.username === 'string' && src.username.length <= MAX_CRED && !hasControl(src.username) ? src.username : '';
  const out = { enabled, type, host, port, username };
  if (enabled) {
    const typeOk = PROXY_TYPES.includes(src.type);
    const userOk = (src.username ?? '') === username;
    // `invalid` gravado antes continua valendo: a normalização troca um tipo desconhecido por http, e sem
    // isso a próxima leitura aceitaria o proxy "consertado" sozinho. Só o Salvar (validateProxy) limpa.
    if (!typeOk || !host || !port || !userOk || (type === 'socks5' && username) || src.invalid === true) out.invalid = true;
  }
  return out;
}

const hostForRules = (host) => (net.isIP(host) === 6 ? `[${host}]` : host);

function proxyRules(p) {
  return `${p.type}://${hostForRules(p.host)}:${p.port}`;
}

// Configuração para session.setProxy(). Desligado = "system" (o mesmo que o app fazia antes do proxy).
// Ligado: um único proxy, sem "direct://" e sem a exceção de localhost.
function sessionProxyConfig(p) {
  if (!p || !p.enabled) return { mode: 'system' };
  if (p.invalid || !PROXY_TYPES.includes(p.type) || !p.host || !p.port) throw new Error('proxy ligado com configuração inválida');
  return { mode: 'fixed_servers', proxyRules: proxyRules(p), proxyBypassRules: BYPASS_RULES };
}

// Bloqueio da sessão: usado quando a configuração não pôde ser aplicada. Tudo vai para um proxy local que não
// existe (porta 9, discard), sem `direct://` e sem exceção nem para o loopback: nenhuma página da sessão
// (tela, popup de login, extensão) sai pela rota antiga nem direto; tudo falha com erro de proxy.
const BLOCK_CONFIG = Object.freeze({ mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9', proxyBypassRules: BYPASS_RULES });

// WebRTC: com o proxy ligado, nada de UDP fora do proxy (o WebRTC não expõe o IP real nem os IPs locais).
const webRtcPolicy = (p) => (p && p.enabled ? WEBRTC_POLICY_ON : WEBRTC_POLICY_OFF);

const sameSettings = (a, b) =>
  ['enabled', 'type', 'host', 'port', 'username', 'invalid'].every((k) => (a?.[k] ?? null) === (b?.[k] ?? null));

// Mesmo destino para a senha salva: tipo, host, porta e usuário. A senha só vale para o proxy em que foi
// digitada; mudar qualquer um desses exige digitá-la de novo (nunca vai para outro servidor).
const DEST_KEYS = ['type', 'host', 'port', 'username'];
const destinationOf = (p) => Object.fromEntries(DEST_KEYS.map((k) => [k, p?.[k] ?? null]));
const sameDestination = (a, b) => !!a && !!b && DEST_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));

// O pedido de login veio do proxy que o app configurou? (Nunca entrega a senha a outro servidor.)
function isOurProxy(p, authInfo) {
  if (!p || !p.enabled || p.invalid || !authInfo || authInfo.isProxy !== true) return false;
  const host = normalizeHost(String(authInfo.host || ''));
  return host === p.host && Number(authInfo.port) === p.port;
}

// Limita as respostas automáticas ao login do proxy. Com a senha certa o Chromium guarda a autenticação
// na sessão e não pergunta de novo; se ele continua perguntando, a senha está errada, e responder para
// sempre viraria um laço. Depois de `max` pedidos em `windowMs` para a mesma tela, cancela (a requisição
// falha com 407; nunca sai direto).
class AuthGate {
  constructor({ max = 5, windowMs = 60000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
    this.refused = false;
  }

  allow(key) {
    const t = this.now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      this.refused = true;
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    return true;
  }

  reset() {
    this.hits.clear();
    this.refused = false;
  }
}

// Troca qualquer trecho secreto por "***" (usado em toda mensagem de erro que sai do processo principal).
function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < 1) continue;
    out = out.split(s).join('***');
    try {
      const enc = encodeURIComponent(s);
      if (enc !== s) out = out.split(enc).join('***');
    } catch {
      /* ignora */
    }
  }
  return out;
}

const NET_ERRORS = {
  ERR_PROXY_CONNECTION_FAILED: 'Não consegui conectar ao proxy (host ou porta errados, ou o proxy está fora do ar).',
  ERR_TUNNEL_CONNECTION_FAILED: 'O proxy aceitou a conexão mas não abriu o caminho até o site (confira o tipo, usuário e senha).',
  ERR_PROXY_AUTH_UNSUPPORTED: 'O proxy pediu um tipo de autenticação que o Chromium não suporta.',
  ERR_PROXY_AUTH_REQUESTED: 'O proxy pediu usuário e senha.',
  ERR_SOCKS_CONNECTION_FAILED: 'O proxy socks5 recusou a conexão (ele pode exigir usuário e senha, que o Chromium não suporta em socks5).',
  ERR_SOCKS_CONNECTION_HOST_UNREACHABLE: 'O proxy socks5 não alcançou o site.',
  ERR_PROXY_CERTIFICATE_INVALID: 'O certificado TLS do proxy https é inválido.',
  ERR_SSL_PROTOCOL_ERROR: 'Falha de TLS: confira se o proxy é mesmo https (e não http).',
  ERR_NAME_NOT_RESOLVED: 'O nome do proxy não existe (confira o host).',
  ERR_NAME_RESOLUTION_FAILED: 'O nome do proxy não existe (confira o host).',
  ERR_CONNECTION_REFUSED: 'Conexão recusada.',
  ERR_CONNECTION_RESET: 'A conexão foi derrubada no meio.',
  ERR_EMPTY_RESPONSE: 'O proxy fechou a conexão sem responder (confira o tipo: http, https ou socks5).',
  ERR_TIMED_OUT: 'Tempo esgotado esperando o proxy.',
  ERR_CONNECTION_TIMED_OUT: 'Tempo esgotado esperando o proxy.',
  ERR_INTERNET_DISCONNECTED: 'Sem internet nesta máquina.',
};

// Mensagem em pt-BR para um erro de rede, sem nenhum segredo.
function describeError(err, secrets = []) {
  const raw = String(err?.message || err || 'erro desconhecido');
  const code = (raw.match(/ERR_[A-Z0-9_]+/) || [])[0];
  if (code && NET_ERRORS[code]) return `${NET_ERRORS[code]} (${code})`;
  if (/\b407\b/.test(raw)) return 'O proxy recusou o usuário ou a senha (HTTP 407).';
  return redact(raw, secrets).slice(0, 300);
}

// Resposta do serviço que devolve o IP de saída (ipinfo.io/json ou api.ipify.org?format=json).
function parseIpEcho(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data.ip !== 'string' || !net.isIP(data.ip.trim())) return null;
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : undefined);
  return { ip: data.ip.trim(), country: s(data.country), region: s(data.region), city: s(data.city), org: s(data.org) };
}

module.exports = {
  PROXY_TYPES,
  BYPASS_RULES,
  WEBRTC_POLICY_ON,
  WEBRTC_POLICY_OFF,
  SOCKS_AUTH_ERROR,
  REBIND_ERROR,
  defaultProxy,
  normalizeHost,
  normalizePort,
  validateProxy,
  normalizeProxy,
  proxyRules,
  sessionProxyConfig,
  BLOCK_CONFIG,
  webRtcPolicy,
  sameSettings,
  destinationOf,
  sameDestination,
  isOurProxy,
  AuthGate,
  redact,
  describeError,
  parseIpEcho,
};
