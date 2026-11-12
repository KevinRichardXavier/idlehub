'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const ext = require('../src/extensions');
const plugins = require('../src/plugins');
const { normalizeConfig } = require('../src/config');

const ID = 'mhnplloljgchpfpcpbhmcokmnefodjnh';

// Monta um .zip mínimo (deflate) e embrulha num .crx3.
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function makeCrx(entries) {
  const header = Buffer.from('cabecalho-assinado');
  const pre = Buffer.alloc(12);
  pre.write('Cr24', 0, 'latin1');
  pre.writeUInt32LE(3, 4);
  pre.writeUInt32LE(header.length, 8);
  return Buffer.concat([pre, header, makeZip(entries)]);
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fakeStore(crxByVersion, { version, hash } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('response=updatecheck')) {
      const crx = crxByVersion[version];
      const xml = `<gupdate><app appid="${ID}" status="ok"><updatecheck codebase="https://cdn.test/${version}.crx" version="${version}" hash_sha256="${hash || sha(crx)}" status="ok"/></app></gupdate>`;
      return { ok: true, text: async () => xml };
    }
    const v = /\/([\d.]+)\.crx$/.exec(url)[1];
    const crx = crxByVersion[v];
    return { ok: true, arrayBuffer: async () => crx.buffer.slice(crx.byteOffset, crx.byteOffset + crx.length) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-ext-'));
  return { store: new ext.ExtensionStore(dir, { fetchImpl }), dir, calls };
}

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 't', version: '1.0.0' });

test('compareVersions', () => {
  assert.equal(ext.compareVersions('1.0.19', '1.0.9'), 1);
  assert.equal(ext.compareVersions('1.0', '1.0.0'), 0);
  assert.equal(ext.compareVersions('1.2', '1.10'), -1);
});

test('parseUpdateXml extrai versão, endereço e hash', () => {
  const xml = `<gupdate><app appid="${ID}" status="ok"><updatecheck codebase="https://x.test/a.crx?b=1&amp;c=2" fp="1" hash_sha256="${'a'.repeat(64)}" status="ok" version="1.0.19"/></app></gupdate>`;
  assert.deepEqual(ext.parseUpdateXml(xml, ID), {
    version: '1.0.19',
    codebase: 'https://x.test/a.crx?b=1&c=2',
    sha256: 'a'.repeat(64),
  });
  assert.equal(ext.parseUpdateXml(xml.replace('status="ok" version', 'status="noupdate" version'), ID), null);
  assert.equal(ext.parseUpdateXml(xml.replace('https://', 'http://'), ID), null);
  assert.equal(ext.parseUpdateXml(xml, 'outroidoutroidoutroidoutroidabcd'), null);
});

test('crx → zip → arquivos', () => {
  const files = ext.readZip(ext.crxToZip(makeCrx([['manifest.json', MANIFEST], ['src/a.js', 'x()']])));
  assert.deepEqual(
    files.map((f) => [f.name, f.data.toString()]),
    [['manifest.json', MANIFEST], ['src/a.js', 'x()']],
  );
  assert.throws(() => ext.crxToZip(Buffer.from('PK nao e crx......')), /crx inválido/);
});

test('baixa, confere hash, descompacta e ignora _metadata', async () => {
  const crx = makeCrx([
    ['manifest.json', MANIFEST],
    ['src/a.js', 'x()'],
    ['_metadata/verified_contents.json', '{}'],
  ]);
  const { store } = fakeStore({ '1.0.19': crx }, { version: '1.0.19' });
  const v = await store.prepare(ID);
  assert.equal(v.version, '1.0.19');
  assert.equal(fs.readFileSync(path.join(v.path, 'src', 'a.js'), 'utf8'), 'x()');
  assert.ok(!fs.existsSync(path.join(v.path, '_metadata')));
  assert.deepEqual(store.cached(ID), v);
});

test('recusa arquivo com hash diferente da loja', async () => {
  const crx = makeCrx([['manifest.json', MANIFEST]]);
  const { store } = fakeStore({ '1.0.0': crx }, { version: '1.0.0', hash: 'b'.repeat(64) });
  await assert.rejects(store.update(ID), /não confere/);
  assert.equal(store.cached(ID), null);
  assert.equal(await store.prepare(ID), null); // prepare nunca rejeita
});

test('recusa caminho que sai da pasta', async () => {
  const crx = makeCrx([['manifest.json', MANIFEST], ['../fora.js', 'x']]);
  const { store, dir } = fakeStore({ '1.0.0': crx }, { version: '1.0.0' });
  await assert.rejects(store.update(ID), /caminho inválido/);
  assert.ok(!fs.existsSync(path.join(dir, 'fora.js')));
  assert.equal(store.cached(ID), null);
});

test('com cache: devolve na hora e atualiza em segundo plano', async () => {
  const old = makeCrx([['manifest.json', MANIFEST]]);
  const neu = makeCrx([['manifest.json', MANIFEST], ['novo.js', '1']]);
  const { store, dir } = fakeStore({ '1.0.0': old, '1.0.1': neu }, { version: '1.0.0' });
  await store.update(ID);
  fs.mkdirSync(path.join(dir, ID, '.tmp-lixo'));

  const updated = new Promise((resolve) => {
    const s2 = new ext.ExtensionStore(dir, { fetchImpl: fakeStore({ '1.0.1': neu }, { version: '1.0.1' }).store.fetch });
    s2.prepare(ID, resolve).then((v) => {
      assert.equal(v.version, '1.0.0'); // usa o cache sem esperar a rede
      assert.ok(!fs.existsSync(path.join(dir, ID, '.tmp-lixo')));
    });
  });
  const v = await updated;
  assert.equal(v.version, '1.0.1');
  assert.equal(store.cached(ID).version, '1.0.1');
});

test('sem versão nova não baixa de novo', async () => {
  const crx = makeCrx([['manifest.json', MANIFEST]]);
  const { store, calls } = fakeStore({ '1.0.0': crx }, { version: '1.0.0' });
  await store.update(ID);
  calls.length = 0;
  await store.update(ID);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('response=updatecheck'));
});

test('config: extensão ligada por padrão e escolha preservada', () => {
  const meta = plugins.meta();
  assert.equal(normalizeConfig(null, meta).extensions[ID], true);
  assert.equal(normalizeConfig({ extensions: { [ID]: false } }, meta).extensions[ID], false);
  assert.deepEqual(Object.keys(normalizeConfig({ extensions: { lixo: true } }, meta).extensions), [ID]);
});
