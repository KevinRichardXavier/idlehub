'use strict';

// Atualização automática pelos GitHub Releases (configurados em package.json > build.publish).
// Baixa a versão nova em segundo plano e avisa a interface; o usuário escolhe
// quando reiniciar. Se ele não reiniciar, a atualização é instalada ao fechar o app.
const { app } = require('electron');

const CHECK_EVERY_MS = 60 * 60 * 1000;

function startUpdater(send) {
  if (!app.isPackaged) return { install: () => {} };

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('update-downloaded', (info) => send('update:ready', { version: info.version }));
  autoUpdater.on('error', (err) => console.error('[updater]', err?.message || err));

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message || err));
  setTimeout(check, 10000);
  setInterval(check, CHECK_EVERY_MS);

  return { install: () => autoUpdater.quitAndInstall(true, true) };
}

module.exports = { startUpdater };
