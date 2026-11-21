'use strict';

// Monta o preload das telas de jogo num arquivo único: src/gerado/preload-panel.js.
//
// Por quê: as telas de jogo rodam com `sandbox: true`. Num preload em sandbox o `require` só conhece
// alguns módulos do Electron (ipcRenderer, webFrame, contextBridge...), não arquivos do projeto. Então
// juntamos src/preload-panel.js e tudo o que ele carrega por caminho relativo (o registro de plugins,
// cada plugin e o observador) num arquivo só, com um carregador mínimo no estilo CommonJS. Sem
// dependência nova: o projeto só usa CommonJS com caminhos literais, e isto basta para esse caso.
//
// Roda sozinho antes de `npm start`, `npm test`, `npm run fumaca` e do empacotamento (scripts "pre*" do
// package.json). O arquivo gerado não é versionado; test/preload-montado.test.js reprova se ele estiver
// diferente do que as fontes geram.
//
// Uso: node scripts/montar-preload.js           (gera o arquivo)
//      node scripts/montar-preload.js --conferir (só confere; sai com 1 se estiver desatualizado)

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const ENTRY = 'preload-panel.js';
const OUT = path.join(SRC, 'gerado', 'preload-panel.js');
// Módulos que o `require` de um preload em sandbox oferece e que o preload pode usar. Qualquer outro
// nome que não seja caminho relativo reprova a montagem, porque falharia só na hora, dentro da tela.
const SANDBOX_MODULES = new Set(['electron']);

const REQUIRE_LITERAL = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const REQUIRE_ANY = /\brequire\s*\(/g;

// `root` é a pasta de onde os módulos podem vir (src/; os testes usam uma pasta temporária).
const toId = (root, file) => path.relative(root, file).split(path.sep).join('/');

function resolveLocal(root, fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const f of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      const rel = path.relative(root, f);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${toId(root, fromFile)}: "${spec}" sai de src/`);
      return f;
    }
  }
  throw new Error(`${toId(root, fromFile)}: não achei o módulo "${spec}"`);
}

// Lê a entrada e tudo o que ela carrega. Retorna [{ id, source, deps: { especificador: id } }], a entrada
// primeiro, na ordem em que os módulos aparecem (saída determinística).
function collect(root = SRC, entry = ENTRY) {
  const modules = [];
  const seen = new Map();
  const visit = (file) => {
    const id = toId(root, file);
    if (seen.has(id)) return id;
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const mod = { id, source, deps: {} };
    seen.set(id, mod);
    modules.push(mod);
    const literals = [...source.matchAll(REQUIRE_LITERAL)];
    if (literals.length !== (source.match(REQUIRE_ANY) || []).length) {
      throw new Error(`${id}: require sem um texto fixo entre aspas; o preload em sandbox precisa saber o módulo na montagem`);
    }
    for (const [, , spec] of literals) {
      if (spec.startsWith('./') || spec.startsWith('../')) mod.deps[spec] = visit(resolveLocal(root, file, spec));
      else if (!SANDBOX_MODULES.has(spec)) {
        throw new Error(`${id}: "${spec}" não existe num preload em sandbox (permitidos: ${[...SANDBOX_MODULES].join(', ')} e arquivos de src/)`);
      }
    }
    return id;
  };
  visit(path.join(root, entry));
  return modules;
}

function build(root, entry) {
  const modules = collect(root, entry);
  const defs = modules
    .map(
      (m) =>
        `  // ---------- src/${m.id} ----------\n` +
        `  ${JSON.stringify(m.id)}: [${JSON.stringify(m.deps)}, function (module, exports, require) {\n${m.source.trimEnd()}\n  }],`,
    )
    .join('\n');
  return `// GERADO por scripts/montar-preload.js a partir de src/${modules[0].id}. Não edite: edite as fontes.
// Preload das telas de jogo (sandbox: true): os módulos do projeto vão juntos aqui; só "electron" vem do
// require do próprio Electron.
'use strict';
(function (nativeRequire) {
const modules = {
${defs}
};
const cache = {};
function load(id) {
  if (cache[id]) return cache[id].exports;
  const [deps, fn] = modules[id];
  const module = (cache[id] = { exports: {} });
  fn(module, module.exports, (spec) => (Object.hasOwn(deps, spec) ? load(deps[spec]) : nativeRequire(spec)));
  return module.exports;
}
load(${JSON.stringify(modules[0].id)});
})(require);
`;
}

function isFresh(out = OUT) {
  let current;
  try {
    current = fs.readFileSync(out, 'utf8');
  } catch {
    return false;
  }
  return current === build();
}

function write(out = OUT) {
  const code = build();
  let current = null;
  try {
    current = fs.readFileSync(out, 'utf8');
  } catch {
    /* ainda não existe */
  }
  if (current !== code) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, code);
  }
  return out;
}

module.exports = { build, collect, write, isFresh, OUT, SANDBOX_MODULES };

if (require.main === module) {
  try {
    if (process.argv.includes('--conferir')) {
      if (!isFresh()) {
        console.error(`${path.relative(process.cwd(), OUT)} está desatualizado ou faltando: rode node scripts/montar-preload.js`);
        process.exit(1);
      }
      console.log('preload das telas de jogo em dia');
    } else {
      console.log(`preload das telas de jogo montado em ${path.relative(process.cwd(), write())}`);
    }
  } catch (err) {
    console.error(`montar-preload: ${err.message}`);
    process.exit(1);
  }
}
