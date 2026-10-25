// Padrões da dissertação: lidos de pipeline/padroes_dissertacao.json, o mesmo arquivo que
// pipeline/config.py usa. As telas mostram o selo "padrão da dissertação" e o botão
// "Restaurar padrão da dissertação" a partir daqui; nenhum valor padrão é repetido nas telas.
const fs = require('fs');
const path = require('path');
const paths = require('../paths');

let cache = null;
function padroes() {
  if (!cache) {
    const j = JSON.parse(fs.readFileSync(path.join(paths.PIPELINE_DIR, 'padroes_dissertacao.json'), 'utf8'));
    cache = Object.fromEntries(Object.entries(j).filter(([k]) => !k.startsWith('_')));
  }
  return JSON.parse(JSON.stringify(cache));
}

const IGNORAR = new Set(['n_jobs', 'random_state', 'HIGH_RISK_QUANTILE', 'MEDIUM_RISK_QUANTILE']);
const eqNum = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-12;

/** O que difere do padrão: { 'ENSEMBLE_CONFIG.POI_BOOST_FACTOR': [atual, padrão] }.
 *  todosTipos: lista de todos os tipos de veículo reconhecidos (o app manda a lista no lugar de "todos"). */
function diferencas(overrides, { chaves = null, todosTipos = null } = {}) {
  const P = padroes();
  const out = {};
  const cmp = (nome, atual, pad) => {
    if (atual === undefined) return;
    if (pad && typeof pad === 'object' && !Array.isArray(pad) && atual && typeof atual === 'object' && !Array.isArray(atual)) {
      for (const k of Object.keys(atual)) if (!IGNORAR.has(k)) cmp(`${nome}.${k}`, atual[k], pad[k]);
      return;
    }
    if (Array.isArray(pad) && Array.isArray(atual)) { if (JSON.stringify(atual) !== JSON.stringify(pad)) out[nome] = [atual, pad]; return; }
    if (atual !== pad && !eqNum(atual, pad)) out[nome] = [atual, pad ?? null];
  };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (chaves && !chaves.includes(k)) continue;
    if (k === 'DATA_END' || k === 'GLOBAL_SEED') continue; // período do replay e semente são registrados à parte
    if (!(k in P)) continue;
    if (k === 'DATE_START_DATA' && v === '2000-01-01') continue; // a Filtragem mapeia todos os meses
    if (k === 'CLEAN_PARAMS' && v) {
      const tipos = v.TIPOS_VEICULO;
      const todos = tipos === null || (Array.isArray(tipos) && todosTipos && tipos.length === todosTipos.length && tipos.every((t) => todosTipos.includes(t)));
      cmp(k, { ...v, TIPOS_VEICULO: todos ? null : tipos }, P[k]);
      continue;
    }
    cmp(k, v, P[k]);
  }
  return out;
}

/** Texto curto de uma diferença, para as telas. */
function rotulo(chave) {
  const R = {
    'ENSEMBLE_CONFIG.MODEL_WEIGHTS': 'pesos dos modelos', 'ENSEMBLE_CONFIG.HYBRID_FORMULA': 'média × máximo',
    'ENSEMBLE_CONFIG.POI_BOOST_FACTOR': 'fator dos pontos de interesse', 'ENSEMBLE_CONFIG.POI_WEIGHTS': 'pesos dos pontos de interesse',
    'ENSEMBLE_CONFIG.POI_NORMALIZACAO': 'normalização dos pontos de interesse', 'ENSEMBLE_CONFIG.MIN_HISTORICAL_CRIMES': 'filtro de histórico',
    'ENSEMBLE_CONFIG.TEMPORAL_SMOOTHING': 'suavização', 'ENSEMBLE_CONFIG.COMBINACAO': 'combinação dos modelos',
    COBERTURA: 'área de cobertura', CORTE: 'regra de corte', METRICS_THRESHOLDS: 'critérios da validação',
    ML_CONFIG: 'hiperparâmetros dos modelos', FILTER_PARAMS: 'células repetidas da malha', DATE_START_DATA: 'início do período',
    CLEAN_PARAMS: 'parâmetros da Limpeza', POI_SET: 'conjunto de pontos de interesse',
  };
  const k = Object.keys(R).sort((a, b) => b.length - a.length).find((p) => chave === p || chave.startsWith(p + '.'));
  return k ? R[k] : chave;
}

function resumo(dif) {
  return [...new Set(Object.keys(dif || {}).map(rotulo))];
}

module.exports = { padroes, diferencas, rotulo, resumo };
