// Rotas /api/* do servidor do mapa: configuração, KPIs, GeoJSON, auditoria, saúde e
// /api/streets/{area} (fundo do mapa sem internet).
import { MODELS } from './data.js';

const HORIZON = Number(process.env.PRECRIME_FORECAST_HORIZON || 4);
const RE = {
  area: /^area_\d{2}$/,
  tag: /^\d{4}_\d{2}$/,
  grid: /^\d+$/,
};

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function q(url, name, re) {
  const v = url.searchParams.get(name);
  if (v == null || v === '') return null;
  if (re && !re.test(v)) throw new HttpError(400, `parâmetro inválido: ${name}`);
  return v;
}
function need(v, re, name) {
  if (!re.test(v)) throw new HttpError(400, `parâmetro inválido: ${name}`);
  return v;
}
function needModel(m) {
  if (!MODELS.includes(m)) throw new HttpError(400, 'modelo inválido');
  return m;
}

export function buildRoutes(store, opts = {}) {
  const routes = [];
  const get = (pattern, fn) => routes.push({ re: new RegExp(`^${pattern}$`), fn });

  get('/api/health', () => ({
    ok: true, tags: store.tags(), default_tag: store.defaultTag(),
  }));

  get('/api/config', () => {
    const tags = store.tags();
    const def = store.defaultTag();
    return {
      areas: store.areas(def),
      models: store.models ? store.models() : MODELS,
      forecast_date: def ? `${def.replace('_', '-')}-01` : null,
      forecast_horizon: HORIZON,
      available_tags: tags,
      default_tag: def,
      // nomes das áreas criadas pelo operador (GeoJSON); só aparece quando existe alguma
      ...(() => { const n = store.areaNames?.() || {}; return Object.keys(n).length ? { area_names: n } : {}; })(),
    };
  });

  // Áreas com previsão no mês (as áreas criadas pelo operador podem ter só alguns meses)
  get('/api/areas', (url) => {
    const tag = q(url, 'tag', RE.tag) || store.defaultTag();
    const n = store.areaNames?.() || {};
    return store.areas(tag).map((a) => ({ area: a, nome: n[a] || null }));
  });

  get('/api/months', () => store.tags().map((tag) => {
    const [y, m] = tag.split('_');
    return { tag, label: `${m}/${y}` };
  }));

  get('/api/kpis/([^/]+)/([^/]+)', (url, [area, model]) => {
    need(area, RE.area, 'area'); needModel(model);
    const tag = q(url, 'tag', RE.tag) || store.defaultTag();
    const out = { total_grids: 0, risk_grids: 0, perc_risk: 0, total_crimes: 0, pai: 0 };
    const pred = store.prediction(model, area, tag);
    if (pred) {
      const feats = pred.features || [];
      out.total_grids = feats.length;
      out.risk_grids = feats.filter((f) => ['ALTO', 'MEDIO', '1'].includes(String(f.properties?.Risco ?? ''))).length;
      out.perc_risk = out.total_grids ? Math.round((out.risk_grids / out.total_grids) * 1000) / 10 : 0;
    }
    const crimes = store.crimes(area, tag);
    if (crimes) out.total_crimes = (crimes.features || []).length;
    const row = store.metricsSummary().filter((r) => r.Area === area && r.Modelo === model && r.Tag === tag).pop();
    if (row) out.pai = Math.round(Number(row.PAI || 0) * 100) / 100;
    return out;
  });

  get('/api/metrics/([^/]+)', (url, [area]) => {
    need(area, RE.area, 'area');
    const tag = q(url, 'tag', RE.tag);
    const all = store.metricsSummary();
    let rows = all.filter((r) => r.Area === area);
    if (tag) {
      rows = rows.filter((r) => r.Tag === tag && Number(r['Crimes Totais'] || 0) > 0);
    }
    const latest = {};
    for (const r0 of rows) {
      const r = { ...r0 };
      for (const k of Object.keys(r)) if (r[k] === '' || r[k] == null) r[k] = '0';
      const valid = r.Recall !== '0';
      const prev = latest[r.Modelo];
      if (!prev) { latest[r.Modelo] = r; continue; }
      const prevValid = prev.Recall !== '0';
      if ((valid && !prevValid) || (valid === prevValid && (r.Run_Timestamp || '') >= (prev.Run_Timestamp || ''))) {
        latest[r.Modelo] = r;
      }
    }
    for (const r of Object.values(latest)) {
      if ((r.Recall ?? '0') == '0' && r['TP (Foco)'] != null && r['FN (Perdidos)'] != null) {
        const tp = Number(r['TP (Foco)']), fn = Number(r['FN (Perdidos)']);
        if (tp + fn > 0) { r.Recall = tp / (tp + fn); r.TP = r['TP (Foco)']; r.FN = r['FN (Perdidos)']; }
      }
    }
    return Object.values(latest);
  });

  get('/api/zhang', (url) => {
    const tag = q(url, 'tag', RE.tag);
    return store.zhang().filter((r) => !tag || !('Tag' in r) || r.Tag === tag);
  });

  get('/api/geojson/([^/]+)/([^/]+)', (url, [model, area]) => {
    needModel(model); need(area, RE.area, 'area');
    const tag = q(url, 'tag', RE.tag) || store.defaultTag();
    const p = store.predictionFile(model, area, tag);
    if (p) return { __file: p };
    const g = store.prediction(model, area, tag);
    if (!g) throw new HttpError(404, 'previsão não encontrada');
    return g;
  });

  get('/api/crimes/([^/]+)', (url, [area]) => {
    need(area, RE.area, 'area');
    const g = store.crimes(area, q(url, 'tag', RE.tag));
    if (!g) throw new HttpError(404, 'crimes reais não encontrados para o mês');
    const limit = Number(process.env.PRECRIME_CRIMES_LIMIT || 1500);
    return { ...g, features: (g.features || []).slice(0, limit) };
  });

  get('/api/audit/([^/]+)/([^/]+)', (url, [model, area]) => {
    needModel(model); need(area, RE.area, 'area');
    const tag = q(url, 'tag', RE.tag) || store.defaultTag();
    const pred = store.prediction(model, area, tag);
    const crimes = store.crimes(area, tag);
    if (!pred || !crimes) throw new HttpError(404, 'sem previsão ou crimes reais para o mês');
    return audit(pred, crimes);
  });

  get('/api/grid-history/([^/]+)', (url, [area]) => {
    need(area, RE.area, 'area');
    const tag = q(url, 'tag', RE.tag) || store.defaultTag();
    const p = store.historyFile(area, tag);
    if (p) return { __file: p };
    const h = store.history(area, tag);
    if (!h) throw new HttpError(404, 'histórico não encontrado');
    return h;
  });

  get('/api/grid/([^/]+)/([^/]+)', (url, [area, gridId]) => {
    need(area, RE.area, 'area'); need(gridId, RE.grid, 'grid');
    const tag = q(url, 'tag', RE.tag) || store.defaultTag();
    const hist = store.history(area, tag);
    const data = hist?.grids?.[String(gridId)];
    if (!data) throw new HttpError(404, 'grid sem histórico');
    const score = store.gridScore(area, tag, gridId);
    return {
      grid_id: gridId,
      weeks: data.map((crimes, i) => ({ week: i + 1, crimes })),
      score,
      max_total: Number(hist.max_total || 1),
    };
  });

  // Fundo do mapa sem internet: as ruas da área (vindas do OpenStreetMap junto com as malhas)
  get('/api/streets/([^/]+)', (url, [area]) => {
    need(area, RE.area, 'area');
    const g = store.streets(area);
    if (!g) throw new HttpError(404, 'ruas da área não encontradas');
    return g;
  });

  // Pontos de interesse da área, por categoria (o painel do mapa liga cada uma)
  get('/api/pois/([^/]+)', (url, [area]) => {
    need(area, RE.area, 'area');
    const g = store.pois?.(area);
    if (!g) throw new HttpError(404, 'pontos de interesse da área não encontrados');
    return g;
  });

  get('/api/image/(.+)', (url, [rel]) => {
    const p = store.imagePath(rel);
    if (!p) throw new HttpError(404, 'imagem não encontrada');
    return { __file: p };
  });

  // Título, apresentação e aviso de uso responsável do pacote publicado (vazio no mapa interno)
  get('/api/site', () => store.site() || {});

  // Fundo do mapa: tiles da CARTO com a chave do operador, ou as ruas da área (sem chave)
  get('/api/basemap', () => store.basemap?.() || { provedor: 'ruas' });

  // Caminhos em uso, só no mapa interno do app (--live). Um pacote publicado não expõe.
  if (opts.live) {
    get('/api/debug', () => ({
      data_proc_dir: store.dataDir,
      static_dashboard_dir: opts.publicDir || null,
      index_html_exists: !!opts.publicDir,
      tags: store.tags(),
    }));
  }

  return function dispatch(url) {
    for (const r of routes) {
      const m = url.pathname.match(r.re);
      if (m) return r.fn(url, m.slice(1).map(decodeURIComponent));
    }
    return undefined;
  };
}

// ── Auditoria espacial: crimes reais dentro das zonas vermelha/amarela ─────────
function rings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return [];
}
function bbox(ring) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of ring) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function audit(pred, crimes) {
  const red = [], yellow = [];
  for (const f of pred.features || []) {
    const fill = f.properties?.fill;
    const target = fill === '#ff0000' ? red : fill === '#ffff00' ? yellow : null;
    if (!target) continue;
    target.push(rings(f.geometry).map((r) => ({ r, b: bbox(r) })));
  }
  const hit = (pt, poly) => poly.some(({ r, b }) => pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && inRing(pt, r));
  const feats = crimes.features || [];
  let cRed = 0, cYel = 0;
  const redHit = new Set();
  for (const c of feats) {
    const pt = c.geometry?.coordinates;
    if (!pt) continue;
    const i = red.findIndex((poly) => hit(pt, poly));
    if (i >= 0) { cRed++; redHit.add(i); continue; }
    if (yellow.some((poly) => hit(pt, poly))) cYel++;
  }
  const cap = cRed + cYel;
  return {
    total_crimes: feats.length,
    crimes_red: cRed,
    crimes_yellow: cYel,
    crimes_captured: cap,
    crimes_missed: feats.length - cap,
    total_red_grids: red.length,
    red_grids_hit: redHit.size,
    red_grids_miss: red.length - redHit.size,
  };
}

export { HttpError };
