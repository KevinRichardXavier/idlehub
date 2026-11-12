'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Arquivo JSON com escrita atômica (tmp + rename) e salvamento adiado.
class JsonFile {
  constructor(file, delayMs = 500) {
    this.file = file;
    this.delayMs = delayMs;
    this.timer = null;
    this.pending = null;
  }

  read(fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (fs.existsSync(this.file)) {
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
        } catch {
          /* ignora */
        }
      }
      return fallback;
    }
  }

  writeNow(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  write(data) {
    this.pending = data;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.pending === null) return;
    const data = this.pending;
    this.pending = null;
    try {
      this.writeNow(data);
    } catch (err) {
      console.error(`[jsonfile] falha ao salvar ${this.file}:`, err);
    }
  }
}

module.exports = { JsonFile };
