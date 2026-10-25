// Perfil das planilhas importadas, parâmetros da Limpeza e período do dataset.
//
// Perfil: um processo filho (workers/xlsx-profile.js) lê cada planilha uma única vez e
// guarda as contagens em dados_ssp/_perfil/<sha256>.json.
//
// <pasta de trabalho>/parametros.json
//   limpeza: o que entra na base unificada (ocorrências e tipos de veículo; cidade fixa)
//   dataset: de quando a quando os modelos usam os dados (escolhido em Features)
// Vai para o pipeline como PRECRIME_CONFIG_OVERRIDES (pipeline/config.py).
//
// Os rótulos da SSP mudam entre anos ("Localizado/Entregue" × "Localizado / Entregue",
// "AUTOMOVEL" × "Automovel"). Tudo é comparado normalizado — a mesma regra de
// pipeline/dataset/step1_ingest.py (_norm).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ssp = require('./ssp');

// no app instalado o leitor fica fora do app.asar (asarUnpack), para o Node do Electron executá-lo
const WORKER = path.join(__dirname, '..', 'workers', 'xlsx-profile.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const PROFILE_VERSION = 2; // igual a VERSION em workers/xlsx-profile.js

// A malha viária e os dados de mapa do app cobrem só a capital.
const CITY = 'S.PAULO';

// Valores reconhecidos na coluna DESCR_OCORRENCIA_VEICULO.
const OCORRENCIAS = {
  FURTADO: 'Furto',
  ROUBADO: 'Roubo',
  'LOCALIZADO/ENTREGUE': 'Recuperados',
};

// Tipos de veículo reconhecidos (espécies do Denatran, na grafia da SSP, normalizada).
// Qualquer outro valor (NULL, "Não informado", "Inexistente", anos, modelos) fica de fora.
const VEICULOS = {
  AUTOMOVEL: 'Automóvel', MOTOCICLO: 'Motocicleta', CAMINHONETE: 'Caminhonete', CAMIONETA: 'Camioneta',
  CAMINHAO: 'Caminhão', 'CAMINHAO TRATOR': 'Caminhão trator', MOTONETA: 'Motoneta', CICLOMOTO: 'Ciclomotor',
  CICLOMOTOR: 'Ciclomotor', UTILITARIO: 'Utilitário', 'SEMI-REBOQUE': 'Semirreboque', REBOQUE: 'Reboque',
  'MICRO-ONIBUS': 'Micro-ônibus', ONIBUS: 'Ônibus', 'TRATOR RODAS': 'Trator de rodas', 'TRATOR MISTO': 'Trator misto',
  'TRATOR ESTEIRAS': 'Trator de esteiras', QUADRICICLO: 'Quadriciclo', TRICICLO: 'Triciclo', BICICLETA: 'Bicicleta',
  'MOTOR CASA': 'Motor-casa', 'SIDE-CAR': 'Side-car', 'CHASSI-PLATAFORMA': 'Chassi-plataforma', CARROCA: 'Carroça',
  CHARRETE: 'Charrete', BONDE: 'Bonde', 'CARRO DE MAO': 'Carro de mão',
};

// Padrões da dissertação (pipeline/padroes_dissertacao.json, o mesmo arquivo de config.py)
const PADRAO = require('./padroes').padroes();
const DEFAULTS = {
  municipios: PADRAO.CLEAN_PARAMS.MUNICIPIOS,   // cidades das planilhas que entram; ['*'] = todas (áreas do operador fora da capital)
  ocorrencias: PADRAO.CLEAN_PARAMS.OCORRENCIAS,
  veiculos: PADRAO.CLEAN_PARAMS.TIPOS_VEICULO,  // null = todos os tipos reconhecidos
  removerRepetidos: PADRAO.CLEAN_PARAMS.REMOVER_DUPLICADOS,
};
const DATASET_DEFAULTS = { inicio: PADRAO.DATE_START_DATA.slice(0, 7), fim: null }; // fim null = até o último mês com dados
const FILTER_DEFAULTS = { removerCelulasRepetidas: PADRAO.FILTER_PARAMS.REMOVER_CELULAS_REPETIDAS };

function norm(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
}
const isYm = (ym) => /^\d{4}-\d{2}$/.test(ym || '');
// data plausível (a SSP tem datas digitadas erradas, como o ano 0201)
const validYm = (ym) => isYm(ym) && ym >= '1990-01' && ym <= `${new Date().getFullYear() + 1}-12`;

const profDir = (ws) => path.join(ws, 'dados_ssp', '_perfil');
const paramsFile = (ws) => path.join(ws, 'parametros.json');

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function readProfile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j.version === PROFILE_VERSION ? j : null;   // perfil de versão antiga: ler de novo
  } catch { return null; }
}

function runWorker(file, out, onProgress) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [WORKER, file, out], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    let err = '', buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.startsWith('@@P ')) { try { onProgress(JSON.parse(line.slice(4))); } catch { /* linha incompleta */ } }
      }
    });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `leitor saiu com código ${code}`))));
  });
}

let running = null;
/** Garante o perfil de todas as planilhas (uma por vez). onProgress({name,index,total,pct,state}) */
async function ensureProfiles(ws, onProgress = () => {}, log) {
  if (running) return running;
  running = (async () => {
    const files = ssp.list(ws);
    fs.mkdirSync(profDir(ws), { recursive: true });
    const done = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const src = path.join(ws, 'dados_ssp', f.name);
      const sha = f.sha256 || await hashFile(src);
      const out = path.join(profDir(ws), `${sha}.json`);
      const base = { name: f.name, index: i + 1, total: files.length };
      if (!readProfile(out)) {
        onProgress({ ...base, pct: 0, state: 'lendo' });
        const t0 = Date.now();
        try {
          await runWorker(src, out, (p) => onProgress({ ...base, pct: p.pct ?? (p.step === 'fim' ? 100 : 0), state: 'lendo' }));
          log?.ok('ssp', `${f.name}: planilha lida em ${((Date.now() - t0) / 1000).toFixed(1)} s`);
        } catch (e) {
          log?.error('ssp', `${f.name}: não consegui ler a planilha (${e.message})`);
          onProgress({ ...base, state: 'erro', message: e.message });
          continue;
        }
      }
      done.push({ name: f.name, sha, file: out });
      onProgress({ ...base, pct: 100, state: 'pronto' });
    }
    return done;
  })();
  try { return await running; } finally { running = null; }
}

/** Junta os perfis das planilhas atuais (em cache enquanto planilhas e perfis não mudam). */
let cache = { key: null, value: null };
function aggregate(ws) {
  const files = ssp.list(ws);
  let profs = [];
  try { profs = fs.readdirSync(profDir(ws)).map((p) => [p, fs.statSync(path.join(profDir(ws), p)).mtimeMs]); } catch { /* sem perfis */ }
  const key = JSON.stringify([ws, files.map((f) => [f.name, f.mtime, f.sha256]), profs]);
  if (cache.key === key) return cache.value;
  cache = { key, value: build(ws, files) };
  return cache.value;
}

function build(ws, files) {
  const rows = [];            // { file, mun, oc, ve, ym, n, c } normalizados
  const labels = { oc: new Map(), ve: new Map() };
  const perFile = [];
  const missing = [];
  for (const f of files) {
    let prof = f.sha256 ? readProfile(path.join(profDir(ws), `${f.sha256}.json`)) : null;
    if (!prof) {
      // planilhas sem registro de hash (copiadas à mão): procura um perfil com o mesmo nome
      try {
        for (const pf of fs.readdirSync(profDir(ws))) {
          const j = readProfile(path.join(profDir(ws), pf));
          if (j && j.file === f.name) { prof = j; break; }
        }
      } catch { /* sem perfis */ }
    }
    if (!prof) { missing.push(f.name); continue; }
    perFile.push({ name: f.name, year: f.year, rows: prof.rows, sheet: prof.sheet, missingColumns: prof.missing });
    for (const [k, [n, c]] of Object.entries(prof.counts)) {
      const [mun, oc, ve, ym] = k.split('|');
      const r = { file: f.name, mun: norm(mun), oc: norm(oc), ve: norm(ve), ym, n, c };
      rows.push(r);
      for (const [map, raw, nk] of [[labels.oc, oc, r.oc], [labels.ve, ve, r.ve]]) {
        const m = map.get(nk) || new Map(); m.set(raw, (m.get(raw) || 0) + n); map.set(nk, m);
      }
    }
  }
  const pretty = (map, nk) => { const m = map.get(nk); return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : nk; };
  return { rows, labels, pretty, perFile, missing, files: files.length };
}

// ── parametros.json ─────────────────────────────────────────────────────────
function readAll(ws) {
  try { return JSON.parse(fs.readFileSync(paramsFile(ws), 'utf8')); } catch { return {}; }
}
function writeAll(ws, all) {
  fs.writeFileSync(paramsFile(ws), JSON.stringify(all, null, 2), 'utf8');
}

function readParams(ws) {
  const l = readAll(ws).limpeza || {};
  const mun = Array.isArray(l.municipios) ? l.municipios.map(norm).filter(Boolean) : [];
  return {
    municipios: mun.includes('*') ? ['*'] : mun.length ? [...new Set(mun)] : [...DEFAULTS.municipios],
    ocorrencias: Array.isArray(l.ocorrencias) ? l.ocorrencias.filter((x) => x in OCORRENCIAS) : [...DEFAULTS.ocorrencias],
    veiculos: Array.isArray(l.veiculos) ? l.veiculos.filter((x) => x in VEICULOS) : DEFAULTS.veiculos,
    removerRepetidos: typeof l.removerRepetidos === 'boolean' ? l.removerRepetidos : DEFAULTS.removerRepetidos,
  };
}
function writeParams(ws, p) {
  const all = readAll(ws);
  const mun = Array.isArray(p.municipios) ? p.municipios.map(norm).filter(Boolean).slice(0, 700) : [];
  all.limpeza = {
    municipios: mun.includes('*') ? ['*'] : mun.length ? [...new Set(mun)] : [CITY],
    ocorrencias: (p.ocorrencias || []).map(norm).filter((x) => x in OCORRENCIAS),
    veiculos: Array.isArray(p.veiculos) ? p.veiculos.map(norm).filter((x) => x in VEICULOS) : null,
    removerRepetidos: p.removerRepetidos !== false,
  };
  all.limpezaAtualizadaEm = new Date().toISOString();
  writeAll(ws, all);
  return readParams(ws);
}

function readDataset(ws) {
  const d = readAll(ws).dataset || {};
  return { inicio: isYm(d.inicio) ? d.inicio : DATASET_DEFAULTS.inicio, fim: isYm(d.fim) ? d.fim : null };
}
function writeDataset(ws, d) {
  const all = readAll(ws);
  all.dataset = { inicio: isYm(d?.inicio) ? d.inicio : DATASET_DEFAULTS.inicio, fim: isYm(d?.fim) ? d.fim : null };
  all.datasetAtualizadoEm = new Date().toISOString();
  writeAll(ws, all);
  return readDataset(ws);
}

/** Filtragem: juntar as células repetidas da malha (padrão: não, como na dissertação). */
function readFilter(ws) {
  const f = readAll(ws).filtragem || {};
  return { removerCelulasRepetidas: typeof f.removerCelulasRepetidas === 'boolean' ? f.removerCelulasRepetidas : FILTER_DEFAULTS.removerCelulasRepetidas };
}
function writeFilter(ws, f) {
  const all = readAll(ws);
  all.filtragem = { removerCelulasRepetidas: f?.removerCelulasRepetidas === true };
  all.filtragemAtualizadaEm = new Date().toISOString();
  writeAll(ws, all);
  return readFilter(ws);
}

/** Quando cada grupo de parâmetros mudou pela última vez (para marcar fases desatualizadas). */
function changedAt(ws) {
  const all = readAll(ws);
  return {
    limpeza: Date.parse(all.limpezaAtualizadaEm) || 0,
    filtragem: Date.parse(all.filtragemAtualizadaEm) || 0,
    dataset: Date.parse(all.datasetAtualizadoEm) || 0,
  };
}

const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** Overrides para o pipeline (pipeline/config.py). */
function pipelineOverrides(ws) {
  const p = readParams(ws);
  const d = readDataset(ws);
  const ov = {
    CLEAN_PARAMS: {
      MUNICIPIOS: p.municipios,
      OCORRENCIAS: p.ocorrencias,
      // "todos" = todos os tipos reconhecidos; valores inválidos ficam de fora
      TIPOS_VEICULO: p.veiculos || Object.keys(VEICULOS),
      REMOVER_DUPLICADOS: p.removerRepetidos,
    },
    DATE_START_DATA: `${d.inicio}-01`,
    FILTER_PARAMS: { REMOVER_CELULAS_REPETIDAS: readFilter(ws).removerCelulasRepetidas },
  };
  if (d.fim) ov.DATA_END = lastDay(d.fim);
  return ov;
}

// ── telas ────────────────────────────────────────────────────────────────────
function sumBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); const cur = m.get(k) || [0, 0]; cur[0] += r.n; cur[1] += r.c; m.set(k, cur); }
  return m;
}
function examples(agg, map, list, k = 6) {
  return list.slice(0, k).map(([key, [n]]) => ({ label: agg.pretty(map, key), n }));
}

/** Limpeza: opções (com contagens), registros que ficam de fora e estimativa do funil. */
function cleanView(ws, params) {
  const agg = aggregate(ws);
  const p = { ...readParams(ws), ...(params || {}) };
  const all = agg.rows;
  // cidades escolhidas (a capital por padrão; '*' = todas as das planilhas)
  const muns = new Set(p.municipios || [CITY]);
  const todas = muns.has('*');
  const inCity = (r) => todas || muns.has(r.mun);
  const city = all.filter(inCity);
  const titulo = (m) => (m === CITY ? 'São Paulo (capital)' : m.toLowerCase().replace(/(^|[\s'.-])([a-zà-ú])/g, (x, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, (x) => x.toLowerCase()));
  const cidades = [...sumBy(all, (r) => r.mun).entries()].filter(([k]) => k).sort((a, b) => b[1][0] - a[1][0])
    .map(([key, [n]]) => ({ key, label: titulo(key), n }));

  // ocorrências: as três reconhecidas e "outros valores" (só informativo)
  const ocAll = [...sumBy(city, (r) => r.oc).entries()].sort((a, b) => b[1][0] - a[1][0]);
  const ocorrencias = Object.keys(OCORRENCIAS).map((key) => ({
    key, title: OCORRENCIAS[key], label: agg.pretty(agg.labels.oc, key), n: (ocAll.find(([k]) => k === key)?.[1][0]) || 0,
  }));
  const ocOther = ocAll.filter(([k]) => !(k in OCORRENCIAS));
  const ocOtherFiles = [...sumBy(city.filter((r) => !(r.oc in OCORRENCIAS)), (r) => r.file).entries()].map(([file, [n]]) => ({ file, n }));

  // tipos de veículo (dentro das ocorrências escolhidas)
  const ocs = new Set(p.ocorrencias.map(norm));
  const inOc = city.filter((r) => ocs.has(r.oc));
  // lista: tipos presentes em qualquer ocorrência reconhecida; contagem: nas ocorrências escolhidas
  const vePresent = [...sumBy(city.filter((r) => r.oc in OCORRENCIAS), (r) => r.ve).entries()].sort((a, b) => b[1][0] - a[1][0]);
  const veChosen = sumBy(inOc, (r) => r.ve);
  const veiculos = vePresent.filter(([k]) => k in VEICULOS).map(([key, [total]]) => ({ key, label: VEICULOS[key], n: veChosen.get(key)?.[0] || 0, total }));
  const veOther = [...veChosen.entries()].filter(([k]) => !(k in VEICULOS)).sort((a, b) => b[1][0] - a[1][0]);
  const veOtherFiles = [...sumBy(inOc.filter((r) => !(r.ve in VEICULOS)), (r) => r.file).entries()].map(([file, [n]]) => ({ file, n }));

  // funil estimado (os repetidos só são conhecidos na execução)
  const ves = Array.isArray(p.veiculos) ? new Set(p.veiculos.map(norm)) : null;
  const steps = { lidos: 0, cidade: 0, ocorrencia: 0, veiculo: 0, data: 0, coordenadas: 0 };
  const byMonth = {};
  for (const r of all) {
    steps.lidos += r.n;
    if (!inCity(r)) continue; steps.cidade += r.n;
    if (!ocs.has(r.oc)) continue; steps.ocorrencia += r.n;
    if (!(r.ve in VEICULOS) || (ves && !ves.has(r.ve))) continue; steps.veiculo += r.n;
    if (!validYm(r.ym)) continue; steps.data += r.n;
    steps.coordenadas += r.c;
    byMonth[r.ym] = (byMonth[r.ym] || 0) + r.c;
  }
  const months = Object.keys(byMonth).sort();
  const years = [...new Set(ssp.list(ws).map((f) => f.year).filter(Boolean))].sort();
  return {
    params: p, city: CITY,
    options: { ocorrencias, veiculos, cidades },
    cidadesTxt: todas ? 'todas as cidades das planilhas' : [...muns].map(titulo).join(', '),
    outside: {
      otherCities: { n: all.length ? steps.lidos - steps.cidade : 0, count: todas ? 0 : cidades.filter((c) => !muns.has(c.key)).length },
      ocorrencias: { n: ocOther.reduce((s, [, [n]]) => s + n, 0), examples: examples(agg, agg.labels.oc, ocOther), files: ocOtherFiles },
      veiculos: { n: veOther.reduce((s, [, [n]]) => s + n, 0), examples: examples(agg, agg.labels.ve, veOther), files: veOtherFiles },
    },
    steps, byMonth, years, range: { first: months[0] || null, last: months[months.length - 1] || null },
    perFile: agg.perFile, missing: agg.missing, files: agg.files,
  };
}

/** Features: período do dataset sobre os registros que a Limpeza deixa passar. */
function datasetView(ws, dataset) {
  const v = cleanView(ws);
  const d = { ...readDataset(ws), ...(dataset || {}) };
  const years = v.years;
  const monthsAll = Object.keys(v.byMonth).sort();
  // meses antes do primeiro ano importado só têm registros feitos com atraso
  const firstYear = years[0] ? `${years[0]}-01` : monthsAll[0];
  // meses contínuos (mês sem registro aparece como zero, para o gráfico mostrar a lacuna)
  const months = [];
  const from = monthsAll.find((m) => !firstYear || m >= firstYear);
  if (from) {
    const to = monthsAll[monthsAll.length - 1];
    for (let [y, m] = from.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= to; m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const last = months[months.length - 1] || null;
  const end = d.fim || last;
  let n = 0, count = 0;
  for (const m of months) if (m >= d.inicio && (!end || m <= end)) { n += v.byMonth[m] || 0; count++; }
  return {
    dataset: d, months: Object.fromEntries(months.map((m) => [m, v.byMonth[m] || 0])),
    first: months[0] || null, last, selected: { months: count, registros: n },
    clean: { ocorrencias: v.params.ocorrencias.map((k) => OCORRENCIAS[k] || k), veiculos: v.params.veiculos ? v.params.veiculos.map((k) => VEICULOS[k] || k) : null },
    files: v.files,
  };
}

module.exports = {
  ensureProfiles, cleanView, datasetView, readParams, writeParams, readDataset, writeDataset, readFilter, writeFilter, changedAt,
  pipelineOverrides, DEFAULTS, DATASET_DEFAULTS, FILTER_DEFAULTS, OCORRENCIAS, VEICULOS, CITY, norm,
};
