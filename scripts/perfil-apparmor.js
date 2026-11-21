#!/usr/bin/env node
'use strict';

// Gera o perfil AppArmor que deixa UM binário do Electron criar user namespaces sem privilégio.
//
// Por quê: desde o Ubuntu 23.10 (e no 24.04) o kernel só deixa criar user namespaces sem privilégio
// quem tem um perfil AppArmor com a regra `userns` (sysctl kernel.apparmor_restrict_unprivileged_userns=1).
// O sandbox do Chromium (e portanto do Electron) depende disso; sem o perfil, o app aborta ao abrir.
// O perfil é o mesmo que o electron-builder instala junto com o .deb (templates/linux/apparmor-profile.tpl)
// e o mesmo que a documentação do Chromium recomenda: libera só `userns` para aquele caminho exato.
//
// Uso (só imprime; quem instala é o administrador, com sudo):
//   node scripts/perfil-apparmor.js                      # Electron de node_modules deste repositório
//   node scripts/perfil-apparmor.js /caminho/do/electron # outro binário
//
// Este script não depende do Electron (dá para testar com `node --test`).

const fs = require('node:fs');
const path = require('node:path');

const PROFILE_NAME = 'idlehub-codigo';
const DEFAULT_BINARY = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron');

// Caminho absoluto, sem curingas nem caracteres que mudem o sentido do perfil.
function checkBinaryPath(p) {
  if (typeof p !== 'string' || !path.posix.isAbsolute(p)) throw new Error('o caminho do binário precisa ser absoluto');
  if (/[\s"'*?[\]{}^\\,#@$]/.test(p)) throw new Error(`caractere não permitido no caminho: ${p}`);
  if (p.split('/').some((s) => s === '..' || s === '.')) throw new Error(`caminho com "." ou "..": ${p}`);
  if (p.endsWith('/')) throw new Error('o caminho precisa apontar para o binário, não para uma pasta');
  return p;
}

function apparmorProfile(binaryPath, name = PROFILE_NAME) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) throw new Error(`nome de perfil inválido: ${name}`);
  const bin = checkBinaryPath(binaryPath);
  return [
    `# Perfil AppArmor do IdleHub (gerado por scripts/perfil-apparmor.js).`,
    `# Libera só a criação de user namespaces para este binário, que o sandbox do Electron usa.`,
    `abi <abi/4.0>,`,
    `include <tunables/global>`,
    ``,
    `profile ${name} "${bin}" flags=(unconfined) {`,
    `  userns,`,
    ``,
    `  # Ajustes locais, se houver: /etc/apparmor.d/local/${name}`,
    `  include if exists <local/${name}>`,
    `}`,
    ``,
  ].join('\n');
}

if (require.main === module) {
  try {
    const arg = process.argv[2] || DEFAULT_BINARY;
    if (!fs.existsSync(arg)) throw new Error(`binário não encontrado: ${arg} (rode "npm ci" e "node node_modules/electron/install.js" antes)`);
    // O AppArmor casa o caminho real (sem links simbólicos).
    process.stdout.write(apparmorProfile(fs.realpathSync(path.resolve(arg))));
  } catch (err) {
    console.error(`[perfil-apparmor] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { PROFILE_NAME, apparmorProfile, checkBinaryPath };
