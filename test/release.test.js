const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const raiz = path.join(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const { lerLatestYml, conferirInstalador } = require('../scripts/conferir-instalador');

// No Windows o checkout pode trazer CRLF; as asserções abaixo são escritas com \n.
const workflow = fs.readFileSync(path.join(raiz, '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');

// ---------- versão e notas ----------

test('release: package-lock com a mesma versão do package.json', () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('release: a versão atual tem notas em pt-BR, sem segredo', () => {
  const arq = path.join(raiz, 'docs/notas-da-versao', `v${pkg.version}.md`);
  assert.ok(fs.existsSync(arq), `faltam as notas em ${path.relative(raiz, arq)}`);
  const notas = fs.readFileSync(arq, 'utf8');
  assert.ok(notas.trim().length > 50);
  assert.doesNotMatch(notas, /discord(app)?\.com\/api\/webhooks/i);
  assert.doesNotMatch(notas, /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/);
});

// ---------- workflow ----------

test('release: workflow só publica por disparo manual na main, num job separado', () => {
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^ {2}push:/m, 'push não pode disparar release');
  // Permissão padrão só de leitura; escrita só no job que publica.
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  const escritas = workflow.match(/contents: write/g) || [];
  assert.equal(escritas.length, 1);
  const publicar = workflow.slice(workflow.indexOf('\n  publicar:'));
  assert.match(publicar, /contents: write/);
  assert.match(publicar, /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.match(publicar, /--notes-file "docs\/notas-da-versao\/v\$VERSAO\.md"/);
  // A tag é criada no commit montado por uma chamada que falha se ela já existir, e o release exige
  // essa tag (--verify-tag) em vez de deixar o GitHub reaproveitar uma tag de outro commit.
  assert.match(publicar, /gh api -X POST "repos\/\$GITHUB_REPOSITORY\/git\/refs" \\\n\s+-f ref="refs\/tags\/v\$VERSAO" -f sha="\$GITHUB_SHA"/);
  assert.match(publicar, /if \[ "\$TAG_SHA" != "\$GITHUB_SHA" \]; then/);
  assert.match(publicar, /--verify-tag/);
  assert.doesNotMatch(workflow, /--target/);
  assert.match(publicar, /npm ci --omit=dev --ignore-scripts/);
  // Nunca apaga nem reescreve release ou tag publicados.
  assert.doesNotMatch(workflow, /release (delete|edit|upload)|--clobber|git push|git tag/);
});

test('release: workflow confere CI verde, tag inexistente e o instalador antes de publicar', () => {
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$GITHUB_SHA&event=push&branch=main/);
  // Só 404 conta como tag inexistente; outro status da API para o release.
  assert.match(workflow, /if \[ "\$STATUS" = 200 \]; then[\s\S]*elif \[ "\$STATUS" != 404 \]; then/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /run: npm run dist\n/);
  assert.equal((workflow.match(/node scripts\/conferir-instalador\.js/g) || []).length, 2);
  // Ações de terceiros fixadas por SHA, como no CI.
  for (const m of workflow.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
});

// ---------- conferência do instalador ----------

function distFalso(versao, { mexer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idlehub-release-'));
  const exe = Buffer.from(`instalador falso ${versao}`);
  const nome = `IdleHub-Setup-${versao}.exe`;
  fs.writeFileSync(path.join(dir, nome), exe);
  fs.writeFileSync(path.join(dir, `${nome}.blockmap`), 'blockmap');
  const sha = crypto.createHash('sha512').update(exe).digest('base64');
  let yml = [
    `version: ${versao}`,
    'files:',
    `  - url: ${nome}`,
    `    sha512: ${sha}`,
    `    size: ${exe.length}`,
    `path: ${nome}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-11-22T04:00:00.000Z'",
    '',
  ].join('\n');
  if (mexer) yml = mexer(yml);
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml);
  return dir;
}

test('conferir-instalador: lê o latest.yml como o electron-updater (CRLF aceito)', () => {
  const info = lerLatestYml([
    'version: 0.2.0',
    'files:',
    '  - url: IdleHub-Setup-0.2.0.exe',
    '    sha512: abc==',
    '    size: 121606254',
    'path: IdleHub-Setup-0.2.0.exe',
    'sha512: abc==',
    "releaseDate: '2026-11-12T21:06:37.059Z'",
  ].join('\r\n'));
  assert.equal(info.version, '0.2.0');
  assert.equal(info.path, 'IdleHub-Setup-0.2.0.exe');
  assert.equal(info.sha512, 'abc==');
  assert.equal(info.releaseDate, '2026-11-12T21:06:37.059Z');
  assert.deepEqual(info.files, [{ url: 'IdleHub-Setup-0.2.0.exe', sha512: 'abc==', size: 121606254 }]);
});

test('conferir-instalador: reprova latest.yml que o atualizador recusa (chave duplicada, YAML quebrado)', (t) => {
  const casos = [
    (y) => `version: 9.9.9\n${y}`,
    (y) => y.replace('files:', 'files: [quebrado'),
  ];
  for (const mexer of casos) {
    const dir = distFalso('9.9.9', { mexer });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const r = conferirInstalador(dir, '9.9.9');
    assert.equal(r.ok, false);
    assert.match(r.problemas.join('\n'), /atualizador recusa/);
  }
});

test('conferir-instalador: reprova files com mais de um arquivo', (t) => {
  const dir = distFalso('9.9.9', {
    mexer: (y) => y.replace('path:', '  - url: Outro.exe\n    sha512: x==\n    size: 1\npath:'),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = conferirInstalador(dir, '9.9.9');
  assert.equal(r.ok, false);
  assert.match(r.problemas.join('\n'), /lista 2 arquivos/);
});

test('conferir-instalador: aprova instalador, blockmap e latest.yml que batem', (t) => {
  const dir = distFalso('9.9.9');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = conferirInstalador(dir, '9.9.9');
  assert.deepEqual(r.problemas, []);
  assert.equal(r.ok, true);
});

test('conferir-instalador: reprova versão, caminho, sha512 ou tamanho errados', (t) => {
  const casos = [
    [(y) => y.replace('version: 9.9.9', 'version: 9.9.8'), /versão 9\.9\.8/],
    [(y) => y.replace(/^path: .*$/m, 'path: Outro.exe'), /aponta para Outro\.exe/],
    [(y) => y.replace(/^sha512: .*$/m, 'sha512: errado=='), /sha512 do latest\.yml/],
    [(y) => y.replace(/^ {4}sha512: .*$/m, '    sha512: errado=='), /sha512 de IdleHub-Setup-9\.9\.9\.exe em files/],
    [(y) => y.replace(/^ {4}size: .*$/m, '    size: 1'), /tamanho/],
    [(y) => y.replace(/^ {2}- url: .*$/m, '  - url: Outro.exe'), /não lista/],
  ];
  for (const [mexer, erro] of casos) {
    const dir = distFalso('9.9.9', { mexer });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const r = conferirInstalador(dir, '9.9.9');
    assert.equal(r.ok, false);
    assert.ok(r.problemas.some((p) => erro.test(p)), `${erro} em ${JSON.stringify(r.problemas)}`);
  }
});

test('conferir-instalador: reprova se faltar o .exe, o blockmap ou o latest.yml', (t) => {
  for (const arq of ['IdleHub-Setup-9.9.9.exe', 'IdleHub-Setup-9.9.9.exe.blockmap', 'latest.yml']) {
    const dir = distFalso('9.9.9');
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.rmSync(path.join(dir, arq));
    const r = conferirInstalador(dir, '9.9.9');
    assert.equal(r.ok, false);
    assert.ok(r.problemas.some((p) => p.includes(arq)), JSON.stringify(r.problemas));
  }
});
