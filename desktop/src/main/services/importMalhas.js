// Importar malhas, ruas e pontos de interesse de uma vez (pastas ou vários arquivos GeoJSON).
//
// O que vale é o conteúdo, não o nome do arquivo: cada GeoJSON é lido e classificado pela geometria.
//   - malha:    muitos polígonos pequenos (células de até ~2 km de lado)  → streets/grids_area_NN.geojson
//   - ruas:     linhas                                                       → streets/ruas_area_NN.geojson
//   - pontos:   pontos (pontos de interesse)                                 → pois/pois_area_NN.geojson
//   - contorno: poucos polígonos grandes (bairro, cidade)                    → não entra aqui: é "Adicionar área",
//               que gera a malha de células a partir do contorno.
// O nome só serve para saber de qual área é o arquivo: "area_11", "grids_area_11" ou "pois_area_11" → area_11.
// Sem número no nome, a malha vira uma área nova (area_12 em diante, com o nome do arquivo), as ruas vão para a
// área cuja malha elas cobrem e os pontos são repartidos entre as áreas pelas células onde caem.
// A malha sem GRID_ID ganha GRID_ID = ordem da célula no
// arquivo, como nas malhas da dissertação. Nunca sobrescreve: o que já existe na pasta de trabalho fica.
const fs = require('fs');
const path = require('path');
const areasSvc = require('./areas');

const EXT_RE = /\.(geojson|json)$/i;
const PULAR = new Set(['node_modules', '.git', 'processed', 'runs', 'publish', '_removidas', '_removidos', 'conjuntos', '_cache_osm', '_anteriores']);
const MAX_BYTES = 400 * 1048576;
const LADO_MAX_M = 2000;      // célula: lado de até 2 km

const pad2 = (n) => String(n).padStart(2, '0');
const idDoNome = (nome) => { const m = /area[_\- ]?(\d{1,3})(?!\d)/i.exec(nome); return m ? `area_${pad2(Number(m[1]))}` : null; };
const stem = (f) => path.basename(f).replace(EXT_RE, '');

/** Arquivos .geojson/.json nas pastas (com subpastas, até 4 níveis) e os soltos. */
function coletar(paths) {
  const out = [];
  const visto = new Set();
  const visita = (p, prof) => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isFile()) { if (EXT_RE.test(p) && st.size > 0 && st.size <= MAX_BYTES && !visto.has(p)) { visto.add(p); out.push(p); } return; }
    if (!st.isDirectory() || prof > 4) return;
    let ents = []; try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) if (!(e.isDirectory() && PULAR.has(e.name))) visita(path.join(p, e.name), prof + 1);
  };
  for (const p of paths) visita(p, 0);
  return out;
}

// ── geometria ───────────────────────────────────────────────────────────────────────────────
function aneis(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}
function bboxCoords(coords, b = [Infinity, Infinity, -Infinity, -Infinity]) {
  if (typeof coords[0] === 'number') {
    if (coords[0] < b[0]) b[0] = coords[0]; if (coords[1] < b[1]) b[1] = coords[1];
    if (coords[0] > b[2]) b[2] = coords[0]; if (coords[1] > b[3]) b[3] = coords[1];
    return b;
  }
  for (const c of coords) bboxCoords(c, b);
  return b;
}
const ladoM = (b) => {
  const k = Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180);
  return Math.max((b[2] - b[0]) * 111320 * k, (b[3] - b[1]) * 110540);
};
function dentroAnel(x, y, anel) {
  let d = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
const dentroPoligono = (x, y, poly) => dentroAnel(x, y, poly[0]) && !poly.slice(1).some((h) => dentroAnel(x, y, h));

/** Lê e classifica um GeoJSON pelo conteúdo. */
function classificar(file) {
  let gj;
  try { gj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return { file, tipo: 'invalido', motivo: 'não é um GeoJSON válido' }; }
  const fs_ = gj?.type === 'FeatureCollection' && Array.isArray(gj.features) ? gj.features : gj?.type === 'Feature' ? [gj] : null;
  if (!fs_) return { file, tipo: 'invalido', motivo: 'não é um GeoJSON (FeatureCollection)' };
  const crs = gj.crs?.properties?.name || '';
  if (crs && !/CRS84|4326/i.test(crs)) return { file, tipo: 'invalido', motivo: `projeção ${crs}: use latitude e longitude (WGS84)` };
  const n = { pontos: 0, linhas: 0, poligonos: 0 };
  let celulas = 0;
  for (const f of fs_) {
    const t = f?.geometry?.type || '';
    if (/Point/.test(t)) n.pontos++;
    else if (/LineString/.test(t)) n.linhas++;
    else if (/Polygon/.test(t)) { n.poligonos++; if (ladoM(bboxCoords(f.geometry.coordinates)) <= LADO_MAX_M) celulas++; }
  }
  const total = n.pontos + n.linhas + n.poligonos;
  if (!total) return { file, tipo: 'invalido', motivo: 'sem geometrias' };
  const bb = bboxCoords(fs_.filter((f) => f?.geometry?.coordinates).map((f) => f.geometry.coordinates));
  if (bb[0] < -180 || bb[2] > 180 || bb[1] < -90 || bb[3] > 90) return { file, tipo: 'invalido', motivo: 'coordenadas fora de latitude e longitude (WGS84)' };
  const maior = Object.entries(n).sort((a, b) => b[1] - a[1])[0][0];
  let tipo = maior === 'pontos' ? 'pontos' : maior === 'linhas' ? 'ruas' : 'contorno';
  if (tipo === 'contorno' && n.poligonos >= 20 && celulas >= 0.8 * n.poligonos) tipo = 'malha';
  return { file, tipo, gj, n: fs_.length, bbox: bb, id: idDoNome(path.basename(file)) };
}

const sobrepoe = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/** Índice das células de uma malha para achar em qual célula cai um ponto. */
function indiceMalha(gj) {
  const passo = 0.01;
  const balde = new Map();
  const polys = [];
  for (const f of gj.features) for (const poly of aneis(f.geometry)) {
    const b = bboxCoords(poly[0]);
    const i = polys.push({ poly, b }) - 1;
    for (let x = Math.floor(b[0] / passo); x <= Math.floor(b[2] / passo); x++) {
      for (let y = Math.floor(b[1] / passo); y <= Math.floor(b[3] / passo); y++) {
        const k = `${x}_${y}`; if (!balde.has(k)) balde.set(k, []); balde.get(k).push(i);
      }
    }
  }
  return (x, y) => (balde.get(`${Math.floor(x / passo)}_${Math.floor(y / passo)}`) || [])
    .some((i) => { const { poly, b } = polys[i]; return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && dentroPoligono(x, y, poly); });
}

/**
 * Importa o que achar em `paths` para a pasta de trabalho.
 * Devolve { areas: [{area, nome, malha, ruas, pontos, nova}], copiados, existiam, contornos, invalidos, ignorados, avisos, resumo }.
 */
function importar(ws, paths) {
  const arquivos = coletar((paths || []).map(String).filter(Boolean));
  if (!arquivos.length) throw new Error('Não achei nenhum arquivo GeoJSON (.geojson ou .json) nas pastas ou arquivos escolhidos.');
  const reg = areasSvc.registry(ws);
  const streets = path.join(ws, 'streets'), pois = path.join(ws, 'pois');
  fs.mkdirSync(streets, { recursive: true }); fs.mkdirSync(pois, { recursive: true });
  const existe = (f) => fs.existsSync(f);
  const out = { areas: {}, copiados: [], existiam: [], contornos: [], invalidos: [], ignorados: [], avisos: [] };
  const nota = (area, k, v) => { (out.areas[area] = out.areas[area] || { area, nome: reg.areas[area]?.nome || null })[k] = v; };

  const lidos = arquivos.map(classificar);
  for (const c of lidos) {
    if (c.tipo === 'invalido') out.invalidos.push(`${path.basename(c.file)} (${c.motivo})`);
    if (c.tipo === 'contorno') out.contornos.push(path.basename(c.file));
  }

  // 1. malhas
  const proximoId = () => {
    const usados = new Set([...Object.keys(reg.areas), ...fs.readdirSync(streets).map((f) => /^grids_(area_\d+)\.geojson$/.exec(f)?.[1]).filter(Boolean)]);
    let n = 12; while (usados.has(`area_${pad2(n)}`)) n++;
    return `area_${pad2(n)}`;
  };
  const malhas = {};   // area → gj (as que ficaram na pasta, para repartir pontos e achar ruas)
  for (const c of lidos.filter((x) => x.tipo === 'malha')) {
    const dissertacao = c.id && Number(c.id.slice(5)) <= 11 && !reg.areas[c.id];
    let area = c.id && (dissertacao || reg.areas[c.id]) ? c.id : null;
    const nova = !area;
    if (nova) area = proximoId();
    const dst = path.join(streets, `grids_${area}.geojson`);
    if (existe(dst)) { out.existiam.push(`grids_${area}.geojson`); nota(area, 'malha', 'já existia'); continue; }
    const temId = c.gj.features.every((f) => f.properties && f.properties.GRID_ID !== undefined && f.properties.GRID_ID !== null);
    if (temId) fs.copyFileSync(c.file, dst);
    else {
      c.gj.features.forEach((f, i) => { f.properties = { GRID_ID: i, ...(f.properties || {}) }; });
      c.gj.name = area;
      fs.writeFileSync(dst, JSON.stringify(c.gj));
    }
    malhas[area] = c.gj;
    out.copiados.push(`grids_${area}.geojson ← ${path.basename(c.file)}`);
    nota(area, 'malha', `${c.n.toLocaleString('pt-BR')} células${temId ? '' : ' (GRID_ID criado pela ordem das células)'}`);
    if (nova) {
      const lados = c.gj.features.slice(0, 200).map((f) => ladoM(bboxCoords(f.geometry.coordinates))).sort((a, b) => a - b);
      const lado = Math.round((lados[Math.floor(lados.length / 2)] || 200) / 10) * 10;
      reg.areas[area] = { nome: stem(c.file).slice(0, 60), celula_m: lado, celulas: c.n, km2: Math.round(((c.n * lado * lado) / 1e6) * 10) / 10,
        arquivo: path.basename(c.file), criadaEm: new Date().toISOString(), importada: true };
      areasSvc.saveRegistry(ws, reg);
      nota(area, 'nome', reg.areas[area].nome); nota(area, 'nova', true);
    }
  }
  // malhas que já estavam na pasta (para ruas e pontos sem número no nome)
  const lerMalha = (area) => {
    if (!malhas[area]) { try { malhas[area] = JSON.parse(fs.readFileSync(path.join(streets, `grids_${area}.geojson`), 'utf8')); } catch { malhas[area] = null; } }
    return malhas[area];
  };
  const areasNaPasta = () => fs.readdirSync(streets).map((f) => /^grids_(area_\d+)\.geojson$/.exec(f)?.[1]).filter(Boolean).sort();
  const bboxMalha = {};
  const bbM = (a) => (bboxMalha[a] = bboxMalha[a] || (lerMalha(a) ? bboxCoords(lerMalha(a).features.map((f) => f.geometry.coordinates)) : null));

  // 2. ruas
  for (const c of lidos.filter((x) => x.tipo === 'ruas')) {
    let area = c.id && existe(path.join(streets, `grids_${c.id}.geojson`)) ? c.id : null;
    if (!area) {
      const cand = areasNaPasta().map((a) => [a, bbM(a) ? sobrepoe(bbM(a), c.bbox) : 0]).sort((x, y) => y[1] - x[1])[0];
      area = cand && cand[1] > 0 ? cand[0] : null;
    }
    if (!area) { out.ignorados.push(`${path.basename(c.file)} (ruas fora de todas as malhas)`); continue; }
    const dst = path.join(streets, `ruas_${area}.geojson`);
    if (existe(dst)) { out.existiam.push(`ruas_${area}.geojson`); nota(area, 'ruas', 'já existia'); continue; }
    fs.copyFileSync(c.file, dst);
    out.copiados.push(`ruas_${area}.geojson ← ${path.basename(c.file)}`);
    nota(area, 'ruas', `${c.n.toLocaleString('pt-BR')} trechos`);
  }

  // 3. pontos de interesse: com número no nome, copiados; sem número, repartidos pelas células das malhas
  for (const c of lidos.filter((x) => x.tipo === 'pontos')) {
    if (c.id && existe(path.join(streets, `grids_${c.id}.geojson`))) {
      const dst = path.join(pois, `pois_${c.id}.geojson`);
      if (existe(dst)) { out.existiam.push(`pois_${c.id}.geojson`); nota(c.id, 'pontos', 'já existia'); continue; }
      fs.copyFileSync(c.file, dst);
      out.copiados.push(`pois_${c.id}.geojson ← ${path.basename(c.file)}`);
      nota(c.id, 'pontos', `${c.n.toLocaleString('pt-BR')} pontos`);
      continue;
    }
    let algum = false;
    for (const area of areasNaPasta()) {
      const dst = path.join(pois, `pois_${area}.geojson`);
      if (!bbM(area) || !sobrepoe(bbM(area), c.bbox)) continue;
      if (existe(dst)) { out.existiam.push(`pois_${area}.geojson`); nota(area, 'pontos', 'já existia'); algum = true; continue; }
      const dentro = indiceMalha(lerMalha(area));
      const feats = c.gj.features.filter((f) => {
        const g = f?.geometry; if (!g) return false;
        const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : [];
        return pts.some(([x, y]) => dentro(x, y));
      });
      if (!feats.length) continue;
      fs.writeFileSync(dst, JSON.stringify({ type: 'FeatureCollection', name: `pois_${area}`, crs: c.gj.crs, features: feats }));
      out.copiados.push(`pois_${area}.geojson ← ${path.basename(c.file)} (${feats.length.toLocaleString('pt-BR')} pontos dentro da malha)`);
      nota(area, 'pontos', `${feats.length.toLocaleString('pt-BR')} pontos`);
      algum = true;
    }
    if (!algum) out.ignorados.push(`${path.basename(c.file)} (pontos fora de todas as malhas)`);
  }

  // avisos: área com malha e sem ruas (a Filtragem mantém todas as células, diferente da dissertação)
  for (const area of areasNaPasta()) {
    if (!existe(path.join(streets, `ruas_${area}.geojson`)) && out.areas[area]) {
      out.avisos.push(`${reg.areas[area]?.nome || area}: sem o arquivo de ruas. A Filtragem mantém todas as células (inclusive represa e mata), diferente da dissertação. Importe também o ruas_${area}.geojson ou use "Ruas e POIs" para baixar do OpenStreetMap.`);
    }
  }
  const lista = Object.values(out.areas).sort((a, b) => a.area.localeCompare(b.area));
  return { ...out, areas: lista, resumo: { malhas: out.copiados.filter((x) => x.startsWith('grids_')).length, ruas: out.copiados.filter((x) => x.startsWith('ruas_')).length, pois: out.copiados.filter((x) => x.startsWith('pois_')).length } };
}

/** Um arquivo só: é malha, ruas ou pontos (vai para importar) ou contorno (vai para "Adicionar área")? */
function tipoDoArquivo(file) {
  if (!EXT_RE.test(file)) return 'outro';
  try { if (fs.statSync(file).size > MAX_BYTES) return 'outro'; } catch { return 'outro'; }
  return classificar(file).tipo;
}

module.exports = { importar, tipoDoArquivo, classificar };
