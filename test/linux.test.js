'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const plugins = require('../src/plugins');
const { normalizeConfig, PANELS_PER_TAB } = require('../src/config');
const { updatePolicy } = require('../src/updater');
const smoke = require('../src/smoke-test');
const { apparmorProfile, checkBinaryPath, PROFILE_NAME } = require('../scripts/perfil-apparmor');
const pkg = require('../package.json');

// ---------- atualização automática ----------

test('atualização automática: ligada só no Windows instalado', () => {
  assert.equal(updatePolicy({ isPackaged: true, platform: 'win32' }).enabled, true);
  assert.equal(updatePolicy({ isPackaged: true, platform: 'linux' }).enabled, false);
  assert.match(updatePolicy({ isPackaged: true, platform: 'linux' }).reason, /manual/);
  assert.equal(updatePolicy({ isPackaged: true, platform: 'darwin' }).enabled, false);
  assert.equal(updatePolicy({ isPackaged: false, platform: 'win32' }).enabled, false);
  assert.equal(updatePolicy({ isPackaged: false, platform: 'linux' }).enabled, false);
  assert.equal(updatePolicy({ isPackaged: true, platform: 'win32', smokeTest: true }).enabled, false);
});

// ---------- teste de fumaça ----------

test('fumaça: só liga com --teste-fumaca', () => {
  assert.equal(smoke.isSmokeTest(['/opt/IdleHub/idlehub', '--teste-fumaca']), true);
  assert.equal(smoke.isSmokeTest(['electron', '.']), false);
  assert.equal(smoke.isSmokeTest(['electron', '.', '--teste-fumaca=1']), false);
});

test('fumaça: detecta sandbox desligado', () => {
  assert.equal(smoke.sandboxDisabled(['x'], {}), false);
  assert.equal(smoke.sandboxDisabled(['x', '--no-sandbox'], {}), true);
  assert.equal(smoke.sandboxDisabled(['x'], { ELECTRON_DISABLE_SANDBOX: '1' }), true);
});

test('fumaça: configuração sem nenhum endereço de jogo, sem mexer na original', () => {
  const c = normalizeConfig(null, plugins.meta());
  assert.ok(c.tabs[0].panels.every((p) => p.url));
  const off = smoke.offlineConfig(c);
  assert.ok(off.tabs.every((t) => t.panels.every((p) => p.url === '')));
  assert.equal(off.tabs[0].panels.length, PANELS_PER_TAB);
  assert.deepEqual(off.tabs[0].panels.map((p) => p.id), c.tabs[0].panels.map((p) => p.id));
  assert.ok(c.tabs[0].panels.every((p) => p.url), 'não altera a configuração recebida');
  // E continua válida para o normalizador.
  assert.deepEqual(normalizeConfig(off, plugins.meta()).tabs, off.tabs);
});

test('fumaça: veredito', () => {
  const base = { ui: { tabs: 1, panels: 4 }, expectedPanels: 4, visible: true, blocked: [], sandboxOff: false };
  assert.deepEqual(smoke.verdict(base), { ok: true, problems: [] });

  const semUi = smoke.verdict({ ...base, ui: null });
  assert.equal(semUi.ok, false);
  assert.equal(semUi.problems.length, 2);

  assert.equal(smoke.verdict({ ...base, ui: { tabs: 1, panels: 3 } }).ok, false);
  assert.equal(smoke.verdict({ ...base, visible: false }).ok, false);
  assert.equal(smoke.verdict({ ...base, sandboxOff: true }).ok, false);

  const rede = smoke.verdict({ ...base, blocked: ['https://pokeidle.io/app'] });
  assert.equal(rede.ok, false);
  assert.match(rede.problems[0], /pokeidle\.io/);
});

// ---------- perfil AppArmor ----------

test('perfil AppArmor: só libera userns para o caminho exato', () => {
  const bin = '/home/idlehub/idlehub/node_modules/electron/dist/electron';
  const p = apparmorProfile(bin);
  assert.match(p, /^abi <abi\/4\.0>,$/m);
  assert.match(p, /^include <tunables\/global>$/m);
  assert.ok(p.includes(`profile ${PROFILE_NAME} "${bin}" flags=(unconfined) {`));
  assert.match(p, /^ {2}userns,$/m);
  assert.match(p, new RegExp(`include if exists <local/${PROFILE_NAME}>`));
  // Nenhuma outra regra além de userns e do include local.
  const rules = p
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('abi') && !l.startsWith('include') && !l.startsWith('profile') && l !== '}');
  assert.deepEqual(rules, ['userns,']);
});

test('perfil AppArmor: recusa caminho relativo, curinga ou caractere estranho', () => {
  for (const bad of [
    'node_modules/electron/dist/electron',
    '/tmp/.mount_IdleHu*/idlehub',
    '/home/x/**/electron',
    '/home/x/a b/electron',
    '/home/x/"/electron',
    '/home/x/../root/electron',
    '/home/x/electron/',
    '/home/x/{a,b}/electron',
    '/home/x/elec\ntron',
  ])
    assert.throws(() => checkBinaryPath(bad), undefined, bad);
  assert.equal(checkBinaryPath('/opt/IdleHub/idlehub'), '/opt/IdleHub/idlehub');
  assert.throws(() => apparmorProfile('/opt/IdleHub/idlehub', 'Nome Ruim'));
});

// ---------- empacotamento ----------

test('empacotamento: instalador do Windows intacto e alvo .deb no Linux', () => {
  assert.equal(pkg.scripts.dist, 'electron-builder --win --publish never');
  assert.equal(pkg.scripts.release, 'electron-builder --win --publish always');
  assert.equal(pkg.build.win.target, 'nsis');
  assert.deepEqual(pkg.build.nsis, {
    oneClick: true,
    perMachine: false,
    artifactName: 'IdleHub-Setup-${version}.${ext}',
  });
  assert.equal(pkg.build.linux.target, 'deb');
  assert.match(pkg.scripts['dist:linux'], /--linux deb --publish never$/);
  assert.equal(pkg.scripts.fumaca, `electron . ${smoke.FLAG}`);
  // O caminho do app instalado (/opt/IdleHub/idlehub) vem destes dois campos; o guia do servidor depende dele.
  assert.equal(pkg.productName, 'IdleHub');
  assert.equal(pkg.name, 'idlehub');
});
