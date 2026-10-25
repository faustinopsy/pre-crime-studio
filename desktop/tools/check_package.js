#!/usr/bin/env node
// Confere o pacote gerado pelo electron-builder (dist/win-unpacked) contra o código do repositório.
// Roda sozinho depois de `npm run dist` (postdist) e também como `npm run check:pkg`.
// Para o processo (exit 1) se faltar ou estiver diferente qualquer coisa que o app instalado usa:
//   1. pipeline/, server/ e base/ iguais ao repositório (sha256), sem __pycache__, *.pyc,
//      node_modules e README.md;
//   2. o código das telas (desktop/src) igual ao que está dentro do app.asar;
//   3. icon.ico, icon-256.png, requirements.txt e requirements.lock em resources/, as 8 malhas,
//      as 8 camadas de ruas e os 8 arquivos de POI das áreas da dissertação;
//   4. o .exe com o nome e o ícone do Pre-Crime Studio (não o do Electron);
//   5. com o Python do ambiente do app (se existir): compila o pipeline do pacote e roda
//      `python -m pipeline.bridge.run --help` com cwd = resources;
//   6. o servidor do mapa do pacote (tools/smoke.js) com o próprio executável do app.
// Uso: node tools/check_package.js [--dir dist/win-unpacked] [--python caminho]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const DESKTOP = path.resolve(__dirname, '..');
const REPO = path.resolve(DESKTOP, '..');
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const UNPACKED = path.resolve(DESKTOP, arg('dir') || path.join('dist', process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked'));
const RES = path.join(UNPACKED, 'resources');
const AREAS = ['area_01', 'area_02', 'area_03', 'area_04', 'area_05', 'area_09', 'area_10', 'area_11'];
const IGNORAR = (rel) => /(^|\/)(__pycache__|node_modules)(\/|$)/.test(rel) || /\.pyc$/.test(rel) || /(^|\/)README\.md$/.test(rel);

const falhas = [];
const avisos = [];
const ok = [];
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function listar(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (IGNORAR(rel)) continue;
    if (e.isDirectory()) out.push(...listar(abs, base)); else out.push(rel);
  }
  return out;
}

function comparar(nome, src, dst) {
  if (!fs.existsSync(src)) { avisos.push(`${nome}: não está no repositório (${src}); comparação pulada`); return; }
  if (!listar(src).length) { avisos.push(`${nome}: a pasta do repositório está vazia (${src}); comparação pulada`); return; }
  if (!fs.existsSync(dst)) { falhas.push(`${nome}: a pasta não está no pacote (${dst})`); return; }
  const a = listar(src), b = new Set(listar(dst));
  const faltam = [], diferentes = [];
  for (const rel of a) {
    if (!b.has(rel)) { faltam.push(rel); continue; }
    b.delete(rel);
    const fa = path.join(src, rel), fb = path.join(dst, rel);
    if (fs.statSync(fa).size !== fs.statSync(fb).size || sha(fs.readFileSync(fa)) !== sha(fs.readFileSync(fb))) diferentes.push(rel);
  }
  const sobram = [...b];
  if (faltam.length) falhas.push(`${nome}: ${faltam.length} arquivo(s) faltando no pacote: ${faltam.slice(0, 12).join(', ')}${faltam.length > 12 ? '…' : ''}`);
  if (diferentes.length) falhas.push(`${nome}: ${diferentes.length} arquivo(s) diferentes do repositório: ${diferentes.slice(0, 12).join(', ')}${diferentes.length > 12 ? '…' : ''}`);
  if (sobram.length) avisos.push(`${nome}: ${sobram.length} arquivo(s) no pacote que não existem mais no repositório: ${sobram.slice(0, 8).join(', ')}`);
  if (!faltam.length && !diferentes.length) ok.push(`${nome}: ${a.length} arquivos iguais ao repositório`);
}

function compararAsar() {
  const asarFile = path.join(RES, 'app.asar');
  if (!fs.existsSync(asarFile)) { falhas.push('app.asar não está no pacote'); return; }
  let asar;
  try { asar = require('@electron/asar'); } catch { avisos.push('@electron/asar indisponível: código das telas (app.asar) não conferido'); return; }
  const dentro = new Set(asar.listPackage(asarFile).map((p) => p.replace(/\\/g, '/').replace(/^\//, '')));
  const src = path.join(DESKTOP, 'src');
  // arquivos de src/ copiados como extraResources (ex.: o ícone) ficam fora do app.asar
  const extras = new Set((require(path.join(DESKTOP, 'package.json')).build?.extraResources || [])
    .map((e) => path.relative(DESKTOP, path.resolve(DESKTOP, typeof e === 'string' ? e : e.from)).split(path.sep).join('/')));
  const faltam = [], diferentes = [];
  for (const rel of listar(src)) {
    if (/\.map$/.test(rel)) continue;
    const r = `src/${rel}`;
    if (extras.has(r)) continue;
    if (!dentro.has(r)) { faltam.push(r); continue; }
    let buf;
    // o @electron/asar procura o caminho pelo separador do sistema: no Windows, com "/", não acha nada
    try { buf = asar.extractFile(asarFile, r.split('/').join(path.sep)); } catch {
      // arquivos de asarUnpack ficam em app.asar.unpacked
      const un = path.join(RES, 'app.asar.unpacked', r);
      buf = fs.existsSync(un) ? fs.readFileSync(un) : null;
    }
    if (!buf || sha(buf) !== sha(fs.readFileSync(path.join(src, rel)))) diferentes.push(r);
  }
  if (faltam.length) falhas.push(`app.asar: ${faltam.length} arquivo(s) do app faltando: ${faltam.slice(0, 12).join(', ')}`);
  if (diferentes.length) falhas.push(`app.asar: ${diferentes.length} arquivo(s) do app diferentes do código: ${diferentes.slice(0, 12).join(', ')}`);
  if (!faltam.length && !diferentes.length) ok.push('app.asar: código das telas igual ao repositório');
}

function presencas() {
  const need = ['icon.ico', 'icon-256.png', 'requirements.txt', 'requirements.lock', 'pipeline/padroes_dissertacao.json', 'pipeline/bridge/run.py', 'server/server.js'];
  // as malhas da dissertação (base/) ficam fora do git: num clone sem elas, o instalador sai sem malhas e o app
  // pede para importá-las na Filtragem ("Importar malhas"). Isso é aviso; com base/ no repositório, faltar é erro.
  const temBase = AREAS.some((a) => fs.existsSync(path.join(REPO, 'base', 'streets', `grids_${a}.geojson`)));
  if (temBase) for (const a of AREAS) need.push(`base/streets/grids_${a}.geojson`, `base/streets/ruas_${a}.geojson`, `base/pois/pois_${a}.geojson`);
  else avisos.push('base: sem as malhas da dissertação no repositório (a pasta base fica fora do git). O instalador sai sem malhas: no app instalado, importe-as na Filtragem com "Importar malhas" (ou copie a pasta base para o repositório e gere de novo).');
  const faltam = need.filter((f) => !fs.existsSync(path.join(RES, ...f.split('/'))));
  if (faltam.length) falhas.push(`faltam em resources/: ${faltam.join(', ')}`);
  else ok.push(`resources/: ícones, requirements${temBase ? `, ${AREAS.length} malhas, ${AREAS.length} ruas e ${AREAS.length} POIs` : ''}`);
}

function executavel() {
  const nomes = process.platform === 'win32' ? ['Pre-Crime Studio.exe'] : ['Pre-Crime Studio', require(path.join(DESKTOP, 'package.json')).name];
  const exe = fs.readdirSync(UNPACKED).find((f) => nomes.includes(f));
  if (!exe) { falhas.push(`o executável "Pre-Crime Studio" não está em ${UNPACKED}`); return null; }
  const abs = path.join(UNPACKED, exe);
  if (exe.endsWith('.exe')) {
    // o rcedit do electron-builder grava o ícone junto com o nome do produto no recurso de versão
    const nome = Buffer.from('Pre-Crime Studio', 'utf16le');
    if (!fs.readFileSync(abs).includes(nome)) falhas.push(`${exe}: sem o nome e o ícone do Pre-Crime Studio (o Windows mostraria o ícone do Electron)`);
    else ok.push(`${exe}: nome e ícone do Pre-Crime Studio`);
  }
  return abs;
}

function instalador() {
  const dist = path.join(DESKTOP, 'dist');
  const setups = fs.existsSync(dist) ? fs.readdirSync(dist).filter((f) => /^Pre-Crime-Studio-Setup-.*\.exe$/.test(f)) : [];
  if (!setups.length) { avisos.push('nenhum instalador (Pre-Crime-Studio-Setup-*.exe) em dist/'); return; }
  const novo = setups.map((f) => ({ f, t: fs.statSync(path.join(dist, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  let maisNovo = 0, qual = '';
  for (const [dir, base] of [[path.join(REPO, 'pipeline'), 'pipeline'], [path.join(REPO, 'server'), 'server'], [path.join(DESKTOP, 'src'), 'desktop/src']]) {
    for (const rel of listar(dir)) { const t = fs.statSync(path.join(dir, rel)).mtimeMs; if (t > maisNovo) { maisNovo = t; qual = `${base}/${rel}`; } }
  }
  if (maisNovo > novo.t + 1000) falhas.push(`${novo.f} é de ${new Date(novo.t).toLocaleString('pt-BR')}, mais velho que ${qual} (${new Date(maisNovo).toLocaleString('pt-BR')}). Rode npm run dist de novo.`);
  else ok.push(`${novo.f}: gerado depois da última mudança no código`);
}

function pythonDoApp() {
  if (arg('python')) return arg('python');
  const cands = [];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'PreCrimeStudio', 'venv', 'Scripts', 'python.exe'));
  cands.push(path.join(os.homedir(), '.config', 'Pre-Crime Studio', 'runtime', 'venv', 'bin', 'python'));
  return cands.find((p) => fs.existsSync(p)) || null;
}

function testarPython() {
  const py = pythonDoApp();
  if (!py) { avisos.push('Python do app não encontrado: compilação do pipeline do pacote não testada (use --python)'); return; }
  const env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPYCACHEPREFIX: fs.mkdtempSync(path.join(os.tmpdir(), 'pcpkg-')), PYTHONIOENCODING: 'utf-8' };
  delete env.PYTHONPATH; delete env.PYTHONHOME;
  const c = spawnSync(py, ['-m', 'compileall', '-q', 'pipeline'], { cwd: RES, env, encoding: 'utf8', timeout: 300000 });
  if (c.status !== 0) falhas.push(`o pipeline do pacote não compila:\n${(c.stdout + c.stderr).trim().slice(0, 1500)}`);
  else ok.push('pipeline do pacote compila');
  const h = spawnSync(py, ['-m', 'pipeline.bridge.run', '--help'], { cwd: RES, env: { ...env, PRECRIME_DATA_DIR: env.PYTHONPYCACHEPREFIX }, encoding: 'utf8', timeout: 120000 });
  if (h.status !== 0 || !/usage/i.test(h.stdout)) falhas.push(`python -m pipeline.bridge.run --help falhou no pacote:\n${(h.stdout + h.stderr).trim().slice(0, 1500)}`);
  else ok.push('python -m pipeline.bridge.run --help responde no pacote');
}

function testarServidor(exe) {
  const smoke = path.join(RES, 'server', 'tools', 'smoke.js');
  if (!fs.existsSync(smoke)) { falhas.push('server/tools/smoke.js não está no pacote'); return; }
  const runner = exe && (process.platform === 'win32' ? exe.endsWith('.exe') : true) ? exe : process.execPath;
  const vazio = fs.mkdtempSync(path.join(os.tmpdir(), 'pcpkg-data-'));
  fs.mkdirSync(path.join(vazio, 'processed'), { recursive: true });
  const r = spawnSync(runner, [smoke, '--data', path.join(vazio, 'processed')], {
    cwd: path.join(RES, 'server'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 180000,
  });
  if (r.status !== 0) falhas.push(`servidor do mapa do pacote falhou no teste (smoke.js):\n${(r.stdout + r.stderr).trim().slice(-1500)}`);
  else ok.push(`servidor do mapa do pacote responde (${runner === exe ? 'com o executável do app' : 'com o Node'})`);
}

if (!fs.existsSync(RES)) {
  console.error(`[ERRO] ${RES} não existe. Rode npm run dist (ou npm run dist:dir) antes.`);
  process.exit(1);
}
console.log(`Conferindo o pacote em ${UNPACKED}\n`);
comparar('pipeline', path.join(REPO, 'pipeline'), path.join(RES, 'pipeline'));
comparar('server', path.join(REPO, 'server'), path.join(RES, 'server'));
comparar('base', path.join(REPO, 'base'), path.join(RES, 'base'));
compararAsar();
presencas();
const exe = executavel();
instalador();
testarPython();
testarServidor(exe);

for (const m of ok) console.log(`  ok    ${m}`);
for (const m of avisos) console.log(`  aviso ${m}`);
for (const m of falhas) console.log(`  ERRO  ${m}`);
if (falhas.length) {
  console.error(`\n[ERRO] O pacote tem ${falhas.length} problema(s). Não distribua este instalador.`);
  process.exit(1);
}
console.log('\n[OK] Pacote completo e igual ao código.');
