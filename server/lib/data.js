// Acesso aos arquivos gerados pelo pipeline (data/processed), com cache por data de modificação.
// Layout lido (o mesmo que o pipeline grava):
//   results_geojson/hotspots_{Modelo}_{area}_{AAAA_MM}.geojson
//   results_geojson/crimes_reais_{area}_{AAAA-MM-DD}.geojson
//   results/metrics_summary_all.csv
//   results/grid_history_{area}_{AAAA_MM}.json
//   results/results_{modelo}_{area}_{AAAA_MM}.csv
//   metrics/zhang_comparison.csv
//   streets/ruas_{area}.geojson  (fundo do mapa sem internet; na pasta de trabalho fica ao lado de processed/)
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv.js';

export const MODELS = ['Ensemble', 'RF', 'LSTM', 'Transformer'];
const TAG_RE = /_(\d{4}_\d{2})\.geojson$/;

// ── Pontos de interesse (pois/pois_{area}.geojson, do OpenStreetMap) ────────────────
// Agrupados em categorias para o mapa não ficar poluído: o painel liga uma de cada vez.
// Bares e polícia são os mesmos tipos que o Ensemble usa (POI_WEIGHTS em config.py).
export const POI_CATEGORIAS = [
  { id: 'bares', rotulo: 'Bares e baladas', cor: '#7c3aed', amenity: ['bar', 'pub', 'nightclub'] },
  { id: 'policia', rotulo: 'Polícia', cor: '#1d4ed8', amenity: ['police'] },
  { id: 'bancos', rotulo: 'Bancos', cor: '#0f766e', amenity: ['bank'] },
  { id: 'veiculos', rotulo: 'Oficinas e lojas de veículos', cor: '#92400e', shop: ['car_repair', 'car', 'car_parts', 'tyres', 'motorcycle'] },
  { id: 'shoppings', rotulo: 'Shoppings e lojas de departamento', cor: '#db2777', shop: ['mall', 'department_store'] },
  { id: 'mercados', rotulo: 'Mercados, padarias e conveniência', cor: '#15803d', shop: ['supermarket', 'convenience', 'greengrocer', 'bakery', 'butcher'] },
  { id: 'restaurantes', rotulo: 'Restaurantes', cor: '#0891b2', amenity: ['restaurant'] },
  { id: 'transporte', rotulo: 'Terminais de ônibus', cor: '#334155', amenity: ['bus_station'] },
  { id: 'outros', rotulo: 'Outros comércios', cor: '#6b7280', outros: true },
];
const POI_TIPO = {
  bar: 'bar', pub: 'bar', nightclub: 'casa noturna', police: 'polícia', bank: 'banco', restaurant: 'restaurante', bus_station: 'terminal de ônibus',
  car_repair: 'oficina', car: 'loja de carros', car_parts: 'autopeças', tyres: 'borracharia', motorcycle: 'loja de motos', mall: 'shopping',
  department_store: 'loja de departamento', supermarket: 'supermercado', convenience: 'conveniência', greengrocer: 'hortifrúti', bakery: 'padaria', butcher: 'açougue',
};
/** GeoJSON de POIs → { categorias: [{id, rotulo, cor, n}], pontos: { id: [[lon, lat, nome, tipo], ...] } }. */
export function poisCompact(g) {
  const pontos = Object.fromEntries(POI_CATEGORIAS.map((c) => [c.id, []]));
  const r5 = (x) => Math.round(x * 1e5) / 1e5;
  for (const f of g?.features || []) {
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    if (!c) continue;
    const pr = f.properties || {};
    const am = pr.amenity || null, sh = pr.shop || null;
    const cat = POI_CATEGORIAS.find((k) => (am && k.amenity?.includes(am)) || (sh && k.shop?.includes(sh)))
      || (sh || am ? POI_CATEGORIAS.find((k) => k.outros) : null);
    if (!cat) continue;
    const tipo = POI_TIPO[am] || POI_TIPO[sh] || (sh && sh !== 'yes' ? sh.replace(/_/g, ' ') : 'comércio');
    pontos[cat.id].push([r5(c[0]), r5(c[1]), String(pr.name || '').slice(0, 80), tipo]);
  }
  return {
    categorias: POI_CATEGORIAS.map(({ id, rotulo, cor }) => ({ id, rotulo, cor, n: pontos[id].length })).filter((c) => c.n),
    pontos,
  };
}

/** Nomes das áreas criadas pelo operador: <pasta de trabalho>/areas/areas.json → { area_12: 'Pinheiros' } */
export function nomesDasAreas(wsDir) {
  try {
    const r = JSON.parse(readFileSync(join(wsDir, 'areas', 'areas.json'), 'utf8'));
    return Object.fromEntries(Object.entries(r.areas || {}).map(([k, v]) => [k, String(v.nome || k)]));
  } catch { return {}; }
}

// ── Fundo do mapa ─────────────────────────────────────────────────────────────
// basemaps.cartocdn.com (CARTO) exige chave desde 25/09/2026: sem ela os quadradinhos
// vêm com o aviso "API KEY REQUIRED". Sem chave, o painel desenha as ruas da área.
export const ESTILOS_CARTO = ['light_all', 'rastertiles/voyager', 'dark_all'];
/** { provedor: 'carto', estilo, chave } | { provedor: 'ruas' } a partir de um objeto qualquer. */
export function normalizarFundo(f) {
  const chave = typeof f?.chave === 'string' ? f.chave.trim() : '';
  if (f?.provedor === 'carto' && /^[A-Za-z0-9._~-]{8,200}$/.test(chave)) {
    return { provedor: 'carto', estilo: ESTILOS_CARTO.includes(f.estilo) ? f.estilo : 'light_all', chave };
  }
  return { provedor: 'ruas' };
}
/** Mapa interno do app: o app passa a escolha em PRECRIME_BASEMAP (JSON). */
export function fundoDoAmbiente() {
  try { return normalizarFundo(JSON.parse(process.env.PRECRIME_BASEMAP || 'null')); } catch { return { provedor: 'ruas' }; }
}

export function createStore(dataDir, { cacheSize = 40 } = {}) {
  const dirGeo = join(dataDir, 'results_geojson');
  const dirRes = join(dataDir, 'results');
  const dirMet = join(dataDir, 'metrics');
  const cache = new Map(); // caminho -> { mtime, value }

  function cached(path, loader) {
    let st;
    try { st = statSync(path); } catch { return null; }
    const hit = cache.get(path);
    if (hit && hit.mtime === st.mtimeMs) {
      cache.delete(path); cache.set(path, hit); // LRU
      return hit.value;
    }
    const value = loader(path);
    cache.set(path, { mtime: st.mtimeMs, value });
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return value;
  }

  const readJson = (p) => cached(p, (x) => JSON.parse(readFileSync(x, 'utf8')));
  const readCsv = (p) => cached(p, (x) => parseCsv(readFileSync(x, 'utf8')));
  const list = (dir) => { try { return readdirSync(dir); } catch { return []; } };

  function tags() {
    const set = new Set();
    for (const f of list(dirGeo)) {
      if (!f.startsWith('hotspots_')) continue;
      const m = f.match(TAG_RE);
      if (m) set.add(m[1]);
    }
    return [...set].sort();
  }

  function defaultTag() {
    const t = tags();
    return t.length ? t[t.length - 1] : null;
  }

  function areas(tag) {
    const t = tag || defaultTag();
    if (!t) return [];
    const set = new Set();
    for (const f of list(dirGeo)) {
      const m = f.match(new RegExp(`^hotspots_[A-Za-z]+_(.+)_${t}\\.geojson$`));
      if (m) set.add(m[1]);
    }
    return [...set].sort();
  }

  const predPath = (model, area, tag) => join(dirGeo, `hotspots_${model}_${area}_${tag || defaultTag()}.geojson`);

  function crimesPath(area, tag) {
    const files = list(dirGeo).filter((f) => f.startsWith(`crimes_reais_${area}_`) && f.endsWith('.geojson')).sort();
    if (tag) {
      const [y, m] = tag.split('_');
      const f = files.find((x) => x.includes(`${y}-${m}`));
      return f ? join(dirGeo, f) : null;
    }
    return files.length ? join(dirGeo, files[files.length - 1]) : null;
  }

  const historyPath = (area, tag) => {
    const p = join(dirRes, `grid_history_${area}_${tag || defaultTag()}.json`);
    return existsSync(p) ? p : null;
  };

  // Ruas da área para o fundo do mapa sem internet: só a classe da via e coordenadas com
  // 5 casas (~1 m), o que reduz o arquivo do OSM a menos da metade.
  const RANK = { motorway: 1, trunk: 1, primary: 2, secondary: 3, tertiary: 4 };
  function streetsPath(area) {
    for (const d of [join(dataDir, 'streets'), join(dataDir, '..', 'streets')]) {
      const p = join(d, `ruas_${area}.geojson`);
      if (existsSync(p)) return p;
    }
    return null;
  }
  function streets(area) {
    const p = streetsPath(area);
    if (!p) return null;
    return cached(p, (x) => {
      const g = JSON.parse(readFileSync(x, 'utf8'));
      const r5 = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];
      const features = [];
      for (const f of g.features || []) {
        const geom = f.geometry;
        if (!geom || !/LineString$/.test(geom.type)) continue;
        const hw = String(f.properties?.highway || '').replace(/[\[\]'"]/g, '').split(',')[0].replace(/_link$/, '').trim();
        const coordinates = geom.type === 'LineString' ? geom.coordinates.map(r5) : geom.coordinates.map((l) => l.map(r5));
        features.push({ type: 'Feature', properties: { h: RANK[hw] || 5 }, geometry: { type: geom.type, coordinates } });
      }
      return { type: 'FeatureCollection', features };
    });
  }

  // Pontos de interesse da área (pasta pois/, ao lado de processed/)
  function pois(area) {
    for (const d of [join(dataDir, 'pois'), join(dataDir, '..', 'pois')]) {
      const p = join(d, `pois_${area}.geojson`);
      if (existsSync(p)) return cached(p, (x) => poisCompact(JSON.parse(readFileSync(x, 'utf8'))));
    }
    return null;
  }

  // Imagens de métricas (rota /api/image): só png/jpg/gif dentro de metrics/
  function imagePath(rel) {
    if (!/^[\w\-./ ]+\.(png|jpe?g|gif)$/i.test(rel) || rel.split('/').some((x) => x === '..' || x === '')) return null;
    const p = join(dirMet, rel);
    return existsSync(p) ? p : null;
  }

  const resultsCsv = (model, area, tag) => readCsv(join(dirRes, `results_${model}_${area}_${tag}.csv`));

  return {
    mode: 'live', dataDir, tags, defaultTag, areas, streets, pois, imagePath,
    // interface usada pelas rotas (a mesma do pacote publicado, em package-store.js)
    predictionFile: (model, area, tag) => { const p = predPath(model, area, tag); return existsSync(p) ? p : null; },
    prediction: (model, area, tag) => readJson(predPath(model, area, tag)),
    crimes: (area, tag) => { const p = crimesPath(area, tag); return p ? readJson(p) : null; },
    historyFile: (area, tag) => historyPath(area, tag),
    history: (area, tag) => { const p = historyPath(area, tag); return p ? readJson(p) : null; },
    gridScore: (area, tag, gridId) => gridScoreFrom(resultsCsv, area, tag, gridId),
    metricsSummary: () => readCsv(join(dirRes, 'metrics_summary_all.csv')) || [],
    zhang: () => readCsv(join(dirMet, 'zhang_comparison.csv')) || [],
    site: () => null,
    basemap: () => fundoDoAmbiente(),
    areaNames: () => nomesDasAreas(join(dataDir, '..')),
    // usados pelo montador do pacote
    predPath, crimesPath, historyPath, resultsCsv, readJson, readCsv,
  };
}

/** Score do grid no painel: o maior score dele no primeiro CSV de resultados que existir
 *  (Ensemble, senão RF, senão LSTM). */
export function gridScoreFrom(resultsCsv, area, tag, gridId) {
  let score = 0;
  for (const m of ['ensemble', 'rf', 'lstm']) {
    const rows = resultsCsv(m, area, tag);
    if (!rows) continue;
    for (const r of rows) if (String(r.GRID_ID) === String(gridId)) score = Math.max(score, Number(r.probabilidade_risco || 0));
    break;
  }
  return score;
}

/** Todos os scores de grid de uma área e mês, pela mesma regra (para o pacote publicado). */
export function gridScoresFrom(resultsCsv, area, tag) {
  for (const m of ['ensemble', 'rf', 'lstm']) {
    const rows = resultsCsv(m, area, tag);
    if (!rows) continue;
    const out = {};
    for (const r of rows) {
      const k = String(r.GRID_ID);
      out[k] = Math.max(out[k] ?? 0, Number(r.probabilidade_risco || 0));
    }
    return { modelo: m, scores: out };
  }
  return { modelo: null, scores: {} };
}

/** Escolhe o modo pelo conteúdo da pasta: pacote publicado (data/pacote.json) ou processed/. */
export async function openStore(dataDir) {
  if (existsSync(join(dataDir, 'pacote.json'))) {
    const { createPackageStore } = await import('./package-store.js');
    return createPackageStore(dataDir);
  }
  return createStore(dataDir);
}
