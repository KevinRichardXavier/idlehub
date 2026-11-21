'use strict';

// Atualização automática pelos GitHub Releases (configurados em package.json > build.publish).
// Baixa a versão nova em segundo plano e avisa a interface; o usuário escolhe
// quando reiniciar. Se ele não reiniciar, a atualização é instalada ao fechar o app.
//
// Onde ela funciona (updatePolicy):
// - Windows, app instalado (NSIS): ligada.
// - Linux: desligada. O pacote .deb só se atualiza instalando como root (o electron-updater pediria a
//   senha via pkexec/sudo, o que não funciona num servidor sem tela nem num usuário sem sudo), e os
//   releases ainda não publicam o .deb. Atualizar no Linux = instalar o .deb novo ou, rodando do
//   código, `git pull` + `npm ci`. Ver docs/servidor-linux.md.
// - Rodando do código (`npm start`) ou no teste de fumaça: desligada.

const CHECK_EVERY_MS = 60 * 60 * 1000;

function updatePolicy({ isPackaged, platform, smokeTest = false }) {
  if (smokeTest) return { enabled: false, reason: 'teste de fumaça' };
  if (!isPackaged) return { enabled: false, reason: 'rodando do código-fonte' };
  if (platform === 'win32') return { enabled: true, reason: 'instalador do Windows' };
  if (platform === 'linux') return { enabled: false, reason: 'no Linux a atualização é manual (instale o .deb novo)' };
  return { enabled: false, reason: `sistema sem atualização automática: ${platform}` };
}

function startUpdater(send, { smokeTest = false } = {}) {
  const { app } = require('electron');
  const policy = updatePolicy({ isPackaged: app.isPackaged, platform: process.platform, smokeTest });
  if (!policy.enabled) {
    if (process.env.IDLEHUB_DEBUG) console.log(`[updater] desligado: ${policy.reason}`);
    return { policy, install: () => {} };
  }

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-downloaded', (info) => send('update:ready', { version: info.version }));
  autoUpdater.on('error', (err) => console.error('[updater]', err?.message || err));

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message || err));
  setTimeout(check, 10000);
  setInterval(check, CHECK_EVERY_MS);

  return { policy, install: () => autoUpdater.quitAndInstall(true, true) };
}

module.exports = { updatePolicy, startUpdater };
