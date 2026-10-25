#!/usr/bin/env node
// Verificação do servidor: sobe o server.js numa porta livre (ou usa --url) e chama
// todas as rotas para todas as áreas, modelos e meses. Falha (exit 1) se alguma rota
// responder 5xx, se um JSON vier inválido ou se faltar arquivo de previsão.
//
//   node tools/smoke.js --data ../data/processed
//   node tools/smoke.js --url http://127.0.0.1:8080
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };

async function start() {
  if (arg('url')) return { base: arg('url').replace(/\/$/, ''), stop() {} };
  const args = [join(HERE, '..', 'server.js'), '--port', '0'];
  if (arg('data')) args.push('--data', arg('data'));
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((ok, fail) => {
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; const m = buf.match(/LISTENING (\d+)/); if (m) ok(m[1]); });
    p.on('exit', (c) => fail(new Error('servidor saiu com código ' + c)));
  });
  return { base: `http://127.0.0.1:${port}`, stop: () => p.kill() };
}

const { base, stop } = await start();
const stats = { ok: 0, notFound: 0, fail: 0 };
const problems = [];

async function hit(path, { json = true, expect404 = false } = {}) {
  const t0 = Date.now();
  const r = await fetch(base + path);
  const ms = Date.now() - t0;
  if (r.status === 404) { stats.notFound++; if (!expect404) problems.push(`404 ${path}`); return null; }
  if (!r.ok) { stats.fail++; problems.push(`${r.status} ${path}`); return null; }
  let body = null;
  if (json) { try { body = await r.json(); } catch { stats.fail++; problems.push(`JSON inválido ${path}`); return null; } }
  else await r.arrayBuffer();
  stats.ok++;
  if (ms > 3000) problems.push(`lento (${ms} ms) ${path}`);
  return body;
}

try {
  await hit('/', { json: false });
  await hit('/app.js', { json: false });
  await hit('/vendor/leaflet/leaflet.js', { json: false });
  const traversal = await fetch(base + '/..%2f..%2fpackage.json');
  if (traversal.status !== 404) problems.push('ATENÇÃO: caminho com ../ não foi bloqueado');

  const cfg = await hit('/api/config');
  const months = await hit('/api/months');
  console.log(`meses: ${months.map((m) => m.tag).join(', ')} | áreas: ${cfg.areas.length}`);

  for (const { tag } of months) {
    const q = `?tag=${tag}`;
    const zhang = await hit(`/api/zhang${q}`);
    let validated = 0;
    for (const area of cfg.areas) {
      const metrics = await hit(`/api/metrics/${area}${q}`);
      if (metrics && metrics.length) validated++;
      const hist = await hit(`/api/grid-history/${area}${q}`, { expect404: true });
      const crimes = await hit(`/api/crimes/${area}${q}`, { expect404: true });
      for (const model of cfg.models) {
        await hit(`/api/kpis/${area}/${model}${q}`);
        const geo = await hit(`/api/geojson/${model}/${area}${q}`);
        if (geo && !Array.isArray(geo.features)) problems.push(`geojson sem features ${model}/${area}/${tag}`);
        if (crimes) await hit(`/api/audit/${model}/${area}${q}`);
      }
      if (hist) {
        const id = Object.keys(hist.grids || {})[0];
        if (id) await hit(`/api/grid/${area}/${id}${q}`);
      }
    }
    console.log(`  ${tag}: ${validated}/${cfg.areas.length} áreas com métricas | zhang: ${zhang.length} linhas`);
  }
  // fundo do mapa sem internet (ruas da área); 404 quando a pasta não tem streets/
  let ruas = 0;
  for (const area of cfg.areas) {
    const g = await hit(`/api/streets/${area}`, { expect404: true });
    if (g) { ruas++; if (!Array.isArray(g.features) || !g.features.length) problems.push(`ruas vazias ${area}`); }
  }
  console.log(`  ruas para o mapa sem internet: ${ruas}/${cfg.areas.length} áreas`);
  // entradas inválidas devem dar 400
  for (const bad of ['/api/kpis/../x/Ensemble', '/api/geojson/Hack/area_01', '/api/metrics/area_01?tag=2025-12']) {
    const r = await fetch(base + bad);
    if (r.status !== 400 && r.status !== 404) problems.push(`entrada inválida aceita: ${bad} -> ${r.status}`);
  }
} finally {
  stop();
}

console.log(`\nrespostas ok: ${stats.ok} | 404 esperados: ${stats.notFound} | falhas: ${stats.fail}`);
if (problems.length) { console.log('problemas:'); for (const p of problems.slice(0, 40)) console.log('  - ' + p); }
process.exit(stats.fail || problems.some((p) => !p.startsWith('lento')) ? 1 : 0);
