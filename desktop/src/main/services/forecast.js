// Estado da Previsão e da Validação na pasta de trabalho, lido dos arquivos que o pipeline grava:
//   processed/datasets/dataset_full_<área>.csv   → até que semana há dados (lê só o fim do arquivo)
//   processed/models/                            → modelos de cada área
//   processed/results/results_ensemble_<área>_<AAAA_MM>.csv + previsao_<área>_<AAAA_MM>.json
//   processed/results/metrics_summary_all.csv    → métricas Foco/Cobertura/PAI por mês × área × modelo
//   processed/metrics/zhang_comparison.csv       → HitRn/HitEn/PAI (Zhang) por quantil
const fs = require('fs');
const path = require('path');

const HORIZON = 4; // semanas (config.FORECAST_HORIZON)
const MODEL_FILES = { RF: ['rf_{a}.pkl'], LSTM: ['lstm_{a}.pth', 'scaler_lstm_{a}.pkl'], Transformer: ['transformer_{a}.pth', 'scaler_transformer_{a}.pkl'] };
const tailCache = new Map();

const ls = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)); } catch { return []; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

/** Primeira e última semana do dataset e a última com alvo conhecido, lendo o início e o fim do arquivo. */
function datasetWeeks(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}|${st.mtimeMs}|${st.size}`;
  if (tailCache.has(key)) return tailCache.get(key);
  const fd = fs.openSync(file, 'r');
  try {
    const headBuf = Buffer.alloc(Math.min(65536, st.size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const headLines = headBuf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
    const cols = headLines[0].split(',');
    const iData = cols.indexOf('data'); const iT = cols.indexOf('target_month');
    if (iData < 0) return null;
    const first = (headLines[1] || '').split(',')[iData] || null;
    const n = Math.min(st.size, 1 << 20);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    const lines = buf.toString('utf8').split(/\r?\n/).slice(1).filter(Boolean);
    let last = null; let lastKnown = null;
    for (const l of lines) {
      const c = l.split(',');
      const d = (c[iData] || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (!last || d > last) last = d;
      if (iT >= 0 && c[iT] !== '' && c[iT] !== undefined && (!lastKnown || d > lastKnown)) lastKnown = d;
    }
    const r = { first: first ? first.slice(0, 10) : null, last, lastKnown: iT >= 0 ? lastKnown : last };
    tailCache.clear(); // um arquivo por área: cache pequeno
    tailCache.set(key, r);
    return r;
  } catch { return null; } finally { fs.closeSync(fd); }
}

/**
 * Último crime da área nos dados da Filtragem (processed/crimes/crimes_<área>.csv, todos os meses).
 * A validação usa esses crimes como gabarito, sem o corte da data final do período (Features).
 */
const crimeCache = new Map();
function crimesLast(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.mtimeMs}|${st.size}`;
  const c = crimeCache.get(file);
  if (c && c.key === key) return c.last;
  let last = null;
  try {
    const txt = fs.readFileSync(file, 'utf8');
    let i = txt.indexOf('\n') + 1;
    while (i > 0 && i < txt.length) {
      const d = txt.slice(i, i + 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!last || d > last)) last = d;
      const j = txt.indexOf('\n', i);
      i = j < 0 ? -1 : j + 1;
    }
  } catch { /* ilegível */ }
  crimeCache.set(file, { key, last });
  return last;
}
/** Última semana com o alvo (4 semanas seguintes) conhecido, a partir do último crime: semanas W-MON. */
function knownFromCrime(lastCrime) {
  if (!lastCrime) return null;
  const d = new Date(lastCrime + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7)); // segunda-feira que fecha a semana do último crime
  d.setUTCDate(d.getUTCDate() - HORIZON * 7);
  return d.toISOString().slice(0, 10);
}

/** Segunda-feira da primeira semana do mês (as semanas do dataset são rotuladas na segunda). */
function firstMonday(tag) {
  const [y, m] = tag.split('_').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  const add = (8 - d.getUTCDay()) % 7; // 0=domingo → +1; 1=segunda → 0
  d.setUTCDate(d.getUTCDate() + add);
  return d;
}
const iso = (d) => d.toISOString().slice(0, 10);
const addWeeks = (d, w) => new Date(d.getTime() + w * 7 * 86400000);

/** Lê um CSV simples (sem vírgulas dentro de campos) como lista de objetos. */
function readCsv(file) {
  try {
    const [head, ...rows] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const cols = head.split(',');
    return rows.map((r) => { const c = r.split(','); return Object.fromEntries(cols.map((k, i) => [k, c[i]])); });
  } catch { return []; }
}
const num = (v) => (v === undefined || v === '' ? null : Number(v));

function info(ws) {
  const P = (...p) => path.join(ws, 'processed', ...p);
  const areas = ls(P('datasets'), /^dataset_full_area_\d{2}\.csv$/).map((f) => f.match(/area_\d{2}/)[0]).sort();
  const results = ls(P('results'), /^results_ensemble_area_\d{2}_\d{4}_\d{2}\.csv$/);
  const geo = new Set(ls(P('results_geojson'), /^hotspots_Ensemble_area_\d{2}_\d{4}_\d{2}\.geojson$/));
  let dataEnd = null;
  try { const pj = JSON.parse(fs.readFileSync(path.join(ws, 'parametros.json'), 'utf8')); dataEnd = pj?.dataset?.fim || null; } catch { /* sem parâmetros */ }

  const perArea = {};
  for (const a of areas) {
    const ds = P('datasets', `dataset_full_${a}.csv`);
    const models = Object.entries(MODEL_FILES).filter(([, fs_]) => fs_.every((f) => fs.existsSync(P('models', f.replace('{a}', a))))).map(([m]) => m);
    const modelTime = Math.max(0, ...models.map((m) => mtime(P('models', MODEL_FILES[m][0].replace('{a}', a)))));
    const lastCrime = crimesLast(P('crimes', `crimes_${a}.csv`));
    perArea[a] = { area: a, weeks: datasetWeeks(ds), datasetTime: mtime(ds), models, modelTime, predictions: {}, lastCrime, knownCrime: knownFromCrime(lastCrime) };
  }

  for (const f of results) {
    const [, a, tag] = f.match(/^results_ensemble_(area_\d{2})_(\d{4}_\d{2})\.csv$/);
    if (!perArea[a]) perArea[a] = { area: a, weeks: null, models: [], predictions: {} };
    let side = null;
    try { side = JSON.parse(fs.readFileSync(P('results', `previsao_${a}_${tag}.json`), 'utf8')); } catch { /* previsão feita fora do app */ }
    perArea[a].predictions[tag] = {
      at: mtime(P('results', f)), geojson: geo.has(`hotspots_Ensemble_${a}_${tag}.geojson`),
      modo: side?.modo || null, semanaBase: side?.semana_base || null, modelos: side?.modelos ? Object.keys(side.modelos) : null,
      // o que estava diferente do padrão da dissertação nesta previsão (Mapa de risco, modelos)
      personalizado: side?.personalizado ? require('./padroes').resumo(side.personalizado) : [],
      treino: side?.treino || null,
    };
  }

  // validações já feitas (última por mês × área × modelo)
  const val = {};
  for (const r of readCsv(P('results', 'metrics_summary_all.csv'))) {
    if (!r.Tag || !r.Area || !r.Modelo) continue;
    const t = (val[r.Tag] = val[r.Tag] || {});
    const a = (t[r.Area] = t[r.Area] || {});
    a[r.Modelo] = {
      foco: num(r['Hit Rate (Foco)']), cobertura: num(r['Hit Rate (Cobertura)']), pai: num(r.PAI), f1: num(r['F1-Score']),
      precisao: num(r.Precision), recall: num(r.Recall), crimes: num(r['Crimes Totais']), em: r.Run_Timestamp || null,
    };
  }
  const zh = {};
  for (const r of readCsv(path.join(ws, 'processed', 'metrics', 'zhang_comparison.csv'))) {
    if (!r.Tag || Math.abs(Number(r.Quantile) - 0.9) > 1e-6) continue;
    ((zh[r.Tag] = zh[r.Tag] || {})[r.Area] = zh[r.Tag][r.Area] || {})[r.Model] = { hitrn: num(r.HitRn), hiten: num(r.HitEn), pai: num(r.PAI) };
  }

  // comparação justa (top exato da cobertura) com as duas linhas de base sem aprendizado
  const justa = {};
  for (const r of readCsv(path.join(ws, 'processed', 'metrics', 'linhas_base.csv'))) {
    if (!r.Tag || !r.Area || !r.modelo) continue;
    ((justa[r.Tag] = justa[r.Tag] || {})[r.Area] = justa[r.Tag][r.Area] || {})[r.modelo] = {
      base: r.base === 'True' || r.base === 'true', pai: num(r.pai), f1: num(r.f1), foco: num(r.foco), q: num(r.q),
    };
  }

  // meses previstos: quais áreas têm previsão, se dá para validar e se já foram validados
  const tags = [...new Set(Object.values(perArea).flatMap((x) => Object.keys(x.predictions)))].sort();
  const months = tags.map((tag) => {
    const lastNeeded = iso(addWeeks(firstMonday(tag), HORIZON - 1));
    const areasP = Object.values(perArea).filter((x) => x.predictions[tag]).map((x) => x.area).sort();
    // pronto para validar: o gabarito (crimes da Filtragem) cobre as 4 semanas seguintes à última semana prevista
    const known = (a) => [perArea[a].knownCrime, perArea[a].weeks?.lastKnown].filter(Boolean).sort().pop() || null;
    const ready = areasP.filter((a) => known(a) && known(a) >= lastNeeded);
    const needUntil = iso(addWeeks(new Date(lastNeeded + 'T00:00:00Z'), HORIZON));
    const validated = Object.keys(val[tag] || {}).sort();
    const modos = [...new Set(areasP.map((a) => perArea[a].predictions[tag].modo || 'desconhecido'))];
    const personalizado = [...new Set(areasP.flatMap((a) => perArea[a].predictions[tag].personalizado || []))];
    return { tag, areas: areasP, readyToValidate: ready, validated, lastNeeded, needUntil, modos, personalizado };
  });

  // mês sugerido para a previsão: o mês seguinte ao último dado do dataset
  const lasts = Object.values(perArea).map((x) => x.weeks?.last).filter(Boolean).sort();
  let suggested = null;
  if (lasts.length) {
    // primeiro mês cuja primeira semana começa depois do último dado
    const last = lasts[lasts.length - 1];
    const d = new Date(last + 'T00:00:00Z');
    d.setUTCDate(1);
    for (let i = 0; i < 3; i++) {
      const tag = `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      if (iso(firstMonday(tag)) > last) { suggested = tag.replace('_', '-'); break; }
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  return { areas: Object.values(perArea).sort((a, b) => a.area.localeCompare(b.area)), months, validations: val, zhang: zh, justa, suggested, dataEnd, horizon: HORIZON };
}

module.exports = { info, datasetWeeks, firstMonday };
