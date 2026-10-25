// Conjuntos de pontos de interesse (POI) usados no ajuste do Ensemble.
//
// <pasta de trabalho>/pois/
//   pois_area_NN.geojson            os POIs da dissertação (copiados de base/pois na primeira abertura)
//   conjuntos/<id>/                 um conjunto: pois_area_NN.geojson + manifesto.json
//   conjuntos/dissertacao/          cópia byte a byte de pois/pois_area_NN.geojson (o padrão; não pode ser apagado)
//   conjuntos/_removidos/           conjuntos removidos ou descartados (dá para recuperar)
//   fontes/                         cópia dos arquivos importados
//   pedidos/                        o pedido de cada download ou importação (job 'pois')
// O conjunto ativo fica em parametros.json → "pois": { "conjunto": "<id>" }. Com a dissertação ativa nada é
// enviado ao pipeline e o resultado é o de sempre; com outro, a Previsão recebe POI_SET_DIR e POI_SET.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { capture } = require('./proc');
const paths = require('../paths');

const ID_DISS = 'dissertacao';
const SEM = '(sem categoria)';
const EXTS = ['geojson', 'json', 'kml', 'zip', 'gpkg', 'csv'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const dirP = (ws, ...p) => path.join(ws, 'pois', ...p);
const dirC = (ws, ...p) => path.join(ws, 'pois', 'conjuntos', ...p);
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const paramsFile = (ws) => path.join(ws, 'parametros.json');

/** Categoria de cada ponto, a mesma regra do pipeline (pipeline/pois/conjuntos.py → categorias_de). */
function categoria(p) {
  if (p && 'categoria' in p) return p.categoria && String(p.categoria).trim() ? String(p.categoria) : SEM;
  if (p?.amenity) return `amenity:${p.amenity}`;
  if (p?.shop) return `shop:${p.shop}`;
  return SEM;
}

const contCache = new Map();
function contarArquivo(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const k = `${file}|${st.mtimeMs}|${st.size}`;
  if (contCache.has(k)) return contCache.get(k);
  const c = {};
  try { for (const f of JSON.parse(fs.readFileSync(file, 'utf8')).features || []) { const cat = categoria(f.properties); c[cat] = (c[cat] || 0) + 1; } } catch { return null; }
  contCache.set(k, c);
  return c;
}

function hashConjunto(arquivos) {
  const h = crypto.createHash('sha256');
  for (const k of Object.keys(arquivos).sort()) h.update(`${k}:${arquivos[k]}\n`);
  return h.digest('hex');
}

/** O conjunto "dissertacao" acompanha pois/pois_area_NN.geojson (o que o pipeline lê sem override). */
function ensureDissertacao(ws) {
  const src = dirP(ws);
  let files = [];
  try { files = fs.readdirSync(src).filter((f) => /^pois_area_\d+\.geojson$/.test(f)).sort(); } catch { /* sem POIs */ }
  const d = dirC(ws, ID_DISS);
  const man0 = readJson(path.join(d, 'manifesto.json'));
  const assinatura = files.map((f) => { const st = fs.statSync(path.join(src, f)); return `${f}:${st.size}:${Math.round(st.mtimeMs)}`; }).join('|');
  if (man0 && man0.assinatura === assinatura) return man0;
  fs.mkdirSync(d, { recursive: true });
  const arquivos = {}, contagem = {};
  for (const f of files) {
    const a = path.join(src, f);
    const b = path.join(d, f);
    const h = sha(a);
    if (!fs.existsSync(b) || sha(b) !== h) fs.copyFileSync(a, b);
    arquivos[f] = h;
    contagem[f.slice(5, -8)] = contarArquivo(a) || {};
  }
  const man = {
    id: ID_DISS, nome: 'Dissertação (OpenStreetMap, base do app)', origem: 'dissertacao', status: 'pronto', protegido: true,
    criado_em: man0?.criado_em || new Date().toISOString().slice(0, 19),
    observacao: 'Os pontos de interesse que acompanham o app (base/pois), usados na dissertação: amenity bar, pub, nightclub, restaurant, bank, police, bus_station e todas as lojas (shop). Os arquivos são os originais, sem normalização: com este conjunto ativo, o resultado é idêntico ao da dissertação.',
    arquivos, contagem, hash: hashConjunto(arquivos), total: Object.values(contagem).reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0),
    assinatura,
  };
  fs.writeFileSync(path.join(d, 'manifesto.json'), JSON.stringify(man, null, 1));
  return man;
}

function manifesto(ws, id) {
  if (!ID_RE.test(id || '')) return null;
  if (id === ID_DISS) return ensureDissertacao(ws);
  return readJson(dirC(ws, id, 'manifesto.json'));
}

function ativo(ws) {
  const id = readJson(paramsFile(ws))?.pois?.conjunto;
  if (!id || id === ID_DISS) return ID_DISS;
  const m = manifesto(ws, id);
  return m && m.status === 'pronto' ? id : ID_DISS;
}

const categoriasDe = (m) => { const s = new Set(); for (const c of Object.values(m?.contagem || {})) for (const k of Object.keys(c)) s.add(k); return s; };

function resumo(m, idAtivo) {
  const cats = categoriasDe(m);
  return {
    id: m.id, nome: m.nome, origem: m.origem, status: m.status, criado_em: m.criado_em, baixado_em: m.baixado_em || null,
    total: m.total || 0, areas: Object.keys(m.contagem || {}).sort(), nCategorias: cats.size, hash: m.hash || null,
    ativo: m.id === idAtivo, protegido: m.id === ID_DISS, aviso: m.aviso || null, comDatas: !!m.com_datas,
    juntadoCom: m.juntado_com || null, dedup: m.dedup_m ?? null, duplicados: m.duplicados_removidos || null,
    arquivo: m.arquivo?.nome || null, consulta: m.consulta?.itens || null,
  };
}

function list(ws) {
  ensureDissertacao(ws);
  const idAtivo = ativo(ws);
  let ids = [];
  try { ids = fs.readdirSync(dirC(ws)).filter((n) => ID_RE.test(n)); } catch { /* nenhum */ }
  const out = [];
  for (const id of ids) { const m = manifesto(ws, id); if (m) out.push(resumo(m, idAtivo)); }
  out.sort((a, b) => (a.id === ID_DISS ? -1 : b.id === ID_DISS ? 1 : String(b.criado_em).localeCompare(String(a.criado_em))));
  return { conjuntos: out, ativo: idAtivo };
}

function detail(ws, id) {
  const m = manifesto(ws, id);
  if (!m) throw new Error('Conjunto não encontrado.');
  return { ...m, assinatura: undefined, ativo: ativo(ws) === id };
}

/** Ativa um conjunto. Os pesos das categorias em comum ficam; devolve as que apareceram e as que sumiram. */
function activate(ws, id) {
  const m = manifesto(ws, id);
  if (!m) throw new Error('Conjunto não encontrado.');
  if (m.status !== 'pronto') throw new Error('Salve o conjunto antes de ativá-lo.');
  const antes = categoriasDe(manifesto(ws, ativo(ws)));
  const depois = categoriasDe(m);
  const all = readJson(paramsFile(ws)) || {};
  if (id === ID_DISS) delete all.pois; else all.pois = { conjunto: id };
  all.poisAtualizadoEm = new Date().toISOString();
  fs.writeFileSync(paramsFile(ws), JSON.stringify(all, null, 2), 'utf8');
  return {
    ...list(ws),
    apareceram: [...depois].filter((c) => !antes.has(c)).sort(),
    sumiram: [...antes].filter((c) => !depois.has(c)).sort(),
  };
}

function save(ws, id, nome) {
  if (id === ID_DISS) throw new Error('O conjunto da dissertação não muda.');
  const f = dirC(ws, id, 'manifesto.json');
  const m = readJson(f);
  if (!m) throw new Error('Conjunto não encontrado.');
  m.status = 'pronto';
  if (nome && String(nome).trim()) m.nome = String(nome).trim().slice(0, 80);
  m.salvo_em = new Date().toISOString().slice(0, 19);
  fs.writeFileSync(f, JSON.stringify(m, null, 1));
  return list(ws);
}

function remove(ws, id) {
  if (id === ID_DISS) throw new Error('O conjunto da dissertação não pode ser removido: ele é o padrão.');
  if (!ID_RE.test(id || '') || !fs.existsSync(dirC(ws, id))) throw new Error('Conjunto não encontrado.');
  if (ativo(ws) === id) activate(ws, ID_DISS);
  const dest = dirC(ws, '_removidos', `${id}_${stamp()}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dirC(ws, id), dest);
  return { ...list(ws), pasta: dest };
}

/** Pontos de uma área para o mapa de pré-visualização (amostra de até 6.000). */
function preview(ws, id, area) {
  if (!/^area_\d+$/.test(area || '')) throw new Error('Área inválida.');
  const m = manifesto(ws, id);
  if (!m) throw new Error('Conjunto não encontrado.');
  const file = id === ID_DISS ? dirP(ws, `pois_${area}.geojson`) : dirC(ws, id, `pois_${area}.geojson`);
  let fs_ = [];
  try { fs_ = JSON.parse(fs.readFileSync(file, 'utf8')).features || []; } catch { return { area, pontos: [], total: 0, contagem: {} }; }
  const passo = Math.max(1, Math.ceil(fs_.length / 6000));
  const pontos = [];
  for (let i = 0; i < fs_.length; i += passo) {
    const g = fs_[i].geometry;
    if (g?.type !== 'Point') continue;
    pontos.push([+g.coordinates[0].toFixed(5), +g.coordinates[1].toFixed(5), categoria(fs_[i].properties)]);
  }
  return { area, pontos, total: fs_.length, contagem: m.contagem?.[area] || contarArquivo(file) || {} };
}

/** Categorias (com contagem) do conjunto ativo numa área: a tabela de pesos da tela Mapa de risco. */
function categorias(ws, area, id = null) {
  const m = manifesto(ws, id || ativo(ws));
  const c = m?.contagem?.[area];
  if (!c) return null;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n }));
}

/** Overrides do pipeline para um conjunto (vazio para a dissertação). */
function overrides(ws, id) {
  if (!id || id === ID_DISS) return {};
  const m = manifesto(ws, id);
  if (!m || m.status !== 'pronto') throw new Error(`O conjunto de pontos de interesse "${id}" não existe ou não foi salvo.`);
  return { POI_SET_DIR: dirC(ws, id), POI_SET: { id, nome: m.nome, origem: m.origem, criado_em: m.criado_em, hash: m.hash } };
}

function catalogo() {
  const j = readJson(path.join(paths.PIPELINE_DIR, 'pois', 'categorias_osm.json')) || { grupos: [] };
  return j.grupos;
}

/** Copia o arquivo para pois/fontes e o lê com o Python do app (campos, valores e pontos). */
async function inspect(ws, srcPath, { python, repoRoot }) {
  const ext = path.extname(srcPath).slice(1).toLowerCase();
  if (!EXTS.includes(ext)) throw new Error('Formato não reconhecido. Use GeoJSON, KML, Shapefile compactado (.zip), GeoPackage (.gpkg) ou CSV com latitude e longitude.');
  if (fs.statSync(srcPath).size > 300 * 1048576) throw new Error('O arquivo tem mais de 300 MB.');
  if (!python) throw new Error('O Python do app ainda não está pronto. Abra a tela Ambiente e use "Preparar ambiente".');
  fs.mkdirSync(dirP(ws, 'fontes'), { recursive: true });
  const nome = `${stamp()}_${path.basename(srcPath).replace(/[^\w.\-() ]+/g, '_')}`;
  const dest = dirP(ws, 'fontes', nome);
  fs.copyFileSync(srcPath, dest);
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1', PRECRIME_DATA_DIR: ws };
  delete env.PYTHONHOME; delete env.PYTHONPATH;
  const r = await capture(python, ['-m', 'pipeline.pois.conjuntos', 'inspecionar', dest], { cwd: repoRoot, env, timeout: 300000 });
  const line = r?.stdout.split(/\r?\n/).find((l) => l.startsWith('@@POI '));
  let out = null; try { out = line ? JSON.parse(line.slice(6)) : null; } catch { /* saída inválida */ }
  if (!out) throw new Error(`Não consegui ler o arquivo com o Python do app.${r?.stderr ? ` ${r.stderr.trim().split('\n').pop().slice(0, 300)}` : ''}`);
  if (!out.ok) { try { fs.renameSync(dest, dest + '.invalido'); } catch { /* fica */ } throw new Error(out.erro); }
  return { ...out, fonte: nome, original: path.basename(srcPath) };
}

/** Pedido do job 'pois' (download do OpenStreetMap ou importação), gravado em pois/pedidos. */
function writeSpec(ws, opts) {
  const areas = Array.isArray(opts.areas) && opts.areas.length ? opts.areas.filter((a) => /^area_\d+$/.test(a)) : null;
  const dedup = Math.max(0, Math.min(500, Number(opts.dedup_m ?? 25) || 0));
  const juntarCom = opts.juntarCom && ID_RE.test(opts.juntarCom) && manifesto(ws, opts.juntarCom)?.status === 'pronto' ? opts.juntarCom : null;
  let spec;
  if (opts.acao === 'osm') {
    const itens = (opts.itens || []).map((i) => ({ chave: String(i.chave || '').trim(), valor: String(i.valor || '').trim() }))
      .filter((i) => /^[a-z_:]{1,40}$/.test(i.chave) && /^[\w*.:-]{1,60}$/.test(i.valor));
    if (!itens.length) throw new Error('Escolha ao menos uma categoria.');
    spec = { acao: 'osm', itens, areas, dedup_m: dedup, juntarCom, nome: String(opts.nome || '').slice(0, 80), timeout: 180 };
  } else if (opts.acao === 'importar') {
    const fonte = String(opts.fonte || '');
    if (!/^[\w.\-() ]+$/.test(fonte) || !fs.existsSync(dirP(ws, 'fontes', fonte))) throw new Error('Escolha o arquivo de novo.');
    const campo = (k) => (opts[k] ? String(opts[k]).slice(0, 120) : null);
    const mapa = {};
    for (const [v, c] of Object.entries(opts.mapa || {})) {
      const cat = String(c || '').trim();
      if (cat === '__ignorar__' || /^[^\s:]{1,40}:[^\s]{1,60}$/.test(cat) || cat === SEM) mapa[String(v).slice(0, 120)] = cat;
    }
    spec = { acao: 'importar', arquivo: dirP(ws, 'fontes', fonte), original: String(opts.original || fonte).slice(0, 200),
      lat: campo('lat'), lon: campo('lon'), campoCategoria: campo('campoCategoria'), mapa, campoNome: campo('campoNome'),
      campoAbertura: campo('campoAbertura'), campoFechamento: campo('campoFechamento'), dedup_m: dedup, juntarCom, areas,
      nome: String(opts.nome || '').slice(0, 80) };
  } else throw new Error('Ação desconhecida.');
  fs.mkdirSync(dirP(ws, 'pedidos'), { recursive: true });
  const file = dirP(ws, 'pedidos', `${stamp()}_${spec.acao}.json`);
  fs.writeFileSync(file, JSON.stringify(spec, null, 1));
  return { path: file, spec };
}

module.exports = { ID_DISS, SEM, EXTS, list, detail, activate, save, remove, preview, categorias, overrides, catalogo, inspect, writeSpec, ativo, manifesto, ensureDissertacao, categoria };
