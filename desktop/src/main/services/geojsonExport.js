// Exporta as previsões em GeoJSON prontos para abrir no geojson.io (ou QGIS, Google My Maps...).
// As cores vão em propriedades do padrão "simplestyle" (fill, fill-opacity, stroke...), que o
// geojson.io usa para pintar cada célula. Coordenadas arredondadas em 6 casas (~10 cm).
const fs = require('fs');
const path = require('path');

const MODELS = ['Ensemble', 'RF', 'LSTM', 'Transformer'];
const STYLE = {
  ALTO: { fill: '#ff0000', 'fill-opacity': 0.6, stroke: '#7f1d1d', 'stroke-width': 0.6, 'stroke-opacity': 0.8 },
  MEDIO: { fill: '#ffff00', 'fill-opacity': 0.55, stroke: '#a16207', 'stroke-width': 0.5, 'stroke-opacity': 0.7 },
  BAIXO: { fill: '#94a3b8', 'fill-opacity': 0.04, stroke: '#94a3b8', 'stroke-width': 0.3, 'stroke-opacity': 0.35 },
};

const geoDir = (ws) => path.join(ws, 'processed', 'results_geojson');

/** O que existe para exportar: meses, áreas e modelos. */
function available(ws) {
  let files = [];
  try { files = fs.readdirSync(geoDir(ws)); } catch { return { months: [] }; }
  const months = {};
  for (const f of files) {
    const m = f.match(/^hotspots_([A-Za-z]+)_(area_\d+)_(\d{4}_\d{2})\.geojson$/);
    if (!m) continue;
    const [, model, area, tag] = m;
    months[tag] ??= { tag, areas: new Set(), models: new Set(), crimes: new Set() };
    months[tag].areas.add(area); months[tag].models.add(model);
  }
  for (const f of files) {
    const m = f.match(/^crimes_reais_(area_\d+)_(\d{4})-(\d{2})-\d{2}\.geojson$/);
    if (m && months[`${m[2]}_${m[3]}`]) months[`${m[2]}_${m[3]}`].crimes.add(m[1]);
  }
  return {
    months: Object.values(months).sort((a, b) => b.tag.localeCompare(a.tag)).map((m) => ({
      tag: m.tag, label: m.tag.split('_').reverse().join('/'),
      areas: [...m.areas].sort(), models: MODELS.filter((x) => m.models.has(x)), crimesAreas: [...m.crimes].sort(),
    })),
  };
}

const round = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 1e6) / 1e6, Math.round(c[1] * 1e6) / 1e6] : c.map(round));

// Período do mês previsto a partir da tag (não confia no campo Periodo dos arquivos
// gerados antes da correção do step6, que gravavam o mês seguinte a hoje).
function periodOf(tag) {
  const [y, m] = tag.split('_').map(Number);
  const a = new Date(Date.UTC(y, m - 1, 1)), b = new Date(a.getTime() + 28 * 864e5);
  return `${a.toISOString().slice(0, 10)} a ${b.toISOString().slice(0, 10)}`;
}

function styleFeature(f, alertOnly, period) {
  const p = f.properties || {};
  const risco = String(p.Risco || 'BAIXO').toUpperCase();
  if (alertOnly && risco !== 'ALTO' && risco !== 'MEDIO') return null;
  const s = STYLE[risco] || STYLE.BAIXO;
  return {
    type: 'Feature',
    properties: {
      title: `Grid ${p.GRID_ID} · risco ${risco.toLowerCase()}`,
      Area: p.Area, GRID_ID: p.GRID_ID, Modelo: p.Modelo, Risco: risco, Score: p.Score, Periodo: period,
      ...s,
    },
    geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) },
  };
}

function crimeFeatures(ws, area, tag) {
  const [y, m] = tag.split('_');
  const f = fs.readdirSync(geoDir(ws)).find((x) => x.startsWith(`crimes_reais_${area}_${y}-${m}`));
  if (!f) return [];
  const g = JSON.parse(fs.readFileSync(path.join(geoDir(ws), f), 'utf8'));
  return (g.features || []).filter((c) => c.geometry).map((c) => ({
    type: 'Feature',
    properties: {
      title: `Crime real · ${String(c.properties?.DATA_OCORRENCIA_BO || '').slice(0, 10)}`,
      Area: area, Data: c.properties?.DATA_OCORRENCIA_BO, Hora: c.properties?.HORA_OCORRENCIA, Veiculo: c.properties?.DESCR_TIPO_VEICULO,
      'marker-color': '#111827', 'marker-size': 'small', 'marker-symbol': 'car',
    },
    geometry: { type: 'Point', coordinates: round(c.geometry.coordinates) },
  }));
}

/**
 * opts: { tag, areas[], models[], alertOnly, merge, includeCrimes, dest }
 * merge=true: um arquivo por modelo com todas as áreas; false: um arquivo por área.
 */
function exportGeojson(ws, opts) {
  const { tag, areas, models, alertOnly = true, merge = true, includeCrimes = false, dest } = opts;
  if (!/^\d{4}_\d{2}$/.test(tag || '')) throw new Error('Mês inválido.');
  fs.mkdirSync(dest, { recursive: true });
  const [y, m] = tag.split('_');
  const written = [];
  const write = (name, features) => {
    const file = path.join(dest, name);
    fs.writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }), 'utf8');
    written.push({ file, features: features.length, bytes: fs.statSync(file).size });
  };
  for (const model of models) {
    if (!MODELS.includes(model)) continue;
    let bucket = [];
    for (const area of areas) {
      if (!/^area_\d+$/.test(area)) continue;
      const src = path.join(geoDir(ws), `hotspots_${model}_${area}_${tag}.geojson`);
      if (!fs.existsSync(src)) continue;
      const g = JSON.parse(fs.readFileSync(src, 'utf8'));
      const feats = (g.features || []).map((f) => styleFeature(f, alertOnly, periodOf(tag))).filter(Boolean);
      if (includeCrimes) feats.push(...crimeFeatures(ws, area, tag));
      if (merge) bucket.push(...feats);
      else write(`precrime_${model}_${area}_${y}-${m}${alertOnly ? '_alertas' : ''}.geojson`, feats);
    }
    if (merge && bucket.length) write(`precrime_${model}_todas-as-areas_${y}-${m}${alertOnly ? '_alertas' : ''}.geojson`, bucket);
    bucket = [];
  }
  const readme = [
    `Pre-Crime — previsão de furtos e roubos de veículos · ${m}/${y}`,
    '',
    'Como ver no navegador (sem instalar nada):',
    '  1. Abra https://geojson.io',
    '  2. Arraste um destes arquivos .geojson para cima do mapa (ou Open > File).',
    '  3. As cores já vêm no arquivo: vermelho = alto risco (10% das células com maior score),',
    '     amarelo = médio risco (os 10% seguintes). Clique numa célula para ver Score e Período.',
    includeCrimes ? '  4. Os pontos pretos são os crimes reais registrados pela SSP no período.' : '',
    '',
    'Também abre no QGIS, no Google My Maps (importar) e no kepler.gl.',
    alertOnly ? 'Os arquivos têm só as células em alerta; as demais foram omitidas para ficarem leves.' : '',
    '',
    'Aviso: previsão estatística a partir de registros da SSP-SP. Indica concentração provável por área,',
    'não aponta pessoas. Crimes não registrados ficam fora dos dados.',
  ].filter((l) => l !== '').join('\r\n');
  fs.writeFileSync(path.join(dest, 'LEIA-ME_geojson.txt'), readme, 'utf8');
  return { dest, written };
}

module.exports = { available, exportGeojson };
