// Modo científico → "Exportar resultados do replay": um .zip com o que o artigo precisa.
//
// <pasta de trabalho>/publish/artigo/replay_<data>.zip
//   resultados/        CSV e JSON de processed/replay_seeds (métricas, Wilcoxon, colapso, Ensemble ×
//                      membros, variantes, multi-seed, vazamento, registros das sementes); sem as
//                      previsões célula a célula (results_*.csv) nem os rótulos (labels_replay.csv)
//   execucoes/         o registro da sequência e o manifesto de cada execução dela
//   parametros.json    o que estava escolhido nas telas
//   overrides.json     os parâmetros enviados ao pipeline em cada execução
//   versao.json        a versão do código (commit do git, se houver; senão a data do pipeline)
//   LEIAME.txt         como cada arquivo foi gerado
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DESCR = {
  'metricas_replay.csv': 'PAI, F1, Precisão, Recall, HitRn, HitEn, PEI, n e fração de células selecionadas, células e taxa-base por área × mês × modelo × quantil (0,95/0,90/0,80) × corte (top_exato, maior_igual); PR-AUC, Brier e ECE (10 faixas) dos modelos. Rótulos do dataset completo; top exato com desempate aleatório pela semente da pasta.',
  'wilcoxon_replay.csv': 'Wilcoxon pareado (pares área × mês, q = 0,90, top exato) entre RF, LSTM, Transformer, Ensemble e as duas linhas de base, para PAI, F1, HitEn e ECE, com correção de Holm por métrica. Os pares de meses diferentes da mesma área não são independentes.',
  'colapso_replay.csv': 'Empates no corte por quantil: valores distintos, fração no valor mais comum, fração selecionada pela regra "maior ou igual" e PAI pelas duas regras.',
  'ensemble_vs_membros.csv': 'Para cada área × mês (q = 0,90, top exato): o Ensemble supera o melhor dos três membros? E a média deles?',
  'ensemble_variantes.csv': 'PAI, F1, ECE e HitEn de cada variante do Ensemble (recalculada pelo próprio step5_ensemble.py, sem novo treino).',
  'wilcoxon_variantes.csv': 'Wilcoxon de cada variante contra o Ensemble completo.',
  'metricas_multiseed.csv': 'Média, desvio, mínimo e máximo de cada métrica entre as sementes.',
  'wilcoxon_multiseed.csv': 'Wilcoxon sobre a média das sementes (q = 0,90, top exato).',
  'vazamento_comparacao.csv': 'PAI e F1 por modelo, área e mês com e sem vazamento (a versão com vazamento treina com todos os dados e NÃO é uma avaliação válida; serve só para mostrar o efeito).',
  'semente.json': 'Registro da semente: meses, malha (células por área, células repetidas), início do período, datas finais de cada treino (origens), modelos e diferenças do padrão da dissertação.',
  'origens.json': 'Mês previsto × data final do treino usado (origem móvel).',
  'resumo_ciencia.json': 'Resumo mostrado na tela do Modo científico.',
  'registro_multiseed.json': 'Registros das sementes agregadas e se elas usaram malhas diferentes.',
  'metrics_summary.csv': 'Validação padrão do app (step7) de cada mês, por semente.',
  'zhang_comparison.csv': 'Métricas de Zhang (HitRa, HitRn, HitEn, PAI) da validação padrão, por semente.',
};

function versaoCodigo(repoRoot) {
  // .git/HEAD → ref → commit (sem precisar do git instalado)
  for (const base of [repoRoot, path.dirname(repoRoot)]) {
    try {
      const head = fs.readFileSync(path.join(base, '.git', 'HEAD'), 'utf8').trim();
      if (/^[0-9a-f]{40}$/.test(head)) return { commit: head, origem: 'git' };
      const ref = head.replace(/^ref:\s*/, '');
      let commit = null;
      try { commit = fs.readFileSync(path.join(base, '.git', ref), 'utf8').trim(); } catch {
        const packed = fs.readFileSync(path.join(base, '.git', 'packed-refs'), 'utf8');
        commit = packed.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] || null;
      }
      if (commit) return { commit, ramo: ref.replace('refs/heads/', ''), origem: 'git' };
    } catch { /* sem git aqui */ }
  }
  let t = 0, qual = null;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== '__pycache__') walk(p); } else if (p.endsWith('.py') || p.endsWith('.json')) { const m = fs.statSync(p).mtimeMs; if (m > t) { t = m; qual = p; } } } };
  try { walk(path.join(repoRoot, 'pipeline')); } catch { /* sem pipeline */ }
  return { commit: null, origem: 'data de modificação do pipeline', pipelineModificadoEm: t ? new Date(t).toISOString() : null, arquivoMaisNovo: qual ? path.relative(repoRoot, qual) : null };
}

function copiar(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }

async function exportar(ws, { repoRoot, seqDir, appVersion }) {
  const raiz = path.join(ws, 'processed', 'replay_seeds');
  if (!fs.existsSync(raiz)) throw new Error('Ainda não há resultados do replay. Rode um replay no Modo científico antes.');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const base = path.join(ws, 'publish', 'artigo');
  const dir = path.join(base, `replay_${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const usados = new Set();
  const walk = (d, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== '_anteriores') walk(path.join(d, e.name), r); continue; }
      if (!/\.(csv|json)$/.test(e.name) || /^(results_|grid_history_|labels_replay)/.test(e.name)) continue;
      copiar(path.join(d, e.name), path.join(dir, 'resultados', ...r.split('/')));
      usados.add(e.name); n++;
    }
  };
  walk(raiz);

  // a última sequência do Modo científico e os manifestos das execuções dela
  let seq = null;
  try {
    const f = fs.readdirSync(seqDir).filter((x) => x.endsWith('_replay.json')).sort().pop();
    if (f) { seq = JSON.parse(fs.readFileSync(path.join(seqDir, f), 'utf8')); copiar(path.join(seqDir, f), path.join(dir, 'execucoes', f)); n++; }
  } catch { /* sem sequência */ }
  const overrides = [];
  for (const st of seq?.steps || []) {
    for (const r of st.runs || []) {
      const m = path.join(ws, 'runs', r.runId, 'manifest.json');
      if (!fs.existsSync(m)) continue;
      copiar(m, path.join(dir, 'execucoes', r.runId, 'manifest.json')); n++;
      try { const j = JSON.parse(fs.readFileSync(m, 'utf8')); overrides.push({ runId: r.runId, passo: st.label, job: j.job, params: j.params, personalizado: j.personalizado || {}, versoes: j.env?.versoesExecucao || null }); } catch { /* manifesto ilegível */ }
    }
  }
  fs.writeFileSync(path.join(dir, 'overrides.json'), JSON.stringify(overrides, null, 1)); n++;

  // manifestos dos conjuntos de pontos de interesse usados (o do replay e os comparados em poi_<id>)
  const conjuntos = new Set([seq?.params?.poiSet, ...(seq?.params?.compararConjuntos || [])].filter(Boolean));
  const ler = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  for (const e of fs.readdirSync(raiz, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^seed_\d+$/.test(e.name)) continue;
    const id = ler(path.join(raiz, e.name, 'semente.json'))?.registro?.pois?.id;
    if (id) conjuntos.add(id);
    for (const f of fs.readdirSync(path.join(raiz, e.name))) { const m = /^results_ensemble-poi-([a-z0-9][a-z0-9-]{0,47})_area_\d+_/.exec(f); if (m) conjuntos.add(m[1]); }
  }
  const idMulti = ler(path.join(raiz, 'registro_multiseed.json'))?.pois?.id;
  if (idMulti) conjuntos.add(idMulti);
  if (conjuntos.size) { try { require('./poiSets').ensureDissertacao(ws); } catch { /* sem pontos da dissertação */ } }
  const conjuntosCopiados = [];
  for (const id of [...conjuntos].sort()) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) continue;
    const m = path.join(ws, 'pois', 'conjuntos', id, 'manifesto.json');
    if (!fs.existsSync(m)) continue;
    copiar(m, path.join(dir, 'conjuntos_poi', id, 'manifesto.json')); n++;
    conjuntosCopiados.push(id);
  }
  try { copiar(path.join(ws, 'parametros.json'), path.join(dir, 'parametros.json')); n++; } catch { /* sem parâmetros: tudo no padrão */ }
  const versao = { ...versaoCodigo(repoRoot), app: appVersion, exportadoEm: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'versao.json'), JSON.stringify(versao, null, 1)); n++;

  const linhas = [
    'Resultados do replay sem vazamento (Pre-Crime Studio, Modo científico)',
    `Exportado em ${new Date().toLocaleString('pt-BR')} · app ${appVersion} · código: ${versao.commit ? `commit ${versao.commit}` : `pipeline modificado em ${versao.pipelineModificadoEm}`}`,
    seq ? `Sequência: ${seq.title} (${seq.id}), ${seq.status}` : 'Sequência: não encontrada',
    '',
    'Como foi gerado',
    '  Para cada semente: Features com data final no fim do mês anterior ao 1º mês → Treino → Previsão de cada mês',
    '  (com retreino a cada N meses, quando escolhido; ver origens.json) → variantes do Ensemble (opcional).',
    '  Depois: Features com todos os dados → rótulos reais → métricas (pipeline/science/metricas.py).',
    '  Semanas avaliadas: as 4 a partir da 1ª segunda-feira de cada mês.',
    '',
    'Arquivos',
    ...[...usados].sort().map((f) => `  ${f}: ${DESCR[f] || 'arquivo do replay'}`),
    '  execucoes/: registro da sequência e manifesto de cada execução (entradas e saídas com sha256, versões dos pacotes, placa de vídeo).',
    '  overrides.json: parâmetros enviados ao pipeline em cada execução e o que estava diferente do padrão da dissertação.',
    '  parametros.json: escolhas das telas (Limpeza, Filtragem, Features, Treino, Mapa de risco).',
    ...(conjuntosCopiados.length ? [`  conjuntos_poi/<id>/manifesto.json: origem, data, consulta ou arquivo (sha256), contagens e hash de cada conjunto de pontos de interesse usado (${conjuntosCopiados.join(', ')}).`] : []),
    '  versao.json: versão do código.',
    '',
    'Fora do pacote (grandes): as previsões célula a célula (processed/replay_seeds/seed_<n>/results_*.csv) e os',
    'rótulos (processed/replay_seeds/labels_replay.csv) ficam na pasta de trabalho.',
  ];
  fs.writeFileSync(path.join(dir, 'LEIAME.txt'), linhas.join('\r\n') + '\r\n', 'utf8'); n++;

  const zipJs = path.join(repoRoot, 'server', 'lib', 'zip.js');
  const { zipDir } = await import(pathToFileURL(zipJs).href);
  const arquivo = `${dir}.zip`;
  zipDir(dir, arquivo, { prefix: path.basename(dir) });
  return { arquivo, pasta: dir, n };
}

module.exports = { exportar, versaoCodigo };
