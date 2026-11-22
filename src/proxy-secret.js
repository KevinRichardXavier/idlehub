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
// A senha nunca vai para o config.json, para a interface, para logs nem para o Discord.

const fs = require('node:fs');
const path = require('node:path');

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
    } catch {
      this.value = '';
      this.unreadable = true;
    }
  }

  get() {
    return this.value;
  }

  has() {
    return !!this.value;
  }

  async set(password) {
    if (!password) return this.clear();
    const mode = await this.pickMode();
    const buf = mode === 'safeStorage' ? await this.safeStorage.encryptStringAsync(password) : Buffer.from(password, 'utf8');
    const body = JSON.stringify({ versao: 1, modo: mode, dados: buf.toString('base64') });
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
    this.unreadable = false;
  }

  clear() {
    fs.rmSync(this.file, { force: true });
    this.value = '';
    this.unreadable = false;
  }

  // O que a interface pode saber (nunca a senha).
  async info() {
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')).modo || null;
    } catch {
      stored = null;
    }
    const mode = stored || (await this.pickMode());
    return {
      hasPassword: this.has(),
      unreadable: this.unreadable,
      storage: mode,
      storageLabel: STORAGE_LABELS[mode] || mode,
    };
  }
}

module.exports = { ProxySecret, FILE_NAME, STORAGE_LABELS };
