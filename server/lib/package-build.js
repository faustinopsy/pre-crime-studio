// Monta o pacote de publicação: o servidor Node (sem dependências), o painel e só os dados
// escolhidos, em formato enxuto. Usado pelo app desktop (tela Publicação) e por
// tools/build_package.mjs.
//
// Estrutura gerada:
//   server.js  lib/  public/  package.json  README.md  Dockerfile  manifest.json
//   data/pacote.json                         índice lido pelo servidor (package-store.js)
//   data/geometria/<área>-<hash>.json.gz     geometria das células (uma por área)
//   data/previsoes/<Modelo>_<área>_<mês>.json.gz   propriedades das células (risco, score, cor)
//   data/crimes_reais/<área>_<mês>.json.gz   crimes reais do mês (se escolhido)
//   data/historico/<área>_<mês>.json.gz      histórico de 24 semanas por célula
//   data/scores_grid/<área>_<mês>.json.gz    score de cada célula (painel do grid)
//   data/metricas/*.csv                      métricas dos meses e áreas escolhidos (se escolhido)
//   data/ruas/<área>.json.gz                 fundo do mapa sem internet (se escolhido)
//   data/pois/<área>.json.gz                 pontos de interesse por categoria (se escolhido)
//
// Os arquivos de previsão do pipeline repetem a mesma geometria em cada modelo e mês (354 MB
// para 3 meses); no pacote ela é gravada uma vez por área.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createStore, gridScoresFrom, MODELS, normalizarFundo, nomesDasAreas } from './data.js';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const posix = (p) => p.split(sep).join('/');

export const AVISO_PADRAO = 'Previsão estatística a partir de registros da SSP-SP. Indica concentração provável de furtos e roubos de veículos por área, não aponta pessoas. Crimes não registrados ficam fora dos dados.';

function csvLine(vals) {
  return vals.map((v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
}
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [csvLine(cols), ...rows.map((r) => csvLine(cols.map((c) => r[c])))].join('\n') + '\n';
}

/** Separa um GeoJSON de previsão em geometria + linhas de propriedades. */
function splitPrediction(geo) {
  const feats = geo.features || [];
  const { features, ...top } = geo;
  const first = feats[0]?.properties || {};
  const keys = Object.keys(first);
  const uniform = feats.every((f) => {
    const ks = Object.keys(f);
    if (ks.length !== 3 || f.type !== 'Feature' || !('properties' in f) || !('geometry' in f)) return false;
    const pk = Object.keys(f.properties || {});
    return pk.length === keys.length && pk.every((k, i) => k === keys[i]);
  });
  if (!uniform || !feats.length) return { pred: { top, features: feats }, geometries: null };
  const konst = {};
  for (const k of keys) {
    const v = first[k];
    if (feats.every((f) => f.properties[k] === v)) konst[k] = v;
  }
  const vary = keys.filter((k) => !(k in konst));
  return {
    pred: { top, const: konst, keys, vary, rows: feats.map((f) => vary.map((k) => f.properties[k])) },
    geometries: feats.map((f) => f.geometry),
  };
}

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out;
}

/** Execuções do app (runs/) que geraram a previsão e a validação de cada mês escolhido. */
function provenance(workspaceDir, tags) {
  const runsDir = join(workspaceDir, 'runs');
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const id of readdirSync(runsDir).sort()) {
    try {
      const m = JSON.parse(readFileSync(join(runsDir, id, 'manifest.json'), 'utf8'));
      const mes = m.options?.mes?.replace('-', '_');
      if (!['predict', 'validate'].includes(m.job) || m.status !== 'ok' || !tags.includes(mes)) continue;
      out.push({ execucao: id, fase: m.job, mes, area: m.area || 'todas', em: m.endedAt || m.startedAt || null });
    } catch { /* execução sem manifesto (interrompida) */ }
  }
  return out;
}

/**
 * opts: {
 *   processedDir, workspaceDir?, serverDir, outDir, appVersion?,
 *   selection: { tags: [], areas: null|[], models: [], crimes: true, metricas: true, ruas: false, pois: false },
 *   site: { titulo, apresentacao, aviso },
 *   fundo: { provedor: 'carto', estilo, chave } | null  (null = ruas da área),
 *   onProgress?({ etapa, done, total, arquivo })
 * }
 */
export function buildPackage(opts) {
  const { processedDir, serverDir, outDir } = opts;
  const workspaceDir = opts.workspaceDir || dirname(processedDir);
  const sel = { crimes: true, metricas: true, ruas: false, pois: false, ...opts.selection };
  const progress = opts.onProgress || (() => {});
  const live = createStore(processedDir);
  const models = (sel.models?.length ? sel.models : MODELS).filter((m) => MODELS.includes(m));
  const tags = [...new Set(sel.tags || [])].filter((t) => live.tags().includes(t)).sort();
  if (!tags.length) throw new Error('Escolha ao menos um mês com previsão.');
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`A pasta do pacote já existe: ${outDir}`);
  const D = join(outDir, 'data');
  mkdirSync(D, { recursive: true });

  const origem = [];  // arquivos de onde os dados vieram (sha256 do original)
  const addOrigem = (abs) => { try { origem.push({ arquivo: posix(relative(processedDir, abs)), bytes: statSync(abs).size, sha256: sha256(readFileSync(abs)) }); } catch { /* sem arquivo */ } };
  const writeGz = (rel, obj) => {
    const p = join(D, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 }));
    return rel;
  };

  const idx = { formato: 1, tags, modelos: models, previsoes: {}, geometrias: {}, crimes: {}, historico: {}, scores_grid: {}, metricas: null, zhang: null, ruas: {}, pois: {}, site: null };
  const usedAreas = new Set();

  // 1. previsões (geometria uma vez por área)
  const jobs = [];
  for (const t of tags) {
    const areas = live.areas(t).filter((a) => !sel.areas?.length || sel.areas.includes(a));
    for (const a of areas) for (const m of models) if (live.predictionFile(m, a, t)) jobs.push([t, a, m]);
  }
  if (!jobs.length) throw new Error('Nenhuma previsão para os meses, áreas e modelos escolhidos.');
  jobs.forEach(([t, a, m], i) => {
    progress({ etapa: 'previsoes', done: i, total: jobs.length, arquivo: `${m} · ${a} · ${t}` });
    const src = live.predictionFile(m, a, t);
    addOrigem(src);
    const geo = JSON.parse(readFileSync(src, 'utf8'));
    const { pred, geometries } = splitPrediction(geo);
    if (geometries) {
      const gh = sha256(Buffer.from(JSON.stringify(geometries))).slice(0, 10);
      const gid = `${a}-${gh}`;
      if (!idx.geometrias[gid]) idx.geometrias[gid] = writeGz(`geometria/${gid}.json.gz`, { geometries });
      pred.geometria = gid;
    }
    ((idx.previsoes[t] = idx.previsoes[t] || {})[a] = idx.previsoes[t][a] || {})[m] = writeGz(`previsoes/${m}_${a}_${t}.json.gz`, pred);
    usedAreas.add(a);
  });

  // 2. crimes reais, histórico e score das células
  const pairs = tags.flatMap((t) => [...usedAreas].filter((a) => idx.previsoes[t]?.[a]).map((a) => [t, a]));
  pairs.forEach(([t, a], i) => {
    progress({ etapa: 'mes', done: i, total: pairs.length, arquivo: `${a} · ${t}` });
    if (sel.crimes) {
      const cp = live.crimesPath(a, t);
      if (cp) { addOrigem(cp); (idx.crimes[a] = idx.crimes[a] || {})[t] = writeGz(`crimes_reais/${a}_${t}.json.gz`, JSON.parse(readFileSync(cp, 'utf8'))); }
    }
    const hp = live.historyPath(a, t);
    if (hp) { addOrigem(hp); (idx.historico[a] = idx.historico[a] || {})[t] = writeGz(`historico/${a}_${t}.json.gz`, JSON.parse(readFileSync(hp, 'utf8'))); }
    const gs = gridScoresFrom(live.resultsCsv, a, t);
    if (gs.modelo) addOrigem(join(processedDir, 'results', `results_${gs.modelo}_${a}_${t}.csv`));
    (idx.scores_grid[a] = idx.scores_grid[a] || {})[t] = writeGz(`scores_grid/${a}_${t}.json.gz`, gs);
  });

  // 3. métricas só dos meses e áreas publicados
  if (sel.metricas) {
    progress({ etapa: 'metricas', done: 0, total: 1 });
    const keep = (r) => (!('Tag' in r) || tags.includes(r.Tag)) && (!('Area' in r) || usedAreas.has(r.Area));
    const ms = live.metricsSummary().filter(keep);
    if (ms.length) {
      addOrigem(join(processedDir, 'results', 'metrics_summary_all.csv'));
      mkdirSync(join(D, 'metricas'), { recursive: true });
      writeFileSync(join(D, 'metricas', 'metrics_summary_all.csv'), toCsv(ms));
      idx.metricas = 'metricas/metrics_summary_all.csv';
    }
    const zh = live.zhang().filter(keep);
    if (zh.length) {
      addOrigem(join(processedDir, 'metrics', 'zhang_comparison.csv'));
      mkdirSync(join(D, 'metricas'), { recursive: true });
      writeFileSync(join(D, 'metricas', 'zhang_comparison.csv'), toCsv(zh));
      idx.zhang = 'metricas/zhang_comparison.csv';
    }
  }

  // 4. ruas para o mapa sem internet
  if (sel.ruas) {
    [...usedAreas].forEach((a, i) => {
      progress({ etapa: 'ruas', done: i, total: usedAreas.size, arquivo: a });
      const g = live.streets(a);
      if (g) idx.ruas[a] = writeGz(`ruas/${a}.json.gz`, g);
    });
  }

  // 4b. pontos de interesse
  if (sel.pois) {
    [...usedAreas].forEach((a, i) => {
      progress({ etapa: 'pontos de interesse', done: i, total: usedAreas.size, arquivo: a });
      const g = live.pois(a);
      if (g) idx.pois[a] = writeGz(`pois/${a}.json.gz`, g);
    });
  }

  // 4c. nomes das áreas criadas pelo operador (as da dissertação ficam "Área 01"...)
  {
    const nomes = nomesDasAreas(workspaceDir);
    const usados = Object.fromEntries(Object.entries(nomes).filter(([k]) => usedAreas.has(k)));
    if (Object.keys(usados).length) idx.nomes_areas = usados;
  }

  // 5. textos do site
  const site = opts.site || {};
  idx.site = {
    titulo: String(site.titulo || 'Pre-Crime').slice(0, 80),
    apresentacao: String(site.apresentacao || '').slice(0, 600),
    aviso: String(site.aviso || AVISO_PADRAO).slice(0, 800),
  };
  // fundo do mapa: a chave da CARTO só entra se o operador escolheu (fica visível no site)
  idx.fundo = normalizarFundo(opts.fundo);
  writeFileSync(join(D, 'pacote.json'), JSON.stringify(idx, null, 1));

  // 6. servidor e painel
  progress({ etapa: 'servidor', done: 0, total: 1 });
  cpSync(join(serverDir, 'server.js'), join(outDir, 'server.js'));
  // só o que o servidor usa (o montador, a verificação e o zip ficam fora)
  mkdirSync(join(outDir, 'lib'), { recursive: true });
  for (const f of ['csv.js', 'data.js', 'routes.js', 'package-store.js']) cpSync(join(serverDir, 'lib', f), join(outDir, 'lib', f));
  cpSync(join(serverDir, 'public'), join(outDir, 'public'), { recursive: true });
  const label = tags.map((t) => t.split('_').reverse().join('/')).join(', ');
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({
    name: 'precrime-publicacao', version: opts.appVersion || '0.0.0', private: true, type: 'module',
    description: `Mapa de risco Pre-Crime (${label})`, engines: { node: '>=20' },
    scripts: { start: 'node server.js --host 0.0.0.0 --port 8080' },
  }, null, 2) + '\n');
  writeFileSync(join(outDir, 'Dockerfile'), 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 8080\nUSER node\nCMD ["node", "server.js", "--host", "0.0.0.0", "--port", "8080"]\n');
  writeFileSync(join(outDir, '.dockerignore'), '*.zip\n');
  writeFileSync(join(outDir, 'README.md'), deployReadme({ titulo: idx.site.titulo, label, areas: [...usedAreas].sort(), models }));

  // 7. manifesto com sha256 de cada arquivo
  progress({ etapa: 'manifesto', done: 0, total: 1 });
  const arquivos = listFiles(outDir).filter((p) => posix(relative(outDir, p)) !== 'manifest.json').sort().map((p) => {
    const buf = readFileSync(p);
    return { caminho: posix(relative(outDir, p)), bytes: buf.length, sha256: sha256(buf) };
  });
  const manifest = {
    formato: 1,
    criadoEm: new Date().toISOString(),
    app: { nome: 'Pre-Crime Studio', versao: opts.appVersion || null },
    selecao: { meses: tags, areas: [...usedAreas].sort(), modelos: models, crimes_reais: !!sel.crimes, metricas: !!idx.metricas, ruas: Object.keys(idx.ruas).length > 0, pois: Object.keys(idx.pois).length > 0 },
    site: idx.site,
    fundo: { provedor: idx.fundo.provedor, estilo: idx.fundo.estilo || null },
    tamanho: arquivos.reduce((s, f) => s + f.bytes, 0),
    tamanhoOrigem: origem.reduce((s, f) => s + f.bytes, 0),
    execucoes: provenance(workspaceDir, tags),
    origem,
    arquivos,
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  progress({ etapa: 'pronto', done: 1, total: 1 });
  return manifest;
}

function deployReadme({ titulo, label, areas, models }) {
  return `# ${titulo} — publicação

Mapa de risco gerado pelo Pre-Crime Studio. Meses: ${label}. Áreas: ${areas.map((a) => a.replace('area_', '')).join(', ')}. Modelos: ${models.join(', ')}.

Não precisa de \`npm install\`: o servidor usa só o Node.

## Rodar

Requer Node.js 20 ou mais novo.

\`\`\`bash
node server.js --host 0.0.0.0 --port 8080
\`\`\`

Abra http://<servidor>:8080. Sem \`--host\`, o servidor só atende a própria máquina (127.0.0.1).

### Manter rodando com PM2

\`\`\`bash
npm install -g pm2
pm2 start server.js --name precrime -- --host 0.0.0.0 --port 8080
pm2 save
\`\`\`

### Docker

\`\`\`bash
docker build -t precrime-publicacao .
docker run -d -p 8080:8080 --name precrime precrime-publicacao
\`\`\`

### Atrás do nginx

\`\`\`nginx
location / { proxy_pass http://127.0.0.1:8080; }
\`\`\`

## Conferir o pacote

\`manifest.json\` lista cada arquivo com o sha256, os arquivos de origem e as execuções do app que geraram a previsão e a validação. Os dados ficam em \`data/\`; nada da base bruta da SSP vai no pacote.

Rotas: \`/\` (painel), \`/api/config\`, \`/api/months\`, \`/api/geojson/{modelo}/{área}?tag=AAAA_MM\`, \`/api/kpis/...\`, \`/api/metrics/...\`, \`/api/crimes/...\`, \`/api/audit/...\`, \`/api/grid-history/...\`, \`/api/grid/...\`, \`/api/health\`.
`;
}
