'use strict';

// Extensões do Chrome baixadas direto da Chrome Web Store.
//
// O IdleHub pergunta à Web Store qual é a versão atual (a mesma API que o Chrome usa), baixa o .crx,
// confere o SHA-256 informado pela loja, descompacta numa pasta de cache e carrega essa pasta na
// sessão de cada painel. Com cache, a inicialização não espera a rede: a versão nova baixada em
// segundo plano entra na próxima vez que o app abrir.
//
// Este módulo não depende do Electron (dá para testar com `node --test`).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const CATALOG = [
  {
    id: 'mhnplloljgchpfpcpbhmcokmnefodjnh',
    name: 'Hunt for PokeIdle',
    description: 'Mostra no PokeIdle as melhores hunts por XP/h e ouro/h.',
    url: 'https://chromewebstore.google.com/detail/mhnplloljgchpfpcpbhmcokmnefodjnh',
    defaultOn: true,
  },
];

const UPDATE_URL = 'https://clients2.google.com/service/update2/crx';
const MAX_CRX_BYTES = 30 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const VERSION_RE = /^\d+(?:\.\d+){0,3}$/;

const catalogMeta = () => CATALOG.map(({ id, name, description, url }) => ({ id, name, description, url }));

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Resposta do protocolo update2: <app appid="..." status="ok"><updatecheck codebase=".." version=".." hash_sha256=".." status="ok"/></app>
function parseUpdateXml(xml, id) {
  const app = new RegExp(`<app\\b[^>]*appid="${id}"[^>]*>([\\s\\S]*?)</app>`).exec(String(xml));
  const tag = app && /<updatecheck\b([^>]*)\/?>/.exec(app[1]);
  if (!tag) return null;
  const attr = (name) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag[1]);
    return m ? m[1].replace(/&amp;/g, '&') : null;
  };
  if (attr('status') !== 'ok') return null;
  const version = attr('version');
  const codebase = attr('codebase');
  const sha256 = (attr('hash_sha256') || '').toLowerCase();
  if (!version || !VERSION_RE.test(version) || !codebase || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!/^https:\/\//i.test(codebase)) return null;
  return { version, codebase, sha256 };
}

// .crx = cabeçalho ("Cr24" + versão + assinaturas) seguido de um .zip comum.
function crxToZip(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'Cr24') throw new Error('arquivo .crx inválido');
  const version = buf.readUInt32LE(4);
  let start;
  if (version === 3) start = 12 + buf.readUInt32LE(8);
  else if (version === 2) start = 16 + buf.readUInt32LE(8) + buf.readUInt32LE(12);
  else throw new Error(`versão de .crx não suportada: ${version}`);
  if (start >= buf.length) throw new Error('arquivo .crx truncado');
  return buf.subarray(start);
}

// Lê um .zip (stored/deflate, sem zip64). Retorna [{ name, data }] só com arquivos.
function readZip(zip) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip inválido');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip corrompido');
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;

    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('zip corrompido');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataStart, dataStart + compSize);
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new Error('extensão grande demais');
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: size || 1 });
    else throw new Error(`compressão de zip não suportada: ${method}`);
    if (data.length !== size) throw new Error('zip corrompido');
    files.push({ name, data });
  }
  return files;
}

// Caminho relativo seguro dentro da pasta da extensão, ou null para ignorar.
function safeEntryPath(name) {
  const parts = name.replace(/\\/g, '/').split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..' || /[:*?"<>|]/.test(s))) return undefined;
  // O Chrome recusa carregar extensão descompactada com nomes começando por "_" (_metadata é da loja).
  if (parts[0] === '_metadata') return null;
  return parts.join(path.sep);
}

function extractCrx(crx, destDir) {
  const files = readZip(crxToZip(crx));
  if (!files.some((f) => f.name === 'manifest.json')) throw new Error('extensão sem manifest.json');
  for (const f of files) {
    const rel = safeEntryPath(f.name);
    if (rel === undefined) throw new Error(`caminho inválido no pacote: ${f.name}`);
    if (rel === null) continue;
    const out = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data);
  }
}

class ExtensionStore {
  constructor(dir, { chromeVersion = '140.0.0.0', fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
    this.dir = dir;
    this.chromeVersion = chromeVersion;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  #extDir(id) {
    if (!/^[a-p]{32}$/.test(id)) throw new Error(`id de extensão inválido: ${id}`);
    return path.join(this.dir, id);
  }

  // Versão mais nova já descompactada no cache.
  cached(id) {
    let names;
    try {
      names = fs.readdirSync(this.#extDir(id));
    } catch {
      return null;
    }
    const versions = names
      .filter((v) => VERSION_RE.test(v) && fs.existsSync(path.join(this.#extDir(id), v, 'manifest.json')))
      .sort(compareVersions);
    const version = versions.at(-1);
    return version ? { version, path: path.join(this.#extDir(id), version) } : null;
  }

  // Apaga versões antigas e sobras de downloads interrompidos.
  prune(id, keepVersion) {
    let names;
    try {
      names = fs.readdirSync(this.#extDir(id));
    } catch {
      return;
    }
    for (const n of names)
      if (n !== keepVersion) fs.rmSync(path.join(this.#extDir(id), n), { recursive: true, force: true });
  }

  async #get(url) {
    const res = await this.fetch(url, { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  // Consulta a loja e baixa a versão nova, se houver. Retorna a versão em cache resultante.
  async update(id) {
    const current = this.cached(id);
    const q = `id=${id}&uc`;
    const checkUrl =
      `${UPDATE_URL}?response=updatecheck&acceptformat=crx3,crx2` +
      `&prodversion=${encodeURIComponent(this.chromeVersion)}&x=${encodeURIComponent(q)}`;
    const info = parseUpdateXml(await (await this.#get(checkUrl)).text(), id);
    if (!info) throw new Error('a Chrome Web Store não ofereceu a extensão');
    if (current && compareVersions(current.version, info.version) >= 0) return current;

    const res = await this.#get(info.codebase);
    const crx = Buffer.from(await res.arrayBuffer());
    if (crx.length > MAX_CRX_BYTES) throw new Error('extensão grande demais');
    const hash = crypto.createHash('sha256').update(crx).digest('hex');
    if (hash !== info.sha256) throw new Error('o arquivo baixado não confere com o hash da loja');

    const tmp = path.join(this.#extDir(id), `.tmp-${crypto.randomBytes(4).toString('hex')}`);
    const final = path.join(this.#extDir(id), info.version);
    try {
      fs.mkdirSync(tmp, { recursive: true });
      extractCrx(crx, tmp);
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(tmp, final);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { version: info.version, path: final };
  }

  // Para a inicialização: com cache, devolve na hora e atualiza em segundo plano (vale na próxima
  // abertura); sem cache, espera o download. Nunca rejeita: em falha devolve null.
  async prepare(id, onBackgroundUpdate = () => {}) {
    const current = this.cached(id);
    if (current) {
      this.prune(id, current.version);
      this.update(id)
        .then((v) => v.version !== current.version && onBackgroundUpdate(v))
        .catch((err) => console.error(`[extensões] ${id}: ${err.message}`));
      return current;
    }
    try {
      const v = await this.update(id);
      this.prune(id, v.version);
      return v;
    } catch (err) {
      console.error(`[extensões] ${id}: ${err.message}`);
      return null;
    }
  }
}

module.exports = {
  CATALOG,
  catalogMeta,
  compareVersions,
  parseUpdateXml,
  crxToZip,
  readZip,
  extractCrx,
  ExtensionStore,
};
