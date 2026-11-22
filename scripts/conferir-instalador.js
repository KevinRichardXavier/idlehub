#!/usr/bin/env node
// Confere o instalador do Windows montado pelo `npm run dist` antes de publicar o release.
//
// O app instalado se atualiza lendo o latest.yml do último GitHub Release: se a versão, o nome do
// arquivo ou o sha512 dele não baterem com o .exe publicado, o electron-updater recusa a
// atualização (ou nem a encontra). Este script reprova o release nesses casos.
//
// Uso: node scripts/conferir-instalador.js <pasta dist> <versão>
// Sai com código 0 se estiver tudo certo; 1 com a lista de problemas, se não.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lê só os campos do latest.yml que importam aqui. O formato é o do electron-builder:
// version, path e sha512 no topo, e a lista files com url, sha512 e size.
function lerLatestYml(texto) {
  const topo = {};
  const files = [];
  let atual = null;
  for (const linha of texto.split(/\r?\n/)) {
    let m;
    if ((m = linha.match(/^ {2}- (\w+): (.*)$/))) {
      atual = { [m[1]]: m[2].trim() };
      files.push(atual);
    } else if ((m = linha.match(/^ {4}(\w+): (.*)$/)) && atual) {
      atual[m[1]] = m[2].trim();
    } else if ((m = linha.match(/^(\w+):(?: (.*))?$/))) {
      atual = null;
      if (m[2] !== undefined) topo[m[1]] = m[2].trim().replace(/^'(.*)'$/, '$1');
    }
  }
  return { ...topo, files };
}

function sha512Base64(arquivo) {
  return crypto.createHash('sha512').update(fs.readFileSync(arquivo)).digest('base64');
}

function conferirInstalador(pastaDist, versao) {
  const problemas = [];
  const nomeExe = `IdleHub-Setup-${versao}.exe`;
  const exe = path.join(pastaDist, nomeExe);
  const blockmap = `${exe}.blockmap`;
  const yml = path.join(pastaDist, 'latest.yml');

  for (const arq of [exe, blockmap, yml]) {
    if (!fs.existsSync(arq) || fs.statSync(arq).size === 0) problemas.push(`faltando ou vazio: ${path.basename(arq)}`);
  }
  if (problemas.length) return { ok: false, problemas };

  const info = lerLatestYml(fs.readFileSync(yml, 'utf8'));
  const sha = sha512Base64(exe);
  const tamanho = String(fs.statSync(exe).size);

  if (info.version !== versao) problemas.push(`latest.yml diz versão ${info.version}, esperado ${versao}`);
  if (info.path !== nomeExe) problemas.push(`latest.yml aponta para ${info.path}, esperado ${nomeExe}`);
  if (info.sha512 !== sha) problemas.push('sha512 do latest.yml não bate com o .exe');
  const entrada = info.files.find((f) => f.url === nomeExe);
  if (!entrada) problemas.push(`latest.yml não lista ${nomeExe} em files`);
  else {
    if (entrada.sha512 !== sha) problemas.push(`sha512 de ${nomeExe} em files não bate com o .exe`);
    if (entrada.size !== tamanho) problemas.push(`tamanho de ${nomeExe} em files não bate com o .exe`);
  }
  return { ok: problemas.length === 0, problemas, sha512: sha, tamanho: Number(tamanho) };
}

module.exports = { lerLatestYml, conferirInstalador };

if (require.main === module) {
  const [pastaDist, versao] = process.argv.slice(2);
  if (!pastaDist || !versao) {
    console.error('uso: node scripts/conferir-instalador.js <pasta dist> <versão>');
    process.exit(1);
  }
  const r = conferirInstalador(pastaDist, versao);
  if (!r.ok) {
    for (const p of r.problemas) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`Instalador ${versao} conferido: ${r.tamanho} bytes, sha512 ${r.sha512}`);
}
