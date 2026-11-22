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

// O latest.yml é lido com a mesma função do electron-updater do app instalado (parseUpdateInfo,
// js-yaml estrito: chave duplicada ou YAML inválido reprovam aqui como reprovariam no app) e a
// lista de arquivos sai do mesmo getFileList que ele usa para escolher o que baixar.
const { parseUpdateInfo, getFileList } = require('electron-updater/out/providers/Provider');

function lerLatestYml(texto, origem = 'latest.yml') {
  return parseUpdateInfo(texto, 'latest.yml', origem);
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

  let info;
  try {
    info = lerLatestYml(fs.readFileSync(yml, 'utf8'), yml);
  } catch (err) {
    return { ok: false, problemas: [`latest.yml que o atualizador recusa: ${String(err.message).split('\n')[0]}`] };
  }
  if (!info || typeof info !== 'object') return { ok: false, problemas: ['latest.yml vazio ou sem campos'] };
  const sha = sha512Base64(exe);
  const tamanho = fs.statSync(exe).size;

  if (String(info.version) !== versao) problemas.push(`latest.yml diz versão ${info.version}, esperado ${versao}`);
  if (info.path !== nomeExe) problemas.push(`latest.yml aponta para ${info.path}, esperado ${nomeExe}`);
  if (info.sha512 !== sha) problemas.push('sha512 do latest.yml não bate com o .exe');
  let arquivos = [];
  try {
    arquivos = getFileList(info);
  } catch {
    arquivos = [];
  }
  const entrada = arquivos.find((f) => f.url === nomeExe);
  if (!entrada) problemas.push(`latest.yml não lista ${nomeExe} em files`);
  else {
    if (entrada.sha512 !== sha) problemas.push(`sha512 de ${nomeExe} em files não bate com o .exe`);
    if (Number(entrada.size) !== tamanho) problemas.push(`tamanho de ${nomeExe} em files não bate com o .exe`);
  }
  if (arquivos.length !== 1) problemas.push(`latest.yml lista ${arquivos.length} arquivos em files, esperado só o instalador`);
  return { ok: problemas.length === 0, problemas, sha512: sha, tamanho };
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
