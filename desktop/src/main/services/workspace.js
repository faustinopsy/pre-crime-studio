// Leitura do estado da pasta de dados: o que já existe de cada fase do pipeline.
// O estado é inferido pelos arquivos e pelas impressões digitais (hash) registradas a cada execução.
const fs = require('fs');
const path = require('path');

const PHASES = [
  { id: 'ssp', label: 'Dados SSP' },
  { id: 'clean', label: 'Limpeza' },
  { id: 'filter', label: 'Filtragem' },
  { id: 'features', label: 'Features' },
  { id: 'train', label: 'Treino' },
  { id: 'predict', label: 'Previsão' },
  { id: 'validate', label: 'Validação' },
  { id: 'publish', label: 'Publicação' },
];

function ls(dir, re) {
  try {
    return fs.readdirSync(dir).filter((f) => !re || re.test(f)).map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { name: f, path: p, size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
    });
  } catch { return []; }
}
const newest = (files) => files.reduce((m, f) => Math.max(m, f.mtime), 0);
const oldest = (files) => files.length ? files.reduce((m, f) => Math.min(m, f.mtime), Infinity) : 0;
const total = (files) => files.reduce((s, f) => s + f.size, 0);
const sizeTxt = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`);

function readCsvColumn(file, wanted) {
  // Leitura simples do CSV de métricas (arquivo pequeno), sem aspas complexas.
  try {
    const [head, ...rows] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const cols = head.split(',');
    const idx = wanted.map((w) => cols.indexOf(w));
    return rows.map((r) => { const c = r.split(','); return idx.map((i) => (i >= 0 ? c[i] : undefined)); });
  } catch { return []; }
}

function inspect(dataDir) {
  const d = (...p) => path.join(dataDir, ...p);
  const exists = fs.existsSync(dataDir);
  const xlsx = ls(d('dados_ssp'), /\.xlsx$/i);
  const grids = ls(d('streets'), /^grids_area_\d+\.geojson$/);
  const ruas = ls(d('streets'), /^ruas_area_\d+\.geojson$/);
  const pois = ls(d('pois'), /\.geojson$/);
  const areas = grids.map((g) => g.name.replace(/^grids_|\.geojson$/g, '')).sort();
  const nAreas = areas.length || 8;

  const raw = ls(d('raw'), /^dados_unificados\.csv$/);
  const pGrids = ls(d('processed', 'grids'), /^area_\d+\.geojson$/);
  const pCrimes = ls(d('processed', 'crimes'), /^crimes_area_\d+\.csv$/);
  const datasets = ls(d('processed', 'datasets'), /^dataset_full_area_\d+\.csv$/);
  const models = ls(d('processed', 'models'));
  const rf = models.filter((m) => /^rf_area_\d+\.pkl$/.test(m.name));
  const lstm = models.filter((m) => /^lstm_area_\d+\.pth$/.test(m.name));
  const tf = models.filter((m) => /^transformer_area_\d+\.pth$/.test(m.name));
  const hot = ls(d('processed', 'results_geojson'), /^hotspots_.+_\d{4}_\d{2}\.geojson$/);
  const tags = [...new Set(hot.map((h) => h.name.match(/_(\d{4}_\d{2})\.geojson$/)[1]))].sort();
  const metricsFile = d('processed', 'results', 'metrics_summary_all.csv');
  const validatedTags = [...new Set(readCsvColumn(metricsFile, ['Tag', 'Crimes Totais'])
    .filter(([t, c]) => t && Number(c) > 0).map(([t]) => t))].sort();
  const pacotes = ls(d('publish', 'pacotes')).filter((f) => f.dir);
  const geoMonths = ls(d('publish', 'geojson')).filter((f) => f.dir);
  const imagens = ls(d('publish', 'imagens'), /\.png$/i);
  let changed = { limpeza: 0, filtragem: 0, dataset: 0 };
  let municipios = ['S.PAULO'];
  try {
    const pj = JSON.parse(fs.readFileSync(d('parametros.json'), 'utf8'));
    if (Array.isArray(pj.limpeza?.municipios) && pj.limpeza.municipios.length) municipios = pj.limpeza.municipios;
    changed = { limpeza: Date.parse(pj.limpezaAtualizadaEm) || 0, filtragem: Date.parse(pj.filtragemAtualizadaEm) || 0, dataset: Date.parse(pj.datasetAtualizadoEm) || 0 };
  } catch { /* sem parâmetros salvos */ }

  const years = xlsx.map((f) => (f.name.match(/(\d{4})/) || [])[1]).filter(Boolean).sort();
  const st = {};
  const put = (id, status, summary, detail = {}) => { st[id] = { id, status, summary, ...detail }; };

  // Para explicar o que roda de novo com uma planilha nova: quais já estão na base unificada
  // (mais antigas que ela) e quais já foram lidas antes (cache da Limpeza, pela sha256)
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(d('dados_ssp', '_importacoes.json'), 'utf8')).files || {}; } catch { /* sem registro */ }
  const inCache = (name) => { const sha = reg[name]?.sha256; return !!sha && fs.existsSync(d('dados_ssp', '_cache', `${sha}.v1.pkl`)); };
  const sspFiles = xlsx.map((f) => ({ name: f.name, size: f.size, mtime: f.mtime, cache: inCache(f.name), naBase: !!raw.length && f.mtime <= raw[0].mtime }));
  put('ssp', xlsx.length ? 'done' : 'pending',
    xlsx.length ? `${xlsx.length} planilha(s) · ${years[0] || '?'}–${years[years.length - 1] || '?'}` : 'Nenhuma planilha da SSP',
    { files: sspFiles, bytes: total(xlsx), novas: raw.length ? sspFiles.filter((f) => !f.naBase).map((f) => f.name) : [] });

  const rawStale = raw.length && newest(xlsx) > raw[0].mtime;
  const paramsStale = raw.length && changed.limpeza > raw[0].mtime;
  put('clean', !raw.length ? 'pending' : (rawStale || paramsStale) ? 'stale' : 'done',
    raw.length ? `Base unificada · ${(raw[0].size / 1048576).toFixed(0)} MB` : 'Ainda não executada',
    { reason: rawStale ? 'Há planilha mais nova que a base unificada.' : paramsStale ? 'Os parâmetros da Limpeza mudaram depois da última execução.' : null, mtime: raw[0]?.mtime });

  const filterStale = pCrimes.length && raw.length && raw[0].mtime > oldest(pCrimes);
  const filterParamStale = pCrimes.length && changed.filtragem > oldest(pCrimes);
  put('filter', !pCrimes.length ? 'pending' : pCrimes.length < nAreas ? 'partial' : (filterStale || filterParamStale) ? 'stale' : 'done',
    pCrimes.length ? `${pCrimes.length}/${nAreas} áreas com crimes mapeados` : 'Ainda não executada',
    { reason: filterStale ? 'A base unificada mudou depois da filtragem.' : filterParamStale ? 'A opção das células repetidas mudou depois da filtragem.' : null,
      areasDone: pCrimes.map((f) => f.name.replace(/^crimes_|\.csv$/g, '')).sort() });

  const featStale = datasets.length && pCrimes.length && newest(pCrimes) > oldest(datasets);
  const periodStale = datasets.length && changed.dataset > oldest(datasets);
  st.features_areas = datasets.map((f) => f.name.replace(/^dataset_full_|\.csv$/g, '')).sort();
  put('features', !datasets.length ? 'pending' : datasets.length < nAreas ? 'partial' : (featStale || periodStale) ? 'stale' : 'done',
    datasets.length ? `${datasets.length}/${nAreas} datasets · ${sizeTxt(total(datasets))}` : 'Ainda não executada',
    { reason: featStale ? 'Os crimes por área mudaram depois das features.' : periodStale ? 'O período do dataset mudou depois da última execução.' : null,
      areasDone: st.features_areas });

  const nModels = Math.min(rf.length, lstm.length, tf.length);
  const trainStale = nModels && datasets.length && newest(datasets) > oldest([...rf, ...lstm, ...tf]);
  put('train', !nModels ? 'pending' : nModels < nAreas ? 'partial' : trainStale ? 'stale' : 'done',
    nModels ? `RF ${rf.length} · LSTM ${lstm.length} · Transformer ${tf.length} modelos` : 'Nenhum modelo treinado',
    { reason: trainStale ? 'Os datasets são mais novos que os modelos.' : null,
      models: {
        RF: rf.map((m) => m.name.match(/area_\d+/)[0]).sort(),
        LSTM: lstm.map((m) => m.name.match(/area_\d+/)[0]).sort(),
        Transformer: tf.map((m) => m.name.match(/area_\d+/)[0]).sort(),
      },
      modelTimes: Object.fromEntries([...rf, ...lstm, ...tf].map((m) => [m.name, m.mtime])),
      datasetTimes: Object.fromEntries(datasets.map((d) => [d.name.replace(/^dataset_full_|\.csv$/g, ''), d.mtime])) });

  const lab = (t) => { const [y, m] = t.split('_'); return `${m}/${y}`; };
  // previsão do último mês feita antes do modelo atual da área → desatualizada
  const ens = ls(d('processed', 'results'), /^results_ensemble_area_\d+_\d{4}_\d{2}\.csv$/);
  const lastTag = tags[tags.length - 1];
  const predStale = lastTag && ens.filter((f) => f.name.endsWith(`_${lastTag}.csv`)).some((f) => {
    const a = f.name.match(/area_\d+/)[0];
    return [...rf, ...lstm, ...tf].some((m) => m.name.includes(a + '.') && m.mtime > f.mtime);
  });
  put('predict', !tags.length ? 'pending' : predStale ? 'stale' : 'done',
    tags.length ? `${tags.length} mês(es): ${tags.map(lab).join(', ')}` : 'Nenhuma previsão gerada',
    { tags, reason: predStale ? `Há modelo treinado depois da previsão de ${lab(lastTag)}.` : null });

  const pendingVal = tags.filter((t) => !validatedTags.includes(t));
  put('validate', !validatedTags.length ? 'pending' : pendingVal.length ? 'partial' : 'done',
    validatedTags.length ? `Validados: ${validatedTags.map(lab).join(', ')}` : 'Nenhum mês validado',
    { tags: validatedTags, waiting: pendingVal });

  const pubParts = [
    geoMonths.length && `GeoJSON de ${geoMonths.length} mês(es)`,
    imagens.length && `${imagens.length} imagem(ns)`,
    pacotes.length && `${pacotes.length} pacote(s)`,
  ].filter(Boolean);
  put('publish', pubParts.length ? 'done' : 'pending', pubParts.length ? pubParts.join(' · ') : 'Nada exportado ainda');

  return {
    dataDir, exists, areas, nAreas, municipios, stagesReady: stagesReady(dataDir), cleanParams: changed.limpeza > 0, datasetParams: changed.dataset > 0,
    base: {
      streets: { grids: grids.length, ruas: ruas.length, ok: grids.length > 0 && ruas.length >= grids.length },
      pois: { files: pois.length, ok: pois.length > 0 },
    },
    phases: PHASES.map((p) => ({ ...p, ...st[p.id] })),
    checkedAt: Date.now(),
  };
}

// ── Criação da pasta de trabalho ─────────────────────────────────────────────
// O usuário escolhe só a pasta principal. Na escolha o app cria apenas dados_ssp
// (onde entram as planilhas). As pastas de cada etapa são criadas pelo app depois da
// importação (ensureStages), já com as malhas e os POIs copiados de base/.
// Estrutura que o pipeline espera (pipeline/config.py com PRECRIME_DATA_DIR = pasta).
const ROOT_LAYOUT = ['dados_ssp'];
const LAYOUT = [
  'dados_ssp', 'raw', 'streets', 'pois', 'runs',
  'processed/grids', 'processed/crimes', 'processed/datasets', 'processed/models',
  'processed/results', 'processed/results_geojson', 'processed/metrics',
  'publish/geojson', 'publish/imagens', 'publish/pacotes',
];
const MARKER = 'precrime-workspace.json';

/** Diz o que há numa pasta candidata, antes de usá-la. */
function describe(dir) {
  if (!fs.existsSync(dir)) return { dir, kind: 'new', note: 'A pasta será criada.' };
  let entries;
  try { entries = fs.readdirSync(dir).filter((f) => !f.startsWith('.')); } catch (e) { return { dir, kind: 'error', note: e.message }; }
  if (fs.existsSync(path.join(dir, MARKER))) return { dir, kind: 'workspace', note: 'Pasta de trabalho do Pre-Crime.' };
  const known = ['dados_ssp', 'streets', 'pois', 'processed', 'raw'];
  const hits = known.filter((k) => entries.includes(k));
  if (hits.length >= 2) return { dir, kind: 'legacy', note: `Pasta de dados do Pre-Crime existente (${hits.join(', ')}). Os arquivos serão mantidos.` };
  if (!entries.length) return { dir, kind: 'empty', note: 'Pasta vazia.' };
  return { dir, kind: 'other', note: `A pasta já tem ${entries.length} item(ns). O app vai trabalhar ao lado deles, sem mexer neles.` };
}

async function copyTree(src, dst, onFile) {
  await fs.promises.mkdir(dst, { recursive: true });
  for (const ent of await fs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyTree(s, d, onFile);
    else if (!fs.existsSync(d)) { await fs.promises.copyFile(s, d); onFile?.(ent.name); }
  }
}

/** As pastas das etapas já existem? (pasta antiga ou importação já feita) */
function stagesReady(dir) {
  return fs.existsSync(path.join(dir, 'raw')) && fs.existsSync(path.join(dir, 'processed'));
}
const hasSpreadsheets = (dir) => ls(path.join(dir, 'dados_ssp'), /\.xlsx$/i).length > 0;

/**
 * Cria (ou completa) a pasta de trabalho. Nunca apaga nem sobrescreve nada.
 * full=false: só a pasta principal e dados_ssp (momento da escolha).
 * full=true : pastas de todas as etapas + malhas e POIs copiados de base/ quando faltarem.
 */
async function ensure(dir, { baseDir, onProgress = () => {}, full = false } = {}) {
  const created = [];
  for (const rel of full ? LAYOUT : ROOT_LAYOUT) {
    const p = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(p)) { await fs.promises.mkdir(p, { recursive: true }); created.push(rel); }
  }
  const seeded = [];
  if (full) {
    for (const sub of ['streets', 'pois']) {
      const src = baseDir && path.join(baseDir, sub);
      const dst = path.join(dir, sub);
      if (!src || !fs.existsSync(src)) continue;
      const have = fs.readdirSync(dst).filter((f) => f.endsWith('.geojson')).length;
      if (have > 0) continue;
      onProgress({ step: sub, msg: `Copiando ${sub === 'streets' ? 'malhas das áreas' : 'pontos de interesse'}…` });
      await copyTree(src, dst, (name) => onProgress({ step: sub, msg: name }));
      seeded.push(sub);
    }
  }
  const markerPath = path.join(dir, MARKER);
  let marker = { createdAt: new Date().toISOString(), layout: 2 };
  try { if (fs.existsSync(markerPath)) marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { /* marcador corrompido: recria */ }
  marker.lastOpenedAt = new Date().toISOString();
  if (full && !marker.stagesCreatedAt) marker.stagesCreatedAt = marker.lastOpenedAt;
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  return { dir, created, seeded };
}

module.exports = { inspect, ensure, describe, stagesReady, hasSpreadsheets, PHASES, LAYOUT };
