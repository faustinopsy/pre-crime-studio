// Hiperparâmetros dos modelos que o operador pode mudar na tela Treino.
//
// Os valores recomendados são os de pipeline/config.py (ML_CONFIG), usados na dissertação.
// O que o operador muda fica em <pasta de trabalho>/parametros.json → "modelos" e vai para o
// pipeline como override (ML_CONFIG) só no Treino, e só com as chaves diferentes do
// recomendado: sem mudança, o treino roda exatamente como antes.
// Cada treino grava processed/models/params_<modelo>_<área>.json com os valores usados, e a
// Previsão monta a LSTM e o Transformer com esses valores (pipeline/train/params_io.py).
const fs = require('fs');
const path = require('path');

// tipo: int | float | choice | intOrNone (inteiro ou "sem limite")
// grupo: arquitetura (muda o formato do modelo) | treino (muda só como ele aprende)
// custo: o que acontece com o tempo/memória quando o valor sobe
const SCHEMA = {
  RF: {
    nome: 'Random Forest',
    resumo: 'Várias árvores de decisão votam se a célula terá crime nas próximas 4 semanas. Roda no processador.',
    fixos: 'Classes balanceadas (class_weight = "balanced"), semente da pesquisa, todos os núcleos do processador.',
    params: [
      { k: 'n_estimators', label: 'Número de árvores', tipo: 'int', min: 10, max: 2000, step: 10, grupo: 'arquitetura',
        faz: 'Quantas árvores votam. A probabilidade final é a proporção de votos.',
        mais: 'probabilidades mais estáveis e menos empates; o ganho diminui depois de algumas centenas.',
        menos: 'treino e previsão mais rápidos, resultado mais "ruidoso".',
        custo: 'Tempo e tamanho do arquivo do modelo crescem na mesma proporção.' },
      { k: 'max_depth', label: 'Profundidade máxima', tipo: 'intOrNone', min: 2, max: 200, step: 1, grupo: 'arquitetura',
        faz: 'Quantas perguntas seguidas cada árvore pode fazer sobre o histórico da célula.',
        mais: 'aprende padrões mais finos, mas pode decorar o passado (sobreajuste). "Sem limite" cresce até separar tudo.',
        menos: 'regras mais gerais e robustas, mas pode deixar de ver padrões reais.',
        custo: 'Árvores mais fundas ocupam mais memória e disco.' },
      { k: 'min_samples_split', label: 'Mínimo de linhas para dividir', tipo: 'int', min: 2, max: 1000, step: 1, grupo: 'treino',
        faz: 'Um ramo só faz uma nova pergunta se tiver pelo menos este número de semanas-célula.',
        mais: 'árvores mais simples, menos sobreajuste.',
        menos: 'árvores mais detalhadas.',
        custo: 'Valores maiores deixam o treino um pouco mais rápido.' },
      { k: 'min_samples_leaf', label: 'Mínimo de linhas por folha', tipo: 'int', min: 1, max: 1000, step: 1, grupo: 'treino',
        faz: 'Cada resposta final da árvore precisa reunir pelo menos este número de semanas-célula.',
        mais: 'probabilidades mais suaves (menos 0 e 1 "secos"), menos empates entre células.',
        menos: 'respostas mais específicas, risco de sobreajuste.',
        custo: 'Valores maiores deixam o modelo menor e mais rápido.' },
    ],
  },
  LSTM: {
    nome: 'LSTM',
    resumo: 'Rede neural que lê as 24 semanas da célula em ordem e guarda uma memória do que viu. Usa a placa de vídeo se houver.',
    fixos: 'Otimizador Adam, perda BCE com peso dos positivos, semente da pesquisa, normalização MinMax.',
    params: [
      { k: 'hidden_dim', label: 'Tamanho da memória', tipo: 'int', min: 8, max: 512, step: 8, grupo: 'arquitetura',
        faz: 'Quantos números a rede usa para guardar o que aprendeu das semanas anteriores.',
        mais: 'capta padrões mais complexos, mas precisa de mais dados e pode sobreajustar.',
        menos: 'modelo menor e mais rápido, mais simples.',
        custo: 'Tempo e memória da placa de vídeo crescem rápido (≈ ao quadrado).' },
      { k: 'layer_dim', label: 'Camadas empilhadas', tipo: 'int', min: 1, max: 4, step: 1, grupo: 'arquitetura',
        faz: 'Quantas LSTMs em sequência; cada uma lê a saída da anterior.',
        mais: 'pode representar padrões em vários níveis; mais difícil de treinar.',
        menos: 'mais simples e estável. 1 camada costuma bastar para 24 semanas.',
        custo: 'Cada camada a mais soma o custo de uma LSTM inteira.' },
      { k: 'dropout_prob', label: 'Dropout', tipo: 'float', min: 0, max: 0.8, step: 0.05, grupo: 'treino',
        faz: 'Durante o treino, desliga ao acaso esta fração dos neurônios para a rede não depender de poucos sinais.',
        mais: 'menos sobreajuste, aprendizado mais lento.',
        menos: 'aprende mais rápido, mas pode decorar o passado.',
        custo: 'Não muda o tempo.' },
      { k: 'learning_rate', label: 'Taxa de aprendizado', tipo: 'float', min: 0.00001, max: 0.1, step: 0.0001, grupo: 'treino',
        faz: 'O tamanho do passo de cada ajuste dos pesos.',
        mais: 'aprende mais rápido, mas pode oscilar e não convergir.',
        menos: 'mais estável, mas precisa de mais épocas.',
        custo: 'Não muda o tempo por época.' },
      { k: 'epochs', label: 'Épocas', tipo: 'int', min: 1, max: 200, step: 1, grupo: 'treino',
        faz: 'Quantas vezes a rede passa por todo o histórico da área.',
        mais: 'mais aprendizado, até começar a decorar o passado.',
        menos: 'treino mais curto; poucas épocas podem deixar a rede "crua".',
        custo: 'O tempo do treino é proporcional.' },
      { k: 'batch_size', label: 'Tamanho do lote', tipo: 'choice', opcoes: [128, 256, 512, 1024, 2048, 4096, 8192], grupo: 'treino',
        faz: 'Quantas semanas-célula a rede vê antes de cada ajuste dos pesos.',
        mais: 'treino mais rápido na placa de vídeo, ajustes mais suaves.',
        menos: 'ajustes mais frequentes e ruidosos; usa menos memória.',
        custo: 'Lotes grandes pedem mais memória da placa de vídeo.' },
      { k: 'pos_weight', label: 'Peso dos positivos', tipo: 'float', min: 1, max: 100, step: 0.5, grupo: 'treino',
        faz: 'Quanto vale errar uma semana com crime em relação a errar uma sem crime. Crimes são raros, então eles pesam mais.',
        mais: 'a rede marca mais células como risco (mais acertos, mais alarmes falsos).',
        menos: 'mais conservadora (menos alarmes falsos, pode perder crimes).',
        custo: 'Não muda o tempo.' },
    ],
  },
  Transformer: {
    nome: 'Transformer',
    resumo: 'Rede neural com atenção: cada semana "olha" para todas as outras e pesa as mais parecidas. Usa a placa de vídeo se houver.',
    fixos: 'Otimizador Adam, perda BCE com peso dos positivos, semente da pesquisa, normalização MinMax.',
    params: [
      { k: 'embed_dim', label: 'Tamanho do embedding', tipo: 'int', min: 8, max: 256, step: 8, grupo: 'arquitetura',
        faz: 'Cada semana vira um vetor com este número de valores antes da atenção.',
        mais: 'representa mais detalhes de cada semana; precisa de mais dados.',
        menos: 'modelo menor e mais rápido.',
        custo: 'Precisa ser divisível pelo número de cabeças de atenção.' },
      { k: 'num_heads', label: 'Cabeças de atenção', tipo: 'choice', opcoes: [1, 2, 4, 8], grupo: 'arquitetura',
        faz: 'Quantos "olhares" independentes a atenção faz sobre as 24 semanas (ex.: um para sazonalidade, outro para picos).',
        mais: 'mais tipos de relação entre semanas.',
        menos: 'mais simples.',
        custo: 'O embedding precisa ser divisível por este número.' },
      { k: 'ff_dim', label: 'Camada feed-forward', tipo: 'int', min: 8, max: 1024, step: 8, grupo: 'arquitetura',
        faz: 'Tamanho da camada que refina cada semana depois da atenção.',
        mais: 'mais capacidade; mais lento.',
        menos: 'mais rápido e simples.',
        custo: 'Tempo e memória crescem na mesma proporção.' },
      { k: 'num_layers', label: 'Camadas', tipo: 'int', min: 1, max: 6, step: 1, grupo: 'arquitetura',
        faz: 'Quantos blocos de atenção + feed-forward em sequência.',
        mais: 'relações mais profundas; mais difícil de treinar.',
        menos: 'mais estável.',
        custo: 'Cada camada a mais soma o custo de um bloco inteiro.' },
      { k: 'dropout_prob', label: 'Dropout', tipo: 'float', min: 0, max: 0.8, step: 0.05, grupo: 'treino',
        faz: 'Durante o treino, desliga ao acaso esta fração dos neurônios para a rede não depender de poucos sinais.',
        mais: 'menos sobreajuste, aprendizado mais lento.',
        menos: 'aprende mais rápido, mas pode decorar o passado.',
        custo: 'Não muda o tempo.' },
      { k: 'learning_rate', label: 'Taxa de aprendizado', tipo: 'float', min: 0.00001, max: 0.1, step: 0.0001, grupo: 'treino',
        faz: 'O tamanho do passo de cada ajuste dos pesos.',
        mais: 'aprende mais rápido, mas pode oscilar e não convergir.',
        menos: 'mais estável, mas precisa de mais épocas.',
        custo: 'Não muda o tempo por época.' },
      { k: 'epochs', label: 'Épocas', tipo: 'int', min: 1, max: 200, step: 1, grupo: 'treino',
        faz: 'Quantas vezes a rede passa por todo o histórico da área.',
        mais: 'mais aprendizado, até começar a decorar o passado.',
        menos: 'treino mais curto; poucas épocas podem deixar a rede "crua".',
        custo: 'O tempo do treino é proporcional.' },
      { k: 'batch_size', label: 'Tamanho do lote', tipo: 'choice', opcoes: [128, 256, 512, 1024, 2048, 4096, 8192], grupo: 'treino',
        faz: 'Quantas semanas-célula a rede vê antes de cada ajuste dos pesos.',
        mais: 'treino mais rápido na placa de vídeo, ajustes mais suaves.',
        menos: 'ajustes mais frequentes e ruidosos; usa menos memória.',
        custo: 'Lotes grandes pedem mais memória da placa de vídeo.' },
      { k: 'pos_weight', label: 'Peso dos positivos', tipo: 'float', min: 1, max: 100, step: 0.5, grupo: 'treino',
        faz: 'Quanto vale errar uma semana com crime em relação a errar uma sem crime. Crimes são raros, então eles pesam mais.',
        mais: 'a rede marca mais células como risco (mais acertos, mais alarmes falsos).',
        menos: 'mais conservadora (menos alarmes falsos, pode perder crimes).',
        custo: 'Não muda o tempo.' },
    ],
  },
};

// Os valores da dissertação (pipeline/padroes_dissertacao.json → ML_CONFIG, o mesmo de config.py).
const RECOMENDADOS = (() => {
  const ml = require('./padroes').padroes().ML_CONFIG;
  return Object.fromEntries(Object.entries(SCHEMA).map(([m, sc]) => [m, Object.fromEntries(sc.params.map((p) => [p.k, ml[m][p.k] ?? null]))]));
})();
const MODELOS = Object.keys(SCHEMA);
const FILE_PREFIX = { RF: 'rf', LSTM: 'lstm', Transformer: 'transformer' };

const paramsFile = (ws) => path.join(ws, 'parametros.json');
function readAll(ws) { try { return JSON.parse(fs.readFileSync(paramsFile(ws), 'utf8')); } catch { return {}; } }
function writeAll(ws, all) { fs.writeFileSync(paramsFile(ws), JSON.stringify(all, null, 2), 'utf8'); }

/** Recomendados desta pasta: o RF usa os otimizados (processed/best_params.json) quando existem. */
function recomendados(ws) {
  const rec = JSON.parse(JSON.stringify(RECOMENDADOS));
  let otimizados = null;
  try {
    const best = JSON.parse(fs.readFileSync(path.join(ws, 'processed', 'best_params.json'), 'utf8'));
    if (best?.RF) {
      otimizados = {};
      for (const p of SCHEMA.RF.params) if (p.k in best.RF) { rec.RF[p.k] = best.RF[p.k]; otimizados[p.k] = best.RF[p.k]; }
    }
  } catch { /* sem otimização */ }
  return { rec, otimizados };
}

const same = (a, b) => (a === null || b === null ? a === b : Number(a) === Number(b));

/** Valida um valor; devolve [valor normalizado, erro]. */
function check(p, v) {
  if (p.tipo === 'intOrNone' && (v === null || v === '' || v === 'none')) return [null, null];
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n)) return [null, 'Informe um número.'];
  if (p.tipo === 'choice') return p.opcoes.includes(n) ? [n, null] : [null, `Escolha um de: ${p.opcoes.join(', ')}.`];
  if ((p.tipo === 'int' || p.tipo === 'intOrNone') && !Number.isInteger(n)) return [null, 'Use um número inteiro.'];
  if (n < p.min || n > p.max) return [null, `Use um valor entre ${String(p.min).replace('.', ',')} e ${String(p.max).replace('.', ',')}.`];
  return [n, null];
}

/** Regras entre parâmetros do mesmo modelo. */
function crossCheck(modelo, v) {
  if (modelo === 'Transformer' && v.embed_dim % v.num_heads) return { embed_dim: `O embedding (${v.embed_dim}) precisa ser divisível pelas cabeças de atenção (${v.num_heads}).` };
  return {};
}

/** Valores atuais (recomendados + o que o operador mudou). */
function current(ws) {
  const { rec } = recomendados(ws);
  const saved = readAll(ws).modelos || {};
  const out = {};
  for (const m of MODELOS) {
    out[m] = { ...rec[m] };
    for (const p of SCHEMA[m].params) {
      if (!(p.k in (saved[m] || {}))) continue;
      const [v, err] = check(p, saved[m][p.k]);
      if (!err) out[m][p.k] = v;
    }
    if (Object.keys(crossCheck(m, out[m])).length) out[m] = { ...rec[m] };
  }
  return out;
}

/** Só o que difere do recomendado, por modelo (vazio = recomendados). */
function changed(ws) {
  const { rec } = recomendados(ws);
  const cur = current(ws);
  const out = {};
  for (const m of MODELOS) {
    const d = {};
    for (const p of SCHEMA[m].params) if (!same(cur[m][p.k], rec[m][p.k])) d[p.k] = cur[m][p.k];
    if (Object.keys(d).length) out[m] = d;
  }
  return out;
}

// Semente do treino (GLOBAL_SEED). Padrão da dissertação: 42.
const SEED_PADRAO = require('./padroes').padroes().GLOBAL_SEED;
function seed(ws) {
  const s = readAll(ws).treino?.semente;
  return Number.isInteger(s) && s >= 0 ? s : SEED_PADRAO;
}
function setSeed(ws, v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new Error('A semente precisa ser um número inteiro de 0 a 2147483647.');
  const all = readAll(ws);
  all.treino = { ...(all.treino || {}), semente: n };
  if (n === SEED_PADRAO) delete all.treino.semente;
  if (!Object.keys(all.treino).length) delete all.treino;
  all.modelosAtualizadoEm = new Date().toISOString();
  writeAll(ws, all);
  return view(ws);
}

/** Override para o pipeline (só no Treino). {} quando tudo está no padrão da dissertação. */
function overrides(ws) {
  const ch = changed(ws);
  const o = Object.keys(ch).length ? { ML_CONFIG: ch } : {};
  const s = seed(ws);
  if (s !== SEED_PADRAO) o.GLOBAL_SEED = s;
  return o;
}

/** Parâmetros com que cada modelo de cada área foi treinado (params_<m>_<área>.json). */
function trained(ws) {
  const dir = path.join(ws, 'processed', 'models');
  const out = {};
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    const m = f.match(/^params_(rf|lstm|transformer)_(area_\d+)\.json$/);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out[`${m[1]}_${m[2]}`] = { parametros: j.parametros || {}, seed: j.seed ?? null, dataEnd: j.data_end || null, em: j.treinado_em || null };
    } catch { /* arquivo corrompido: tratado como sem registro */ }
  }
  return out;
}

function view(ws) {
  const { rec, otimizados } = recomendados(ws);
  return { schema: SCHEMA, recomendados: rec, otimizados, valores: current(ws), mudados: changed(ws), treinados: trained(ws), prefixo: FILE_PREFIX,
    semente: { valor: seed(ws), padrao: SEED_PADRAO } };
}

/** Grava os valores de um modelo. Lança erro (com .campos) quando algum valor é inválido. */
function set(ws, modelo, valores) {
  if (!SCHEMA[modelo]) throw new Error('Modelo desconhecido.');
  const { rec } = recomendados(ws);
  const cur = current(ws)[modelo];
  const next = { ...cur };
  const erros = {};
  for (const p of SCHEMA[modelo].params) {
    if (!(p.k in (valores || {}))) continue;
    const [v, err] = check(p, valores[p.k]);
    if (err) erros[p.k] = err; else next[p.k] = v;
  }
  Object.assign(erros, Object.keys(erros).length ? {} : crossCheck(modelo, next));
  if (Object.keys(erros).length) throw Object.assign(new Error(Object.values(erros)[0]), { campos: erros });
  const all = readAll(ws);
  all.modelos = all.modelos || {};
  const diff = {};
  for (const p of SCHEMA[modelo].params) if (!same(next[p.k], rec[modelo][p.k])) diff[p.k] = next[p.k];
  if (Object.keys(diff).length) all.modelos[modelo] = diff; else delete all.modelos[modelo];
  all.modelosAtualizadoEm = new Date().toISOString();
  writeAll(ws, all);
  return view(ws);
}

function reset(ws, modelo) {
  const all = readAll(ws);
  if (all.modelos) { if (modelo) delete all.modelos[modelo]; else delete all.modelos; }
  if (!modelo) delete all.treino;   // "restaurar todos" também volta a semente
  all.modelosAtualizadoEm = new Date().toISOString();
  writeAll(ws, all);
  return view(ws);
}

module.exports = { SCHEMA, RECOMENDADOS, view, set, reset, overrides, changed, current, seed, setSeed, SEED_PADRAO };
