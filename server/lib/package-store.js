// Leitura de um pacote de publicação (pasta data/ com pacote.json), gerado por package-build.js.
// Mesma interface do createStore (data.js): as rotas não sabem de onde vêm os dados.
//
// No pacote cada GeoJSON de previsão foi separado em geometria (uma por área, igual em todos os
// modelos e meses) e propriedades das células. Aqui o GeoJSON é remontado na memória e fica
// idêntico ao original (conferido por verify.js contra o servidor ao vivo).
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseCsv } from './csv.js';
import { normalizarFundo } from './data.js';

export function createPackageStore(dataDir, { cacheSize = 60 } = {}) {
  const idx = JSON.parse(readFileSync(join(dataDir, 'pacote.json'), 'utf8'));
  const cache = new Map();
  const root = normalize(dataDir + sep);

  function file(rel) {
    if (!rel) return null;
    const p = normalize(join(dataDir, rel));
    return p.startsWith(root) && existsSync(p) ? p : null;
  }
  function load(rel, parse) {
    const p = file(rel);
    if (!p) return null;
    if (cache.has(p)) { const v = cache.get(p); cache.delete(p); cache.set(p, v); return v; }
    let buf = readFileSync(p);
    if (p.endsWith('.gz')) buf = gunzipSync(buf);
    const v = parse(buf.toString('utf8'));
    cache.set(p, v);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    return v;
  }
  const json = (rel) => load(rel, JSON.parse);

  const tags = () => [...(idx.tags || [])].sort();
  const defaultTag = () => { const t = tags(); return t.length ? t[t.length - 1] : null; };
  const areas = (tag) => Object.keys(idx.previsoes?.[tag || defaultTag()] || {}).sort();

  const built = new Map(); // GeoJSON remontados
  function prediction(model, area, tag) {
    const t = tag || defaultTag();
    const rel = idx.previsoes?.[t]?.[area]?.[model];
    if (!rel) return null;
    if (built.has(rel)) return built.get(rel);
    const p = json(rel);
    if (p?.features) return { ...p.top, features: p.features }; // GeoJSON fora do padrão: guardado inteiro
    const g = p && json(idx.geometrias?.[p.geometria]);
    if (!p || !g) return null;
    const features = p.rows.map((row, i) => {
      const props = {};
      for (const k of p.keys) props[k] = k in p.const ? p.const[k] : row[p.vary.indexOf(k)];
      return { type: 'Feature', properties: props, geometry: g.geometries[i] };
    });
    const out = { ...p.top, features };
    built.set(rel, out);
    while (built.size > 16) built.delete(built.keys().next().value);
    return out;
  }

  function crimes(area, tag) {
    const all = idx.crimes?.[area] || {};
    if (tag) return json(all[tag]);
    // sem mês: o mais recente (mesma regra do servidor ao vivo)
    const last = Object.keys(all).sort().pop();
    return last ? json(all[last]) : null;
  }

  const history = (area, tag) => json(idx.historico?.[area]?.[tag || defaultTag()]);
  function gridScore(area, tag, gridId) {
    const s = json(idx.scores_grid?.[area]?.[tag || defaultTag()]);
    return Number(s?.scores?.[String(gridId)] ?? 0);
  }

  return {
    mode: 'package', dataDir, tags, defaultTag, areas,
    models: () => idx.modelos,
    predictionFile: () => null,
    prediction,
    crimes,
    historyFile: () => null,
    history,
    gridScore,
    metricsSummary: () => load(idx.metricas, parseCsv) || [],
    zhang: () => load(idx.zhang, parseCsv) || [],
    streets: (area) => json(idx.ruas?.[area]),
    pois: (area) => json(idx.pois?.[area]),
    areaNames: () => idx.nomes_areas || {},
    imagePath: () => null,
    site: () => idx.site || null,
    basemap: () => normalizarFundo(idx.fundo),
    index: () => idx,
  };
}
