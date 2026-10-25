// Áreas de estudo criadas pelo operador a partir de um GeoJSON (ou KML, Shapefile .zip, GeoPackage).
//
// <pasta de trabalho>/areas/
//   areas.json            registro: nome de exibição e dados de cada área criada (area_12 em diante)
//   fontes/               cópia dos arquivos enviados (o original não é tocado)
//   contornos/area_NN.geojson   o polígono de cada área
//   pedidos/              o pedido de cada criação (vai para o manifesto da execução)
//   _removidas/           arquivos das áreas removidas (dá para recuperar)
// A grade de cada área vai para streets/grids_area_NN.geojson, como as 8 áreas da dissertação.
const fs = require('fs');
const path = require('path');
const { capture } = require('./proc');

const EXTS = ['geojson', 'json', 'kml', 'zip', 'gpkg'];
const dir = (ws, ...p) => path.join(ws, 'areas', ...p);
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function registry(ws) {
  try {
    const r = JSON.parse(fs.readFileSync(dir(ws, 'areas.json'), 'utf8'));
    return r && typeof r.areas === 'object' ? r : { versao: 1, areas: {} };
  } catch { return { versao: 1, areas: {} }; }
}
function saveRegistry(ws, r) {
  fs.mkdirSync(dir(ws), { recursive: true });
  fs.writeFileSync(dir(ws, 'areas.json'), JSON.stringify(r, null, 2), 'utf8');
}

/** Nome de exibição de cada área criada pelo operador: { area_12: 'Pinheiros' } */
function names(ws) {
  return Object.fromEntries(Object.entries(registry(ws).areas).map(([k, v]) => [k, v.nome]));
}

/** Copia o arquivo escolhido para areas/fontes e o lê com o Python do app. */
async function inspect(ws, srcPath, { python, repoRoot }) {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!EXTS.includes(ext)) throw new Error('Formato não reconhecido. Use GeoJSON (.geojson ou .json), KML, Shapefile compactado (.zip) ou GeoPackage (.gpkg).');
  const st = fs.statSync(srcPath);
  if (st.size > 200 * 1048576) throw new Error('O arquivo tem mais de 200 MB. Simplifique os polígonos (ex.: no mapshaper) antes de enviar.');
  if (!python) throw new Error('O Python do app ainda não está pronto. Abra a tela Ambiente e use "Preparar ambiente".');
  fs.mkdirSync(dir(ws, 'fontes'), { recursive: true });
  const nome = `${stamp()}_${path.basename(srcPath).replace(/[^\w.\-() ]+/g, '_')}`;
  const dest = dir(ws, 'fontes', nome);
  fs.copyFileSync(srcPath, dest);
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
  delete env.PYTHONHOME; delete env.PYTHONPATH;
  const r = await capture(python, ['-m', 'pipeline.areas.geo_area', 'inspecionar', dest], { cwd: repoRoot, env, timeout: 180000 });
  const line = r?.stdout.split(/\r?\n/).find((l) => l.startsWith('@@AREA '));
  let out = null; try { out = line ? JSON.parse(line.slice(7)) : null; } catch { /* saída inválida */ }
  if (!out) throw new Error(`Não consegui ler o arquivo com o Python do app.${r?.stderr ? ` ${r.stderr.trim().split('\n').pop().slice(0, 300)}` : ''}`);
  if (!out.ok) { try { fs.renameSync(dest, dest + '.invalido'); } catch { /* fica */ } throw new Error(out.erro); }
  return { ...out, fonte: nome, original: path.basename(srcPath) };
}

/** Pedido de criação gravado em areas/pedidos (o job 'areas' lê com --spec). */
function writeSpec(ws, opts) {
  const fonte = String(opts.fonte || '');
  if (!/^[\w.\-() ]+$/.test(fonte) || !fs.existsSync(dir(ws, 'fontes', fonte))) throw new Error('Escolha o arquivo das áreas de novo.');
  const celula = Number(opts.celula);
  if (![100, 150, 200, 250, 300, 400, 500, 750, 1000].includes(celula)) throw new Error('Tamanho de célula inválido.');
  const modo = opts.modo === 'juntar' ? 'juntar' : 'cada';
  const spec = {
    acao: 'criar',
    arquivo: dir(ws, 'fontes', fonte),
    indices: Array.isArray(opts.indices) ? opts.indices.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : null,
    campoNome: opts.campoNome ? String(opts.campoNome).slice(0, 80) : null,
    modo, nome: modo === 'juntar' ? String(opts.nome || '').trim().slice(0, 60) : null,
    celula, osm: !!opts.osm,
  };
  if (spec.indices && !spec.indices.length) throw new Error('Escolha ao menos um polígono.');
  if (modo === 'juntar' && !spec.nome) throw new Error('Dê um nome para a área.');
  return saveSpec(ws, spec);
}
function writeOsmSpec(ws, area) {
  if (!/^area_\d+$/.test(area || '') || !fs.existsSync(path.join(ws, 'streets', `grids_${area}.geojson`))) throw new Error('Área não encontrada.');
  return saveSpec(ws, { acao: 'osm', areas: [area] });
}
function saveSpec(ws, spec) {
  fs.mkdirSync(dir(ws, 'pedidos'), { recursive: true });
  const p = dir(ws, 'pedidos', `${stamp()}.json`);
  fs.writeFileSync(p, JSON.stringify(spec, null, 2), 'utf8');
  return { path: p, spec };
}

/** Lista: as áreas da malha (streets/grids_area_*) com nome, origem e o que já foi feito. */
function list(ws) {
  const reg = registry(ws).areas;
  const ls = (d, re) => { try { return fs.readdirSync(d).filter((f) => re.test(f)); } catch { return []; } };
  const grids = ls(path.join(ws, 'streets'), /^grids_area_\d{2}\.geojson$/).map((f) => f.slice(6, -8)).sort();
  const has = (...p) => fs.existsSync(path.join(ws, ...p));
  return grids.map((a) => {
    const r = reg[a];
    return {
      area: a, nome: r?.nome || null, criada: !!r, celula: r?.celula_m || 200, celulas: r?.celulas ?? null, km2: r?.km2 ?? null,
      arquivo: r?.arquivo || null, criadaEm: r?.criadaEm || null, importada: !!r?.importada, foraDaCapital: !!r?.foraDaCapital,
      ruas: has('streets', `ruas_${a}.geojson`), pois: has('pois', `pois_${a}.geojson`),
      filtrada: has('processed', 'crimes', `crimes_${a}.csv`), dataset: has('processed', 'datasets', `dataset_full_${a}.csv`),
    };
  });
}

/** Tira uma área criada no app: os arquivos dela vão para areas/_removidas/<área>_<data>. */
function remove(ws, area) {
  const reg = registry(ws);
  if (!reg.areas[area]) throw new Error('Só as áreas criadas no app podem ser removidas (as 8 da dissertação ficam).');
  const dest = dir(ws, '_removidas', `${area}_${stamp()}`);
  fs.mkdirSync(dest, { recursive: true });
  const mover = (d, re) => {
    let fs_ = []; try { fs_ = fs.readdirSync(d).filter((f) => re.test(f)); } catch { return 0; }
    for (const f of fs_) {
      const rel = path.relative(ws, path.join(d, f));
      const to = path.join(dest, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(path.join(d, f), to);
    }
    return fs_.length;
  };
  const a = area.replace(/[^\w]/g, '');
  const re = (s) => new RegExp(s.replace('{a}', a));
  let n = 0;
  n += mover(path.join(ws, 'streets'), re('^(grids|ruas)_{a}\\.geojson$'));
  n += mover(path.join(ws, 'pois'), re('^pois_{a}\\.geojson$'));
  n += mover(dir(ws, 'contornos'), re('^{a}\\.geojson$'));
  n += mover(path.join(ws, 'processed', 'grids'), re('^{a}\\.geojson$'));
  n += mover(path.join(ws, 'processed', 'crimes'), re('^crimes_{a}\\.csv$'));
  n += mover(path.join(ws, 'processed', 'datasets'), re('^dataset_full_{a}\\.csv$'));
  n += mover(path.join(ws, 'processed', 'models'), re('_{a}\\.(pkl|pth|json)$'));
  n += mover(path.join(ws, 'processed', 'results'), re('_{a}_\\d{4}_\\d{2}\\.(csv|json)$'));
  n += mover(path.join(ws, 'processed', 'results_geojson'), re('_{a}(_\\d{4}_\\d{2})?\\.geojson$'));
  n += mover(path.join(ws, 'processed', 'validacao'), re('_{a}_\\d{4}_\\d{2}\\.csv$'));
  reg.removidas = reg.removidas || {};
  reg.removidas[`${area}_${stamp()}`] = { ...reg.areas[area], removidaEm: new Date().toISOString(), pasta: path.relative(ws, dest) };
  delete reg.areas[area];
  saveRegistry(ws, reg);
  return { area, arquivos: n, pasta: dest };
}

module.exports = { EXTS, registry, saveRegistry, names, inspect, writeSpec, writeOsmSpec, list, remove };
