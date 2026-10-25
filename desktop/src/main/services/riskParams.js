// Mapa de risco: o que define o mapa final (Ensemble, pontos de interesse e área de cobertura).
//
// Os padrões são os da dissertação (pipeline/padroes_dissertacao.json → ENSEMBLE_CONFIG,
// COBERTURA, CORTE e METRICS_THRESHOLDS). O que o operador muda fica em
// <pasta de trabalho>/parametros.json → "mapaRisco" (só os campos diferentes do padrão) e vai
// para o pipeline como override na Previsão (o Ensemble é calculado nela) e na Validação (a
// cobertura e os critérios). Sem mudança, nada é enviado e o resultado é idêntico ao de antes.
const fs = require('fs');
const path = require('path');
const { padroes } = require('./padroes');

const P = padroes();
const E = P.ENSEMBLE_CONFIG;

// grupo = aba da tela. tipo: float | int | choice | bool | pct (fração mostrada em %)
const SCHEMA = [
  // ── Ensemble ──
  { k: 'w_rf', aba: 'ensemble', label: 'Peso do Random Forest', tipo: 'float', min: 0, max: 1, step: 0.05, padrao: E.MODEL_WEIGHTS.RF,
    faz: 'Quanto a probabilidade do Random Forest pesa na média ponderada. Os três pesos são renormalizados entre os modelos presentes.',
    mais: 'o mapa fica mais parecido com o do Random Forest.', menos: 'o Random Forest influencia menos; 0 tira o modelo do Ensemble (da média e do máximo).' },
  { k: 'w_lstm', aba: 'ensemble', label: 'Peso da LSTM', tipo: 'float', min: 0, max: 1, step: 0.05, padrao: E.MODEL_WEIGHTS.LSTM,
    faz: 'Quanto a probabilidade da LSTM pesa na média ponderada.', mais: 'o mapa segue mais a LSTM.', menos: 'a LSTM influencia menos; 0 tira o modelo.' },
  { k: 'w_transformer', aba: 'ensemble', label: 'Peso do Transformer', tipo: 'float', min: 0, max: 1, step: 0.05, padrao: E.MODEL_WEIGHTS.Transformer,
    faz: 'Quanto a probabilidade do Transformer pesa na média ponderada.', mais: 'o mapa segue mais o Transformer.', menos: 'o Transformer influencia menos; 0 tira o modelo.' },
  { k: 'mean_w', aba: 'ensemble', label: 'Peso da média (o resto vai para o máximo)', tipo: 'float', min: 0, max: 1, step: 0.05, padrao: E.HYBRID_FORMULA.MEAN_WEIGHT,
    faz: 'Risco = peso × média ponderada + (1 − peso) × maior probabilidade entre os modelos.',
    mais: 'mais conservador: uma célula só sobe se os modelos concordarem (menos alarmes falsos).', menos: 'mais sensível: basta um modelo apontar a célula (mais acertos e mais alarmes falsos).' },
  { k: 'combinacao', aba: 'ensemble', label: 'Como combinar os modelos', tipo: 'choice', padrao: E.COMBINACAO,
    opcoes: [['probabilidades', 'Probabilidades (dissertação)'], ['postos', 'Postos (percentil de cada célula em cada modelo)']],
    faz: 'Com postos, cada modelo entra pela ordem que dá às células, não pelo valor da probabilidade. Evita que um modelo com probabilidades mais altas domine.',
    mais: '', menos: '' },
  { k: 'filtro_on', aba: 'ensemble', label: 'Zerar células com pouco histórico', tipo: 'bool', padrao: E.MIN_HISTORICAL_CRIMES !== null,
    faz: 'Células com poucos crimes no histórico do dataset ficam com risco zero, para não acender por acaso.', mais: '', menos: 'Desligado, toda célula pode entrar no mapa.' },
  { k: 'filtro_n', aba: 'ensemble', label: 'Zerar células com até N crimes no histórico', tipo: 'int', min: 0, max: 100, step: 1, padrao: E.MIN_HISTORICAL_CRIMES ?? 1, dep: 'filtro_on',
    faz: 'Células com este número de crimes ou menos, em todo o histórico do dataset, são zeradas (com 1: zera as células com 0 ou 1 crime).',
    mais: 'mais células zeradas; o mapa se concentra onde o crime é recorrente.', menos: 'mais células podem acender.' },
  { k: 'suav_on', aba: 'ensemble', label: 'Suavização', tipo: 'bool', padrao: !!E.TEMPORAL_SMOOTHING.ENABLED,
    faz: 'Mistura o risco de cada célula com uma média móvel, para reduzir picos isolados.', mais: '', menos: '' },
  { k: 'suav_janela', aba: 'ensemble', label: 'Janela da suavização', tipo: 'int', min: 2, max: 8, step: 1, padrao: E.TEMPORAL_SMOOTHING.WINDOW, dep: 'suav_on',
    faz: 'Quantos valores entram na média móvel.', mais: 'mais suave.', menos: 'mais próximo do valor bruto.' },
  { k: 'suav_alfa', aba: 'ensemble', label: 'Força da suavização', tipo: 'float', min: 0, max: 1, step: 0.05, padrao: E.TEMPORAL_SMOOTHING.ALPHA, dep: 'suav_on',
    faz: 'Risco = força × suavizado + (1 − força) × bruto.', mais: 'mais suavizado.', menos: 'mais bruto (0 = sem efeito).' },
  { k: 'suav_eixo', aba: 'ensemble', label: 'Entre o quê', tipo: 'choice', padrao: E.TEMPORAL_SMOOTHING.EIXO, dep: 'suav_on',
    opcoes: [['grids', 'Células vizinhas na numeração (variante das simulações iniciais)'], ['semanas', 'Semanas seguidas da mesma célula']],
    faz: 'A variante das simulações iniciais faz a média móvel entre células com GRID_ID vizinho (a célula 120 com a 119), não entre semanas da mesma célula; a configuração final deixa a suavização desligada. "Semanas seguidas" faz o que o nome da opção sugere: suaviza cada célula ao longo das 4 semanas.',
    mais: '', menos: '' },
  // ── Pontos de interesse ──
  { k: 'poi_fator', aba: 'poi', label: 'Fator dos pontos de interesse', tipo: 'float', min: 0, max: 1, step: 0.05, padrao: E.POI_BOOST_FACTOR,
    faz: 'Risco × (1 + fator × escore de POI da célula). O escore vai de 0 a 1.', mais: 'os pontos de interesse mudam mais o mapa (com 0,15: até +15%).', menos: '0 desliga o ajuste.' },
  { k: 'poi_padrao', aba: 'poi', label: 'Peso dos tipos não listados', tipo: 'float', min: -5, max: 5, step: 0.5, padrao: E.POI_WEIGHTS._padrao ?? 1,
    faz: 'Peso de todo ponto de interesse que não tem peso próprio na tabela (na dissertação, restaurantes, bancos e lojas caem aqui).', mais: 'esses pontos aumentam mais o risco.', menos: '0 ignora esses pontos; negativo diminui o risco.' },
  { k: 'poi_normalizacao', aba: 'poi', label: 'Normalização do escore', tipo: 'choice', padrao: E.POI_NORMALIZACAO,
    opcoes: [['com_poi', 'Só entre as células com POI (dissertação)'], ['todas', 'Com todas as células (sem POI = 0)']],
    faz: 'O escore é a soma dos pesos na célula, levada para 0 a 1 (MinMax). Na dissertação, o MinMax usa só as células que têm algum POI, e as células sem POI ficam com 0: uma célula com delegacia (peso negativo) também vai a 0, igual a não ter POI. Com "todas as células", a soma 0 entra no MinMax, e a delegacia fica abaixo das células sem POI.',
    mais: '', menos: '' },
  // ── Área de cobertura ──
  { k: 'alto', aba: 'cobertura', label: 'Alto risco (área de patrulha)', tipo: 'pct', min: 0.01, max: 0.5, step: 0.01, padrao: P.COBERTURA.ALTO, sugestoes: [0.05, 0.10, 0.15, 0.20, 0.25],
    faz: 'Fração das células marcadas como alto risco (vermelho) no mapa, na previsão e na validação.', mais: 'cobre mais crimes, mas a área a patrulhar cresce (o PAI tende a cair).', menos: 'área menor e mais concentrada.' },
  { k: 'medio', aba: 'cobertura', label: 'Alto + médio risco', tipo: 'pct', min: 0.02, max: 0.9, step: 0.01, padrao: P.COBERTURA.MEDIO,
    faz: 'Fração das células marcadas como alto ou médio risco (vermelho + amarelo). Precisa ser maior que o alto risco.', mais: 'faixa amarela maior.', menos: 'faixa amarela menor.' },
  { k: 'corte', aba: 'cobertura', label: 'Regra de corte', tipo: 'choice', padrao: P.CORTE,
    opcoes: [['maior_igual', 'Maior ou igual ao quantil (dissertação)'], ['top_exato', 'Top exato (desempate aleatório com a semente)']],
    faz: 'Na dissertação, entram as células com risco maior ou igual ao valor do quantil. Quando muitas células têm o mesmo risco (empate no corte), a área marcada passa do valor escolhido; o top exato marca exatamente a fração escolhida, desempatando ao acaso com a semente.',
    mais: '', menos: '' },
  // ── Avançado (validação) ──
  { k: 'matriz', aba: 'avancado', label: 'O que conta como previsão positiva no F1', tipo: 'choice', padrao: P.METRICS_THRESHOLDS.CONFUSION_MATRIX_MODE,
    opcoes: [['HIGH_ONLY', 'Só o alto risco (dissertação)'], ['HIGH_AND_MEDIUM', 'Alto + médio risco']], faz: 'Muda precisão, recall e F1 da Validação.', mais: '', menos: '' },
  { k: 'crime_min', aba: 'avancado', label: 'Célula positiva: mais de N crimes', tipo: 'int', min: 0, max: 10, step: 1, padrao: P.METRICS_THRESHOLDS.REAL_CRIME_THRESHOLD,
    faz: 'Na Validação, a célula conta como "teve crime" quando passou deste número (0 = qualquer crime).', mais: 'só células com vários crimes contam.', menos: '' },
  { k: 'piso', aba: 'avancado', label: 'Piso do corte', tipo: 'float', min: 0, max: 0.5, step: 0.005, padrao: P.METRICS_THRESHOLDS.ABSOLUTE_MIN_PROB,
    faz: 'Células com risco abaixo deste valor nunca são alto risco na Validação.', mais: 'menos células marcadas quando o risco é baixo em toda a área.', menos: '' },
  { k: 'dinamico', aba: 'avancado', label: 'Corte dinâmico por área', tipo: 'bool', padrao: !!P.METRICS_THRESHOLDS.DYNAMIC_THRESHOLD, perigo: true,
    faz: 'Escolhe, por área, o corte que maximiza o F1 olhando os crimes reais do próprio mês avaliado. Usa os crimes reais para escolher o corte; não serve para avaliar o modelo. No Modo científico fica sempre desligado.',
    mais: '', menos: '' },
];
const ABAS = [
  ['ensemble', 'Ensemble', 'Como as probabilidades dos três modelos viram o risco de cada célula.'],
  ['poi', 'Pontos de interesse', 'Bares, delegacias, lojas…: ajuste do risco pelos pontos de interesse do OpenStreetMap na célula.'],
  ['cobertura', 'Área de cobertura', 'Quanto do mapa vira alto e médio risco.'],
  ['avancado', 'Avançado', 'Critérios da Validação.'],
];
const BY = Object.fromEntries(SCHEMA.map((p) => [p.k, p]));

// pesos por tipo de POI: chave 'amenity:<tipo>' ou 'shop:<tipo>'; os da dissertação usam o nome simples (amenity)
const POI_PADRAO = Object.fromEntries(Object.entries(E.POI_WEIGHTS).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k.includes(':') ? k : `amenity:${k}`, v]));

const paramsFile = (ws) => path.join(ws, 'parametros.json');
// chave de peso por categoria: 'amenity:bar', 'shop:clothes', 'arquivo:delegacia'… ou '(sem categoria)'
const POI_KEY = /^([^\s:]{1,40}:[^\s]{1,60}|\(sem categoria\))$/;
function readAll(ws) { try { return JSON.parse(fs.readFileSync(paramsFile(ws), 'utf8')); } catch { return {}; } }
function writeAll(ws, all) { fs.writeFileSync(paramsFile(ws), JSON.stringify(all, null, 2), 'utf8'); }

const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);

function check(p, v) {
  if (p.tipo === 'bool') return [v === true || v === 'true', null];
  if (p.tipo === 'choice') { const ok = p.opcoes.some(([x]) => x === v); return ok ? [v, null] : [null, 'Escolha uma das opções.']; }
  const n = Number(String(v).replace(',', '.'));
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return [null, 'Informe um número.'];
  if (p.tipo === 'int' && !Number.isInteger(n)) return [null, 'Use um número inteiro.'];
  if (n < p.min - 1e-12 || n > p.max + 1e-12) {
    const f = (x) => (p.tipo === 'pct' ? `${Math.round(x * 100)}%` : String(x).replace('.', ','));
    return [null, `Use um valor entre ${f(p.min)} e ${f(p.max)}.`];
  }
  return [p.tipo === 'pct' ? Math.round(n * 1000) / 1000 : n, null];
}

function cross(v) {
  const e = {};
  if (!(v.medio > v.alto)) e.medio = 'O alto + médio risco precisa ser maior que o alto risco.';
  if (!(v.w_rf + v.w_lstm + v.w_transformer > 0)) e.w_rf = 'Ao menos um modelo precisa ter peso maior que zero.';
  return e;
}

/** Valores atuais (padrão + mudanças salvas), no formato da tela. */
function current(ws, extra = null) {
  const saved = { ...(readAll(ws).mapaRisco?.valores || {}), ...(extra?.valores || {}) };
  const v = Object.fromEntries(SCHEMA.map((p) => [p.k, p.padrao]));
  for (const [k, raw] of Object.entries(saved)) {
    if (!BY[k]) continue;
    const [x, err] = check(BY[k], raw);
    if (!err) v[k] = x;
  }
  const poi = { ...POI_PADRAO, ...(readAll(ws).mapaRisco?.poi || {}), ...(extra?.poi || {}) };
  return { valores: v, poi };
}

function changed(cur) {
  const d = {};
  for (const p of SCHEMA) if (!near(cur.valores[p.k], p.padrao)) d[p.k] = cur.valores[p.k];
  const poi = {};
  for (const [k, w] of Object.entries(cur.poi)) if (!near(w, POI_PADRAO[k] ?? (E.POI_WEIGHTS._padrao ?? 1))) poi[k] = w;
  return { valores: d, poi };
}

/** Overrides para o pipeline. job: 'predict' | 'ensemble' | 'validate'. extra: valores ainda não salvos (pré-visualização). */
function overrides(ws, job, extra = null) {
  const cur = current(ws, extra);
  const ch = changed(cur);
  const v = cur.valores;
  const has = (...ks) => ks.some((k) => k in ch.valores);
  const o = {};
  if (job === 'predict' || job === 'ensemble') {
    const ens = {};
    if (has('w_rf', 'w_lstm', 'w_transformer')) ens.MODEL_WEIGHTS = { RF: v.w_rf, LSTM: v.w_lstm, Transformer: v.w_transformer };
    if (has('mean_w')) ens.HYBRID_FORMULA = { MEAN_WEIGHT: v.mean_w, MAX_WEIGHT: Math.round((1 - v.mean_w) * 1e6) / 1e6 };
    if (has('combinacao')) ens.COMBINACAO = v.combinacao;
    if (has('filtro_on', 'filtro_n')) ens.MIN_HISTORICAL_CRIMES = v.filtro_on ? v.filtro_n : null;
    if (has('suav_on', 'suav_janela', 'suav_alfa', 'suav_eixo')) ens.TEMPORAL_SMOOTHING = { ENABLED: v.suav_on, WINDOW: v.suav_janela, ALPHA: v.suav_alfa, EIXO: v.suav_eixo };
    if (has('poi_fator')) ens.POI_BOOST_FACTOR = v.poi_fator;
    if (has('poi_normalizacao')) ens.POI_NORMALIZACAO = v.poi_normalizacao;
    if (has('poi_padrao') || Object.keys(ch.poi).length) {
      // a tabela inteira: o merge do config.py só soma chaves
      ens.POI_WEIGHTS = { _padrao: v.poi_padrao, ...Object.fromEntries(Object.entries(cur.poi)) };
    }
    if (Object.keys(ens).length) o.ENSEMBLE_CONFIG = ens;
  }
  if (has('alto', 'medio')) o.COBERTURA = { ALTO: v.alto, MEDIO: v.medio };
  if (has('corte')) o.CORTE = v.corte;
  if (job === 'validate') {
    const mt = {};
    if (has('matriz')) mt.CONFUSION_MATRIX_MODE = v.matriz;
    if (has('crime_min')) mt.REAL_CRIME_THRESHOLD = v.crime_min;
    if (has('piso')) mt.ABSOLUTE_MIN_PROB = v.piso;
    if (has('dinamico')) mt.DYNAMIC_THRESHOLD = v.dinamico;
    if (Object.keys(mt).length) o.METRICS_THRESHOLDS = mt;
  }
  return o;
}

// ── categorias de POI que existem de fato na área (no conjunto ativo, tela Pontos de interesse) ──
function poiTypes(ws, area) {
  return require('./poiSets').categorias(ws, area);
}

// ── tamanho real do que vai virar alto risco ─────────────────────────────────────────────────
const gridCache = new Map();
function gridInfo(ws, area) {
  const f = path.join(ws, 'processed', 'grids', `${area}.geojson`);
  let st; try { st = fs.statSync(f); } catch { return null; }
  const key = `${f}|${st.mtimeMs}`;
  if (gridCache.has(key)) return gridCache.get(key);
  let celulas = 0;
  try {
    const ids = new Set();
    for (const ft of JSON.parse(fs.readFileSync(f, 'utf8')).features || []) ids.add(ft.properties?.GRID_ID);
    celulas = ids.size;
  } catch { return null; }
  // tamanho da célula: 200 m nas áreas da dissertação; o registro das áreas do operador guarda o dele
  let m = 200;
  try { const reg = JSON.parse(fs.readFileSync(path.join(ws, 'areas', 'areas.json'), 'utf8')); m = reg?.areas?.[area]?.celula_m || 200; } catch { /* dissertação */ }
  const out = { celulas, celulaM: m, km2: Math.round((m / 1000) ** 2 * 1e6) / 1e6 };
  gridCache.set(key, out);
  return out;
}

/** Empates no corte do alto risco na última previsão da área (quanto a regra "maior ou igual" passa do valor escolhido). */
function empate(ws, area, frac) {
  const dir = path.join(ws, 'processed', 'results');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => new RegExp(`^results_ensemble_${area}_\\d{4}_\\d{2}\\.csv$`).test(f)).sort(); } catch { return null; }
  const f = files.pop();
  if (!f) return null;
  const [head, ...rows] = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean);
  const cols = head.split(',');
  const ig = cols.indexOf('GRID_ID'), ip = cols.indexOf('probabilidade_risco');
  const sum = new Map(), cnt = new Map();
  for (const r of rows) { const c = r.split(','); const g = c[ig]; sum.set(g, (sum.get(g) || 0) + Number(c[ip])); cnt.set(g, (cnt.get(g) || 0) + 1); }
  const v = [...sum.keys()].map((g) => sum.get(g) / cnt.get(g)).sort((a, b) => a - b);
  if (!v.length) return null;
  // quantil como no pandas (interpolação linear) e piso de 0,01 do mapa
  const q = 1 - frac, pos = q * (v.length - 1), lo = Math.floor(pos);
  const thr = Math.max(v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo), 0.01);
  const sel = v.filter((x) => x >= thr - 1e-12).length / v.length;
  return { mes: f.match(/(\d{4}_\d{2})\.csv$/)[1], fracMaiorIgual: sel, colapso: sel > frac + 0.05 };
}

function view(ws, area = null) {
  const cur = current(ws);
  const ch = changed(cur);
  const areas = [];
  try { for (const f of fs.readdirSync(path.join(ws, 'processed', 'grids'))) { const m = f.match(/^(area_\d+)\.geojson$/); if (m) areas.push(m[1]); } } catch { /* sem malhas */ }
  areas.sort();
  const a = area && areas.includes(area) ? area : areas[0] || null;
  const tipos = a ? poiTypes(ws, a) : null;
  let poiConjunto = null;
  try { const l = require('./poiSets').list(ws); poiConjunto = l.conjuntos.find((c) => c.id === l.ativo) || null; } catch { /* sem pasta de POIs */ }
  const grid = a ? gridInfo(ws, a) : null;
  return {
    schema: SCHEMA, abas: ABAS, valores: cur.valores, poi: cur.poi, poiPadrao: POI_PADRAO, poiPadraoGeral: E.POI_WEIGHTS._padrao ?? 1,
    mudados: ch, nMudados: Object.keys(ch.valores).length + Object.keys(ch.poi).length,
    area: a, areas, tipos, grid, empate: a ? empate(ws, a, cur.valores.alto) : null, poiConjunto,
  };
}

function set(ws, { valores = {}, poi = {} } = {}) {
  const cur = current(ws);
  const erros = {};
  const next = { ...cur.valores };
  for (const [k, raw] of Object.entries(valores)) {
    if (!BY[k]) continue;
    const [x, err] = check(BY[k], raw);
    if (err) erros[k] = err; else next[k] = x;
  }
  Object.assign(erros, Object.keys(erros).length ? {} : cross(next));
  const nextPoi = { ...cur.poi };
  for (const [k, w] of Object.entries(poi)) {
    if (!POI_KEY.test(k)) continue;
    const n = Number(String(w).replace(',', '.'));
    if (w === null || w === '') { delete nextPoi[k]; continue; }
    if (!Number.isFinite(n) || n < -10 || n > 10) { erros[`poi:${k}`] = 'Use um peso entre -10 e 10.'; continue; }
    nextPoi[k] = n;
  }
  if (Object.keys(erros).length) throw Object.assign(new Error(Object.values(erros)[0]), { campos: erros });
  const ch = changed({ valores: next, poi: nextPoi });
  const all = readAll(ws);
  all.mapaRisco = { valores: ch.valores, poi: ch.poi };
  if (!Object.keys(ch.valores).length && !Object.keys(ch.poi).length) delete all.mapaRisco;
  all.mapaRiscoAtualizadoEm = new Date().toISOString();
  writeAll(ws, all);
}

/** Volta ao padrão da dissertação: uma aba ('ensemble' | 'poi' | 'cobertura' | 'avancado') ou tudo (null). */
function reset(ws, aba = null) {
  const all = readAll(ws);
  if (all.mapaRisco) {
    if (!aba) delete all.mapaRisco;
    else {
      for (const p of SCHEMA) if (p.aba === aba) delete all.mapaRisco.valores?.[p.k];
      if (aba === 'poi') delete all.mapaRisco.poi;
    }
  }
  all.mapaRiscoAtualizadoEm = new Date().toISOString();
  writeAll(ws, all);
}

/** Valida valores ainda não salvos (pré-visualização) e devolve o "extra" para overrides(). */
function draft(ws, d) {
  const extra = { valores: {}, poi: {} };
  for (const [k, raw] of Object.entries(d?.valores || {})) {
    if (!BY[k]) continue;
    const [x, err] = check(BY[k], raw);
    if (err) throw new Error(`${BY[k].label}: ${err}`);
    extra.valores[k] = x;
  }
  for (const [k, w] of Object.entries(d?.poi || {})) if (POI_KEY.test(k) && Number.isFinite(Number(w))) extra.poi[k] = Number(w);
  const e = cross(current(ws, extra).valores);
  if (Object.keys(e).length) throw new Error(Object.values(e)[0]);
  return extra;
}

/** Resultado da última pré-visualização (job ensemble --previa). */
function previa(ws, area, tag) {
  if (!/^area_\d+$/.test(area || '') || !/^\d{4}_\d{2}$/.test(tag || '')) return null;
  const dir = path.join(ws, 'processed', 'results');
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dir, `previa_${area}_${tag}.json`), 'utf8'));
    const g = JSON.parse(fs.readFileSync(path.join(dir, `previa_${area}_${tag}.geojson`), 'utf8'));
    return { ...r, geojson: undefined, features: (g.features || []).map((f) => ({ id: f.properties.GRID_ID, estado: f.properties.estado, geometry: f.geometry })) };
  } catch { return null; }
}

module.exports = { SCHEMA, ABAS, view, set, reset, draft, overrides, current, changed, previa, POI_PADRAO };
