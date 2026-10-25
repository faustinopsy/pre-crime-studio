// Planos das sequências e os passos internos.
//
// Ciclo mensal (o fluxo do operador, README do projeto):
//   planilha nova da SSP → Limpeza → Filtragem → Features (até o último mês) → Validação dos
//   meses previstos que agora têm crimes reais → Treino (opcional) → Previsão do próximo mês →
//   pacote de publicação (montado e verificado; a pré-visualização e a exportação ficam na tela
//   Publicação).
//
// Modo científico:
//   para cada semente: Features com DATA_END = fim do mês anterior ao 1º mês → Treino (semente) →
//   Previsão do 1º mês; para cada mês seguinte: Features com DATA_END = fim do mês anterior →
//   Previsão (mesmos modelos, sem retreino). Depois: Features com todos os dados → Validação de
//   cada mês, por semente. Com mais de uma semente, os resultados de cada uma ficam em
//   processed/replay_seeds/seed_<n>/ e o resumo (média ± desvio) em processed/replay_seeds/.
const fs = require('fs');
const path = require('path');
const { endOfPrevMonth, addMonths } = require('./sequence');
const poiSets = require('./poiSets');

const MODELS = ['RF', 'LSTM', 'Transformer', 'Ensemble'];
const tagOf = (mes) => mes.replace('-', '_');
const monthLabel = (mes) => mes.split(/[-_]/).reverse().join('/');

/** Tempo médio das últimas execuções completas de uma fase (todas as áreas), em segundos. */
function estimate(runs, ws, job, area = null) {
  const all = runs.list(ws, { job, limit: 20 }).filter((m) => m.status === 'ok' && m.secs);
  const avg = (l) => Math.round(l.slice(0, 3).reduce((s, m) => s + m.secs, 0) / Math.min(3, l.length));
  if (area) {
    const same = all.filter((m) => m.area === area);
    if (same.length) return avg(same);
    // execuções de todas as áreas: divide pelo número de áreas que elas processaram
    const full = all.filter((m) => !m.area);
    if (!full.length) return null;
    const n = Object.keys(full[0].metrics?.areas || {}).length || full[0].metrics?.plan?.areas?.length || 8;
    return Math.round(avg(full) / Math.max(1, n));
  }
  const full = all.filter((m) => !m.area);
  return full.length ? avg(full) : null;
}

// ── Ciclo mensal ─────────────────────────────────────────────────────────────────────────────
function cyclePlan(ws, { runs, workspace, forecast, sspProfile, hardware }) {
  const st = workspace.inspect(ws);
  const by = Object.fromEntries(st.phases.map((p) => [p.id, p]));
  const fi = forecast.info(ws);
  let dv = null; try { dv = sspProfile.datasetView(ws); } catch { /* sem planilhas */ }
  const lastData = dv?.last || null;
  const tr = by.train;
  const modelTimes = Object.values(tr.modelTimes || {});
  const oldestModel = modelTimes.length ? Math.min(...modelTimes) : null;
  const modelAgeDays = oldestModel ? Math.round((Date.now() - oldestModel) / 864e5) : null;
  const pendingVal = fi.months.filter((m) => m.validated.length < m.areas.length).map((m) => m.tag);
  const eco = hardware?.verdict?.profile === 'eco';
  // modelos que vieram de um replay (treinados com data final) não servem para prever o mês seguinte
  const lastTrain = runs.list(ws, { job: 'train', limit: 5 }).find((m) => m.status === 'ok');
  const replayModels = lastTrain?.options?.dataEnd || null;

  const steps = [
    { id: 'clean', kind: 'job', job: 'clean', label: 'Limpeza', what: 'Junta as planilhas da SSP numa base só, com os parâmetros da tela Limpeza.',
      skip: by.clean.status === 'done', reason: by.clean.status === 'done' ? 'A base unificada já está em dia com as planilhas.' : by.clean.reason || null },
    { id: 'filter', kind: 'job', job: 'filter', label: 'Filtragem', what: 'Coloca cada crime na sua célula, em todas as áreas.',
      skip: by.clean.status === 'done' && by.filter.status === 'done' },
    { id: 'features', kind: 'job', job: 'features', label: 'Features', what: `Monta o dataset até o último mês com dados${lastData ? ` (${monthLabel(lastData)})` : ''}, a partir do início escolhido na tela Features.`,
      overrides: { DATA_END: null },
      skip: by.clean.status === 'done' && by.filter.status === 'done' && by.features.status === 'done' },
    { id: 'validate', kind: 'job', job: 'validate', resolve: 'validateReady', label: 'Validação', what: pendingVal.length
      ? `Compara com os crimes reais as previsões ainda não validadas (${pendingVal.map(monthLabel).join(', ')}), nas áreas em que o mês já está completo.`
      : 'Nenhuma previsão esperando validação.', skip: !pendingVal.length },
    { id: 'train', kind: 'job', job: 'train', label: 'Treino', what: modelAgeDays == null ? 'Ainda não há modelos: o treino é necessário.'
      : replayModels ? `Os modelos atuais vieram do modo científico (treinados só com dados até ${replayModels.split('-').reverse().join('/')}). Treine de novo com todos os dados antes de prever.`
      : `Os modelos têm ${modelAgeDays} dia(s). Treinar de novo é opcional (recomendado a cada 3 meses); sem treino, a previsão usa os modelos atuais.`,
      opts: { completo: false, modo: eco ? 'sequencial' : 'paralelo', modelos: ['rf', 'lstm', 'transformer'] },
      skip: !(modelAgeDays == null || modelAgeDays > 90 || replayModels) },
    { id: 'predict', kind: 'job', job: 'predict', resolve: 'predictNext', label: 'Previsão', what: 'Prevê o mês seguinte ao último dado (calculado depois das Features).' },
    { id: 'publish', kind: 'internal', internal: 'publishCycle', label: 'Pacote de publicação', what: 'Monta e verifica o pacote com o mês previsto e os meses validados. A pré-visualização e a exportação ficam na tela Publicação.' },
  ];
  for (const s of steps) s.secs = s.kind === 'job' ? estimate(runs, ws, s.job) : 30;
  return {
    kind: 'ciclo', title: 'Ciclo mensal',
    state: {
      lastData, sspFiles: by.ssp.files?.length || 0, cleanStatus: by.clean.status, cleanReason: by.clean.reason,
      datasetFim: dv?.dataset?.fim || null, models: modelTimes.length, modelAgeDays, suggested: fi.suggested,
      pendingValidation: pendingVal, months: fi.months,
    },
    steps,
  };
}

// ── Modo científico ──────────────────────────────────────────────────────────────────────────
const VARIANTES = ['semrf', 'semmax', 'sempoi', 'semfiltro', 'comsuav', 'ranks'];
const ddmmaaaa = (d) => d.split('-').reverse().join('/');

function replayPlan(ws, params, { runs, hardware, sspProfile }) {
  const meses = [...new Set(params.meses || [])].filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
  if (!meses.length) throw new Error('Escolha ao menos um mês para o replay.');
  if (meses.length > 24) throw new Error('O replay aceita no máximo 24 meses.');
  const seeds = [...new Set((params.seeds || [42]).map(Number).filter((n) => Number.isInteger(n) && n >= 0))];
  if (!seeds.length) throw new Error('Informe ao menos uma semente.');
  const modelos = (params.modelos?.length ? params.modelos : ['rf', 'lstm', 'transformer']);
  const modo = params.modo || (hardware?.verdict?.profile === 'eco' ? 'sequencial' : 'paralelo');
  const area = /^area_\d{2}$/.test(params.area || '') ? params.area : null;
  const retreino = [0, 1, 2, 3, 4, 6, 12].includes(Number(params.retreino)) ? Number(params.retreino) : 0;
  const variantes = params.variantes ? VARIANTES.filter((v) => (Array.isArray(params.variantes) ? params.variantes : VARIANTES).includes(v)) : [];
  const vazamento = !!params.vazamento;
  const padrao = !params.personalizado;   // Modelos, Ensemble e cobertura: padrão da dissertação, a não ser que o operador peça
  // pontos de interesse: conjunto usado no replay (padrão: o da dissertação), ablação por categoria
  // (sem_<categoria> e sempoi) e comparação com outros conjuntos (poi_<id>), sobre as mesmas previsões
  const okPoi = (id) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(id || '') && (id === poiSets.ID_DISS || poiSets.manifesto(ws, id)?.status === 'pronto');
  const poiSet = params.poiSet || poiSets.ID_DISS;
  if (!okPoi(poiSet)) throw new Error(`O conjunto de pontos de interesse "${poiSet}" não existe ou não foi salvo.`);
  const ablacaoPoi = !!params.ablacaoPoi;
  const compararConjuntos = [...new Set((params.compararConjuntos || []).map(String))].filter((id) => id !== poiSet);
  for (const id of compararConjuntos) if (!okPoi(id)) throw new Error(`O conjunto de pontos de interesse "${id}" não existe ou não foi salvo.`);
  const pedidas = [...variantes];
  if (ablacaoPoi) { if (!pedidas.includes('sempoi')) pedidas.push('sempoi'); pedidas.push('poicat'); }
  for (const id of compararConjuntos) pedidas.push(`poiset:${id}`);
  const P = { poiSet };
  // variantes do Ensemble de replays anteriores (que ficam em processed/results) não entram nas sementes deste
  const desde = Date.now();
  const A = area ? { area } : {};
  const multi = seeds.length > 1;
  const principal = seeds[0];
  // a semente principal (a primeira) roda por último: os modelos e resultados que ficam na pasta são os dela
  const order = multi ? [...seeds.slice(1), seeds[0]] : seeds;
  const steps = [];
  const est = Object.fromEntries(['features', 'train', 'predict', 'validate', 'ensemble', 'science'].map((j) => [j, estimate(runs, ws, j, area)]));
  // origem móvel: treino no 1º mês e a cada N meses (N = 0: só no início)
  const origens = [];
  let treinoAte = null;
  meses.forEach((mes, i) => {
    if (i === 0 || (retreino && i % retreino === 0)) treinoAte = endOfPrevMonth(mes);
    origens.push({ mes, treinoAte, retreino: i === 0 || (retreino > 0 && i % retreino === 0) });
  });
  for (const s of order) {
    const sl = multi ? ` · semente ${s}` : '';
    meses.forEach((mes, i) => {
      const de = endOfPrevMonth(mes);
      const ov = { DATA_END: de, GLOBAL_SEED: s };
      steps.push({ kind: 'job', job: 'features', label: `Features até ${ddmmaaaa(de)}${sl}`, overrides: ov, opts: { ...A }, secs: est.features });
      if (origens[i].retreino) steps.push({ kind: 'job', job: 'train', padrao, label: `Treino com dados até ${ddmmaaaa(de)}${sl}`, overrides: ov, opts: { completo: false, modo, modelos, ...A }, secs: est.train });
      steps.push({ kind: 'job', job: 'predict', padrao, ...P, label: `Previsão de ${monthLabel(mes)}${origens[i].retreino ? '' : ` (modelos treinados até ${ddmmaaaa(origens[i].treinoAte)})`}${sl}`, overrides: ov, opts: { mes, modelos, ...A }, secs: est.predict });
      if (pedidas.length) {
        const nomeV = [variantes.length ? `${variantes.length} variante(s)` : null, ablacaoPoi ? 'ablação por categoria de POI' : null, compararConjuntos.length ? `${compararConjuntos.length} conjunto(s) de POI` : null].filter(Boolean).join(' + ');
        steps.push({ kind: 'job', job: 'ensemble', padrao, ...P, label: `Variantes do Ensemble de ${monthLabel(mes)} (${nomeV})${sl}`, overrides: ov, opts: { mes, variantes: pedidas, ...A }, secs: (est.ensemble || 20) * (ablacaoPoi ? 4 : 1) });
      }
    });
    steps.push({ kind: 'internal', internal: 'snapshotSeed', label: `Guardar as previsões da semente ${s}`, args: { seed: s, meses, origens, variantes, area, desde }, secs: 2 });
  }
  steps.push({ kind: 'job', job: 'features', label: 'Features com todos os dados (crimes reais dos meses)', overrides: { DATA_END: null }, opts: { ...A }, secs: est.features });
  for (const s of order) {
    const sl = multi ? ` · semente ${s}` : '';
    if (multi) steps.push({ kind: 'internal', internal: 'restoreSeed', label: `Repor as previsões da semente ${s}`, args: { seed: s, meses, variantes, area }, secs: 2 });
    for (const mes of meses) steps.push({ kind: 'job', job: 'validate', padrao, resolve: 'validateIfReady', args: { mes, ...A }, label: `Validação de ${monthLabel(mes)}${sl}`, secs: est.validate });
    steps.push({ kind: 'internal', internal: 'collectSeed', label: `Registrar as métricas${sl || ' do replay'}`, args: { seed: s, meses }, secs: 2 });
    steps.push({ kind: 'job', job: 'science', ...P, label: `Métricas científicas${sl} (top-k exato, linhas de base, calibração, Wilcoxon)`, opts: { meses, seed: s, acao: 'metricas', ...A }, secs: est.science || 60 });
  }
  if (multi) {
    steps.push({ kind: 'internal', internal: 'aggregateSeeds', label: `Resumo das ${seeds.length} sementes (média ± desvio)`, args: { seeds, meses }, secs: 2 });
    steps.push({ kind: 'job', job: 'science', ...P, label: `Métricas das ${seeds.length} sementes juntas (média, desvio, Wilcoxon)`, opts: { meses, seeds, acao: 'agregar' }, secs: 20 });
  }
  if (vazamento) {
    // só para comparação: treina com todos os dados e prevê os mesmos meses (não é uma avaliação válida)
    const ov = { DATA_END: null, GLOBAL_SEED: principal };
    steps.push({ kind: 'job', job: 'train', padrao, label: `COM VAZAMENTO · treino com todos os dados (semente ${principal})`, overrides: ov, opts: { completo: false, modo, modelos, ...A }, secs: est.train });
    for (const mes of meses) steps.push({ kind: 'job', job: 'predict', padrao, ...P, label: `COM VAZAMENTO · previsão de ${monthLabel(mes)}`, overrides: ov, opts: { mes, modelos, ...A }, secs: est.predict });
    steps.push({ kind: 'internal', internal: 'snapshotLeak', label: 'Guardar as previsões com vazamento', args: { seed: principal, meses, area }, secs: 2 });
    steps.push({ kind: 'job', job: 'science', ...P, label: 'Métricas com e sem vazamento (comparação)', opts: { meses, seed: principal, acao: 'vazamento', ...A }, secs: est.science || 60 });
    steps.push({ kind: 'internal', internal: 'restoreSeed', label: `Repor as previsões do replay (semente ${principal})`, args: { seed: principal, meses, variantes, area }, secs: 2 });
  }

  // os meses precisam de crimes reais completos para a validação no fim
  let aviso = null;
  try {
    const last = sspProfile.datasetView(ws).last;
    const need = addMonths(meses[meses.length - 1], 2);
    if (last && last < need) aviso = `A base vai até ${monthLabel(last)}. Para validar ${monthLabel(meses[meses.length - 1])} são precisos os crimes reais até ${monthLabel(need)} (as 4 semanas seguintes a cada semana prevista). A previsão roda; a validação e as métricas dos últimos meses podem falhar.`;
  } catch { /* sem perfil */ }
  let malha = null;
  try { malha = sspProfile.readFilter(ws).removerCelulasRepetidas ? 'sem células repetidas' : 'original (com células repetidas)'; } catch { /* sem parâmetros */ }
  const nTreinos = origens.filter((o) => o.retreino).length;
  return {
    kind: 'replay',
    title: `Replay sem vazamento · ${meses.length > 4 ? `${monthLabel(meses[0])} a ${monthLabel(meses[meses.length - 1])}` : meses.map(monthLabel).join(', ')}${area ? ` · ${area.replace('area_', 'área ')}` : ''}${multi ? ` · ${seeds.length} sementes` : ''}${retreino ? ` · retreino a cada ${retreino}` : ''}${poiSet !== poiSets.ID_DISS ? ` · POI ${poiSet}` : ''}`,
    params: { meses, seeds, modelos, modo, area, retreino, variantes, vazamento, padraoDissertacao: padrao && poiSet === poiSets.ID_DISS, malha, origens, nTreinos, poiSet, ablacaoPoi, compararConjuntos },
    steps, aviso, origens,
  };
}

// ── Passos internos ──────────────────────────────────────────────────────────────────────────
function seedDir(ws, seed) { return path.join(ws, 'processed', 'replay_seeds', `seed_${seed}`); }
// previsões do replay: membros, Ensemble e as variantes conhecidas (a pré-visualização da tela Mapa de risco fica de fora);
// com uma área escolhida, só os arquivos dela
const RESULT_RE = (tags, area = null) => (area = /^area_\d+$/.test(area || '') ? area : null, new RegExp(`^(results_(rf|lstm|transformer|ensemble(-(?!previa)[a-z0-9.-]+)?)_${area || 'area_\\d+'}|previsao_${area || 'area_\\d+'}|grid_history_${area || 'area_\\d+'})_(${tags.join('|')})\\.(csv|json)$`));

/** Move para _anteriores/<data> os arquivos que casam (a pasta nunca perde resultados antigos). */
function clearMatching(dir, re) {
  let old = [];
  try { old = fs.readdirSync(dir).filter((f) => re.test(f)); } catch { return 0; }
  if (!old.length) return 0;
  const dest = path.join(dir, '_anteriores', new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'));
  fs.mkdirSync(dest, { recursive: true });
  for (const f of old) fs.renameSync(path.join(dir, f), path.join(dest, f));
  return old.length;
}

function copyMatching(fromDir, toDir, re) {
  fs.mkdirSync(toDir, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(fromDir)) if (re.test(f)) { fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f)); n++; }
  return n;
}

function readCsv(file) {
  try {
    const [head, ...rows] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    const cols = head.split(',');
    return { cols, rows: rows.map((r) => { const c = r.split(','); return Object.fromEntries(cols.map((k, i) => [k, c[i]])); }) };
  } catch { return { cols: [], rows: [] }; }
}
const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n') + '\n';

function makeInternals({ publisher, forecast, send, log }) {
  return {
    async snapshotSeed(ws, { seed, meses, origens, area, desde = 0 }) {
      const dir = seedDir(ws, seed);
      // previsões de um replay anterior da mesma semente (outros meses ou variantes) não se misturam
      clearMatching(dir, /^results_.*\.csv$|^(previsao|grid_history)_area_.*\.json$/);
      // variantes do Ensemble: só as gravadas por este replay (as de replays anteriores continuam em processed/results)
      const res = path.join(ws, 'processed', 'results');
      const re = RESULT_RE(meses.map(tagOf), area);
      const novo = (f) => { try { return fs.statSync(path.join(res, f)).mtimeMs >= desde - 2000; } catch { return false; } };
      const n = copyMatching(res, dir, { test: (f) => re.test(f) && (!/^results_ensemble-/.test(f) || novo(f)) });
      if (origens) fs.writeFileSync(path.join(dir, 'origens.json'), JSON.stringify(origens, null, 1));
      return `${n} arquivo(s) guardados em processed/replay_seeds/seed_${seed}`;
    },
    async snapshotLeak(ws, { seed, meses, area }) {
      const dir = `${seedDir(ws, seed)}_vazamento`;
      clearMatching(dir, /^results_.*\.csv$|^(previsao|grid_history)_area_.*\.json$/);
      // só o que a versão com vazamento previu (as variantes do Ensemble não rodam nela)
      const re = RESULT_RE(meses.map(tagOf), area);
      const n = copyMatching(path.join(ws, 'processed', 'results'), dir, { test: (f) => re.test(f) && !/^results_ensemble-/.test(f) });
      return `${n} arquivo(s) com vazamento guardados em processed/replay_seeds/seed_${seed}_vazamento`;
    },
    async restoreSeed(ws, { seed, meses, area }) {
      const dir = seedDir(ws, seed);
      if (!fs.existsSync(dir)) throw new Error(`Não há previsões guardadas da semente ${seed}.`);
      const n = copyMatching(dir, path.join(ws, 'processed', 'results'), RESULT_RE(meses.map(tagOf), area));
      return `${n} arquivo(s) da semente ${seed} de volta em processed/results`;
    },
    async collectSeed(ws, { seed, meses }) {
      const tags = meses.map(tagOf);
      const dir = seedDir(ws, seed);
      fs.mkdirSync(dir, { recursive: true });
      const ms = readCsv(path.join(ws, 'processed', 'results', 'metrics_summary_all.csv'));
      const rows = ms.rows.filter((r) => tags.includes(r.Tag));
      if (ms.cols.length) fs.writeFileSync(path.join(dir, 'metrics_summary.csv'), toCsv(ms.cols, rows));
      const zh = readCsv(path.join(ws, 'processed', 'metrics', 'zhang_comparison.csv'));
      if (zh.cols.length) fs.writeFileSync(path.join(dir, 'zhang_comparison.csv'), toCsv(zh.cols, zh.rows.filter((r) => tags.includes(r.Tag))));
      let atual = {}; try { atual = JSON.parse(fs.readFileSync(path.join(dir, 'semente.json'), 'utf8')); } catch { /* primeira vez */ }
      fs.writeFileSync(path.join(dir, 'semente.json'), JSON.stringify({ ...atual, seed, meses, registradoEm: new Date().toISOString() }, null, 1));
      return `${rows.length} linha(s) de métricas da semente ${seed}`;
    },
    async aggregateSeeds(ws, { seeds, meses }) {
      const tags = meses.map(tagOf);
      const groups = new Map();
      const KEYS = [['foco', 'Hit Rate (Foco)'], ['cobertura', 'Hit Rate (Cobertura)'], ['pai', 'PAI'], ['f1', 'F1-Score']];
      for (const s of seeds) {
        for (const r of readCsv(path.join(seedDir(ws, s), 'metrics_summary.csv')).rows) {
          if (!tags.includes(r.Tag)) continue;
          const k = `${r.Tag}|${r.Area}|${r.Modelo}`;
          if (!groups.has(k)) groups.set(k, { Tag: r.Tag, Area: r.Area, Modelo: r.Modelo, vals: {} });
          const g = groups.get(k);
          for (const [key, col] of KEYS) (g.vals[key] = g.vals[key] || []).push(Number(r[col]));
        }
      }
      const stat = (v) => {
        const n = v.length, mean = v.reduce((a, b) => a + b, 0) / n;
        const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
        return { n, mean, sd, min: Math.min(...v), max: Math.max(...v) };
      };
      const out = [...groups.values()].map((g) => ({ Tag: g.Tag, Area: g.Area, Modelo: g.Modelo, ...Object.fromEntries(KEYS.map(([k]) => [k, stat(g.vals[k] || [])])) }));
      const dir = path.join(ws, 'processed', 'replay_seeds');
      fs.mkdirSync(dir, { recursive: true });
      const cols = ['Tag', 'Area', 'Modelo', 'n', ...KEYS.flatMap(([k]) => [`${k}_media`, `${k}_dp`, `${k}_min`, `${k}_max`])];
      fs.writeFileSync(path.join(dir, 'resumo_multiseed.csv'), toCsv(cols, out.map((r) => ({
        Tag: r.Tag, Area: r.Area, Modelo: r.Modelo, n: r.foco.n,
        ...Object.fromEntries(KEYS.flatMap(([k]) => [[`${k}_media`, r[k].mean], [`${k}_dp`, r[k].sd], [`${k}_min`, r[k].min], [`${k}_max`, r[k].max]])),
      }))));
      fs.writeFileSync(path.join(dir, 'resumo_multiseed.json'), JSON.stringify({ seeds, meses, geradoEm: new Date().toISOString(), linhas: out }, null, 1));
      return `${out.length} combinações mês × área × modelo, ${seeds.length} sementes`;
    },
    async publishCycle(ws, _args, rec, progress) {
      const pred = rec.steps.find((s) => s.id === 'predict')?.runs.filter((r) => r.status === 'ok').map((r) => tagOf(r.mes)) || [];
      const val = rec.steps.find((s) => s.id === 'validate')?.runs.filter((r) => r.status === 'ok').map((r) => tagOf(r.mes)) || [];
      const tags = [...new Set([...pred, ...val])].sort();
      if (!tags.length) return 'Nada novo para publicar neste ciclo.';
      const fi = forecast.info(ws);
      const areas = [...new Set(fi.months.filter((m) => tags.includes(m.tag)).flatMap((m) => m.areas))];
      const opt = publisher.options(ws, fi);
      const r = await publisher.build(ws, { tags, areas, models: ['Ensemble', 'RF', 'LSTM', 'Transformer'], crimes: true, metricas: true, ruas: false, site: opt.site },
        (ev) => { send('publish:event', ev); if (ev.t === 'progress') progress(ev); });
      return `Pacote de ${tags.map(monthLabel).join(', ')} montado (${(r.manifest.tamanho / 1048576).toFixed(1)} MB) · verificação ${r.verify?.ok ? 'ok' : 'com problemas'}. Abra a tela Publicação para pré-visualizar e exportar.`;
    },
  };
}

function makeResolvers({ forecast }) {
  return {
    // meses previstos que agora têm os crimes reais completos e ainda não foram validados
    validateReady(ws) {
      const fi = forecast.info(ws);
      const list = fi.months.filter((m) => m.readyToValidate.some((a) => !m.validated.includes(a))).map((m) => ({ mes: m.tag.replace('_', '-') }));
      return list.length ? list : [{ motivo: 'Nenhuma previsão com crimes reais completos para validar ainda.' }];
    },
    // replay: valida o mês se os crimes reais dele já estão completos no dataset
    validateIfReady(ws, step) {
      const tag = tagOf(step.args.mes);
      const m = forecast.info(ws).months.find((x) => x.tag === tag);
      const ok = step.args.area ? m?.readyToValidate.includes(step.args.area) : m?.readyToValidate.length;
      return ok ? [{ mes: step.args.mes, ...(step.args.area ? { area: step.args.area } : {}) }] : [{ motivo: `Os crimes reais de ${monthLabel(step.args.mes)} ainda não estão completos no dataset.` }];
    },
    // o mês seguinte ao último dado do dataset (depois das Features deste ciclo)
    predictNext(ws) {
      const fi = forecast.info(ws);
      return fi.suggested ? [{ mes: fi.suggested }] : [{ motivo: 'Não há dataset para prever.' }];
    },
  };
}

/** Resumo do multi-seed para a tela (se existir). */
function replaySummary(ws) {
  try { return JSON.parse(fs.readFileSync(path.join(ws, 'processed', 'replay_seeds', 'resumo_multiseed.json'), 'utf8')); } catch { return null; }
}

/** Métricas científicas de cada semente (resumo_ciencia.json) e avisos de comparação. */
function replayResults(ws) {
  const raiz = path.join(ws, 'processed', 'replay_seeds');
  const ler = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const sementes = [];
  let nomes = [];
  try { nomes = fs.readdirSync(raiz).filter((n) => /^seed_\d+$/.test(n)); } catch { return null; }
  for (const n of nomes) {
    const r = ler(path.join(raiz, n, 'resumo_ciencia.json'));
    const sem = ler(path.join(raiz, n, 'semente.json'));
    if (!r) continue;
    let t = 0; try { t = fs.statSync(path.join(raiz, n, 'resumo_ciencia.json')).mtimeMs; } catch { /* sumiu */ }
    // a comparação com vazamento roda depois das métricas da semente: mais antiga que elas, é de um replay anterior
    let vaz = null;
    try { if (fs.statSync(path.join(raiz, `${n}_vazamento`, 'resumo_ciencia.json')).mtimeMs >= t) vaz = ler(path.join(raiz, `${n}_vazamento`, 'resumo_ciencia.json')); } catch { /* sem vazamento */ }
    sementes.push({ seed: Number(n.slice(5)), resumo: r, registro: sem?.registro || r.registro || null, meses: sem?.meses || null, vazamento: vaz?.vazamento || null, em: t });
  }
  if (!sementes.length) return null;
  sementes.sort((a, b) => b.em - a.em);
  const multi = ler(path.join(raiz, 'registro_multiseed.json'));
  // malhas diferentes entre as sementes mostradas (com e sem células repetidas): números não comparáveis
  const flags = new Set(sementes.map((s) => s.registro?.malha_com_celulas_repetidas).filter((x) => x !== undefined && x !== null));
  return { sementes, multi, malhasDiferentes: flags.size > 1 || !!multi?.malhas_diferentes };
}

module.exports = { cyclePlan, replayPlan, makeInternals, makeResolvers, replaySummary, replayResults, estimate, MODELS, VARIANTES };
