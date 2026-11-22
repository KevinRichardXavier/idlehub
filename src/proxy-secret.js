'use strict';

// Onde a senha do proxy fica guardada: num arquivo separado do config.json, `proxy-senha.json`, na pasta de
// dados do app, com permissão 600 (só o usuário que roda o app lê e escreve).
//
// - Windows, macOS e Linux com chaveiro (GNOME Keyring/KWallet): a senha vai criptografada pelo
//   `safeStorage` do Electron (DPAPI no Windows, Keychain no macOS, chaveiro no Linux). Arquivo com
//   modo "safeStorage".
// - Linux sem chaveiro (o servidor sem tela): o Electron cairia no backend "basic_text", que criptografa
//   com uma senha fixa no código do Chromium, ou seja, não protege nada. Nesse caso o arquivo fica com modo
//   "arquivo": a senha só em base64 (isso NÃO é criptografia, só evita lê-la sem querer num `cat`), e a
//   proteção real é a permissão 600 dentro da pasta pessoal do usuário que roda o app.
//
// A senha fica presa ao destino em que foi digitada (tipo, host, porta e usuário, gravados em "destino",
// que não é segredo). `getFor(p)` só a devolve se `p` for esse mesmo destino: mudar o endereço no
// config.json ou na tela não faz a senha ir para outro servidor.
//
// A senha nunca vai para o config.json, para a interface, para logs nem para o Discord.

const fs = require('node:fs');
const path = require('node:path');
const { destinationOf, sameDestination } = require('./proxy');

const FILE_NAME = 'proxy-senha.json';
const NO_KEYRING_BACKENDS = ['basic_text', 'unknown'];
const PROBE_TIMEOUT_MS = 5000;

const STORAGE_LABELS = {
  safeStorage: 'criptografada pelo cofre do sistema (safeStorage do Electron)',
  arquivo: 'num arquivo só legível pelo seu usuário (sem chaveiro no sistema; não é criptografia)',
};

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms).unref?.())]);

class ProxySecret {
  // `safeStorage`: o do Electron (ou um falso nos testes). `platform`: process.platform.
  constructor(dir, { safeStorage = null, platform = process.platform } = {}) {
    this.file = path.join(dir, FILE_NAME);
    this.safeStorage = safeStorage;
    this.platform = platform;
    this.value = '';
    this.dest = null;
    this.unreadable = false;
    this.mode = null;
  }

  // Qual guarda usar nesta máquina: "safeStorage" se houver criptografia de verdade, senão "arquivo".
  async pickMode() {
    if (this.mode) return this.mode;
    const ss = this.safeStorage;
    let mode = 'arquivo';
    try {
      if (ss && (await withTimeout(Promise.resolve(ss.isAsyncEncryptionAvailable()), PROBE_TIMEOUT_MS))) {
        const backend = this.platform === 'linux' ? ss.getSelectedStorageBackend() : 'sistema';
        if (!NO_KEYRING_BACKENDS.includes(backend)) mode = 'safeStorage';
      }
    } catch {
      mode = 'arquivo';
    }
    this.mode = mode;
    return mode;
  }

  async load() {
    this.value = '';
    this.dest = null;
    this.unreadable = false;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.unreadable = true;
      return;
    }
    try {
      const buf = Buffer.from(String(data.dados || ''), 'base64');
      if (data.modo === 'safeStorage') {
        if (!this.safeStorage) throw new Error('sem safeStorage');
        const res = await withTimeout(this.safeStorage.decryptStringAsync(buf), PROBE_TIMEOUT_MS);
        this.value = typeof res === 'string' ? res : res.result;
      } else if (data.modo === 'arquivo') {
        this.value = buf.toString('utf8');
      } else {
        throw new Error('modo desconhecido');
      }
      if (!data.destino || typeof data.destino !== 'object') throw new Error('sem destino');
      this.dest = destinationOf(data.destino);
    } catch {
      this.value = '';
      this.dest = null;
      this.unreadable = true;
    }
  }

  // Há alguma senha guardada (de qualquer destino)?
  has() {
    return !!this.value;
  }

  // A senha, só se `p` for o destino em que ela foi salva.
  getFor(p) {
    return this.value && sameDestination(this.dest, destinationOf(p)) ? this.value : '';
  }

  hasFor(p) {
    return !!this.getFor(p);
  }

  // `dest`: o proxy (tipo, host, porta, usuário) a que esta senha pertence.
  async set(password, dest) {
    if (!password) return this.clear();
    if (!dest || !dest.host || !dest.port || !dest.username) throw new Error('senha sem destino');
    const mode = await this.pickMode();
    const buf = mode === 'safeStorage' ? await this.safeStorage.encryptStringAsync(password) : Buffer.from(password, 'utf8');
    const body = JSON.stringify({ versao: 1, modo: mode, destino: destinationOf(dest), dados: buf.toString('base64') });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows: a pasta do usuário já é privada */
    }
    this.value = password;
    this.dest = destinationOf(dest);
    this.unreadable = false;
  }

  clear() {
    fs.rmSync(this.file, { force: true });
    this.value = '';
    this.dest = null;
    this.unreadable = false;
  }

  // O que a interface pode saber (nunca a senha). `p`: o proxy configurado; a senha só conta como salva
  // se for desse destino.
  async info(p) {
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')).modo || null;
    } catch {
      stored = null;
    }
    const mode = stored || (await this.pickMode());
    return {
      hasPassword: p ? this.hasFor(p) : this.has(),
      unreadable: this.unreadable,
      storage: mode,
      storageLabel: STORAGE_LABELS[mode] || mode,
    };
  }
}

module.exports = { ProxySecret, FILE_NAME, STORAGE_LABELS };
