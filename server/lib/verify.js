// Verificação de um pacote de publicação:
//   checkFiles(pkgDir)   — sha256 de cada arquivo confere com o manifesto, nada sobrando,
//                          nenhum dado bruto (planilhas, base unificada, datasets, modelos);
//   compareServers(...)  — o servidor do pacote devolve os mesmos dados que o servidor ao vivo
//                          (data/processed) em todas as rotas dos meses, áreas e modelos publicados.
// Também exporta diff(), a comparação de JSON entre duas respostas.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const posix = (p) => p.split(sep).join('/');

// O que nunca pode ir para um pacote público
export const PROIBIDOS = [
  [/\.xlsx?$/i, 'planilha da SSP'],
  [/dados_unificados/i, 'base unificada'],
  [/dataset_full/i, 'dataset de treino'],
  [/\.(pkl|pth|pt|joblib)$/i, 'modelo treinado'],
  [/(^|\/)(dados_ssp|raw|runs|datasets|models)\//i, 'pasta de trabalho'],
  [/(^|\/)results_(rf|lstm|transformer|ensemble)_area/i, 'resultado bruto por célula'],
  [/parametros\.json$/i, 'parâmetros da pasta de trabalho'],
];

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

export function checkFiles(pkgDir) {
  const problemas = [];
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(pkgDir, 'manifest.json'), 'utf8')); } catch { return { ok: false, problemas: ['manifest.json ausente ou inválido'], arquivos: 0, tamanho: 0 }; }
  const listed = new Map(manifest.arquivos.map((f) => [f.caminho, f]));
  const present = listFiles(pkgDir).map((p) => posix(relative(pkgDir, p))).filter((p) => p !== 'manifest.json');
  let tamanho = 0;
  for (const rel of present) {
    const f = listed.get(rel);
    const buf = readFileSync(join(pkgDir, rel));
    tamanho += buf.length;
    if (!f) problemas.push(`arquivo fora do manifesto: ${rel}`);
    else if (createHash('sha256').update(buf).digest('hex') !== f.sha256) problemas.push(`arquivo alterado: ${rel}`);
    for (const [re, what] of PROIBIDOS) if (re.test(rel)) problemas.push(`${what} no pacote: ${rel}`);
  }
  for (const rel of listed.keys()) if (!present.includes(rel)) problemas.push(`arquivo faltando: ${rel}`);
  return { ok: !problemas.length, problemas, arquivos: present.length, tamanho };
}

// ── comparação de JSON ─────────────────────────────────────────────────────────
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
function near(a, b) {
  const x = num(a), y = num(b);
  if (x == null || y == null) return false;
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
}
/** Diferenças entre a e b: [{path, a, b}] (número × texto numérico iguais contam como iguais). */
export function diff(a, b, path = '', out = []) {
  if (out.length > 50) return out;
  if (a === b) return out;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (near(a, b)) return out;
    out.push({ path, a, b });
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push({ path, a: '[tipo]', b: '[tipo]' }); return out; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: `${path}.length`, a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in a)) out.push({ path: p, a: '(ausente)', b: b[k] });
    else if (!(k in b)) out.push({ path: p, a: a[k], b: '(ausente)' });
    else diff(a[k], b[k], p, out);
  }
  return out;
}

async function get(base, path) {
  const r = await fetch(base + path);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, json };
}

/**
 * Compara o servidor do pacote (pkgBase) com o servidor ao vivo (liveBase).
 * sel: a seleção do manifesto { meses, areas, modelos, crimes_reais, metricas, ruas, pois }.
 */
export async function compareServers({ pkgBase, liveBase, sel, grids = 4, onProgress = () => {} }) {
  const MODELS = sel.modelos;
  const rotas = [];
  for (const t of sel.meses) {
    const q = `?tag=${t}`;
    rotas.push({ p: `/api/zhang${q}`, zhang: true });
    for (const a of sel.areas) {
      rotas.push({ p: `/api/metrics/${a}${q}`, metricas: true }, { p: `/api/grid-history/${a}${q}` });
      if (sel.crimes_reais) rotas.push({ p: `/api/crimes/${a}${q}` });
      for (const m of MODELS) {
        rotas.push({ p: `/api/geojson/${m}/${a}${q}` }, { p: `/api/kpis/${a}/${m}${q}`, kpis: true });
        if (sel.crimes_reais) rotas.push({ p: `/api/audit/${m}/${a}${q}` });
      }
      if (sel.ruas) rotas.push({ p: `/api/streets/${a}` });
      if (sel.pois) rotas.push({ p: `/api/pois/${a}` });
    }
  }
  const out = { rotas: 0, iguais: 0, diferencas: [], ausentes: [] };
  // grids: os primeiros e os de mais crimes, de cada área e mês
  const extra = [];
  for (const t of sel.meses) for (const a of sel.areas) {
    const h = await get(pkgBase, `/api/grid-history/${a}?tag=${t}`);
    const g = h.json?.grids || {};
    const ids = Object.keys(g);
    const busy = [...ids].sort((x, y) => g[y].reduce((s, v) => s + v, 0) - g[x].reduce((s, v) => s + v, 0));
    for (const id of new Set([...ids.slice(0, grids / 2), ...busy.slice(0, grids / 2)])) extra.push({ p: `/api/grid/${a}/${id}?tag=${t}` });
  }
  rotas.push(...extra);

  // própria configuração do pacote: só os meses escolhidos
  const cfg = await get(pkgBase, '/api/config');
  if (cfg.status !== 200 || JSON.stringify(cfg.json?.available_tags) !== JSON.stringify([...sel.meses].sort())) {
    out.diferencas.push({ rota: '/api/config', motivo: 'meses do pacote diferentes da seleção', a: cfg.json?.available_tags, b: sel.meses });
  }

  let i = 0;
  for (const r of rotas) {
    onProgress({ done: i++, total: rotas.length, rota: r.p });
    const [A, B] = await Promise.all([get(pkgBase, r.p), get(liveBase, r.p)]);
    out.rotas++;
    // os dois sem resposta (ex.: crimes reais de um mês ainda não validado): igual
    if (A.status === B.status && A.status !== 200) { out.iguais++; continue; }
    if (A.status !== 200) { out.ausentes.push({ rota: r.p, status: A.status }); continue; }
    if (B.status !== 200) { out.diferencas.push({ rota: r.p, motivo: `ao vivo respondeu ${B.status}` }); continue; }
    let a = A.json, b = B.json;
    // o pacote só tem as áreas escolhidas: no ao vivo, ignora as outras
    if (r.zhang) b = (b || []).filter((x) => !('Area' in x) || sel.areas.includes(x.Area));
    if (r.metricas && !sel.metricas) { out.iguais++; continue; }
    if (r.kpis) {
      if (!sel.crimes_reais) { delete a.total_crimes; delete b.total_crimes; }
      if (!sel.metricas) { delete a.pai; delete b.pai; }
    }
    const d = diff(a, b);
    if (d.length) out.diferencas.push({ rota: r.p, n: d.length, exemplos: d.slice(0, 3) });
    else out.iguais++;
  }
  onProgress({ done: rotas.length, total: rotas.length });
  out.ok = !out.diferencas.length && !out.ausentes.length;
  return out;
}
