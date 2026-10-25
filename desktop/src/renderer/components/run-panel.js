// Painel de execução de uma fase: andamento ao vivo, log, cancelar, resultado (também o
// da última execução, ao abrir a tela) e execuções anteriores com "Verificar", que
// confere o sha256 dos arquivos gerados.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { confirmar } from '../lib/dialog.js';
import { icon } from '../lib/icons.js';
import { esc, toast, fmtDate } from '../lib/dom.js';

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
export const fmtSecs = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
};
// nome da área: o que o operador deu (áreas criadas por GeoJSON) ou "Área 01" (as 8 da dissertação)
export const areaLabel = (a) => (a ? (store.get().ws?.areaNames?.[a] || a.replace(/^area_/, 'Área ')) : 'Todas as áreas');
const dmy = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
/** "2026-10-12_015650_train" → data (execuções interrompidas não têm manifesto) */
const runIdDate = (id) => { const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(id || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
const sumOf = (areas, k) => Object.values(areas || {}).reduce((s, m) => s + (Number(m[k]) || 0), 0);

/** Tabela por área: cols = [[chave, título, formatador?]] */
function areaTable(areas, cols, foot) {
  const names = Object.keys(areas || {}).sort();
  if (!names.length) return '';
  const fmt = (c, v) => (c[2] ? c[2](v) : v == null ? '—' : nf(v));
  return `<div class="tbl-wrap"><table class="tbl run-areas"><thead><tr><th>Área</th>${cols.map((c) => `<th class="r">${esc(c[1])}</th>`).join('')}</tr></thead>
    <tbody>${names.map((a) => `<tr><td><b>${esc(areaLabel(a))}</b></td>${cols.map((c) => `<td class="r num">${esc(fmt(c, areas[a][c[0]]))}</td>`).join('')}</tr>`).join('')}</tbody>
    ${foot && names.length > 1 ? `<tfoot><tr><td>Total</td>${cols.map((c) => `<td class="r num">${c[3] === false ? '' : nf(sumOf(areas, c[0]))}</td>`).join('')}</tr></tfoot>` : ''}</table></div>`;
}

// O que mostrar de cada fase
const JOBS = {
  clean: {
    describe(p) {
      if (!p) return 'Preparando…';
      if (p.etapa === 'lendo') return `Lendo ${p.arquivo} (${p.done + 1} de ${p.total})`;
      if (p.etapa === 'lido') return `Lida ${p.arquivo} (${p.done} de ${p.total})`;
      return { juntando: 'Juntando as planilhas', repetidos: 'Tirando datas inválidas, sem localização e repetidos', salvando: 'Gravando a base unificada' }[p.etapa] || 'Processando…';
    },
    fraction(p) {
      if (!p || !p.total) return 0.02;
      if (p.etapa === 'lendo' || p.etapa === 'lido') return 0.02 + (p.done / p.total) * 0.83;
      return { juntando: 0.87, repetidos: 0.92, salvando: 0.96 }[p.etapa] ?? 0.85;
    },
    metricsHtml(m) {
      const rows = [
        ['funil_lidos', 'Linhas nas planilhas'], ['funil_cidade', 'Nas cidades escolhidas'],
        ['funil_ocorrencia', 'Do tipo de ocorrência escolhido'], ['funil_veiculo', 'Dos tipos de veículo escolhidos'],
        ['funil_data_valida', 'Com data válida'], ['funil_coordenadas', 'Com localização'],
        ['funil_final', 'Na base unificada (sem repetidos)'],
      ].filter(([k]) => m[k] != null);
      return rows.length ? `<table class="tbl run-metrics"><tbody>${rows.map(([k, l]) => `<tr><td>${esc(l)}</td><td class="r num"><b>${nf(m[k])}</b></td></tr>`).join('')}</tbody></table>` : '';
    },
    doneText: (m) => (m.metrics?.funil_final != null ? `${nf(m.metrics.funil_final)} registros na base unificada` : 'Base unificada gravada'),
    cancelText: 'Cancelada. A base unificada anterior não foi alterada.',
  },

  filter: {
    describe(p) {
      if (!p) return 'Preparando…';
      if (p.etapa === 'malha') return `Recortando a malha pelas ruas: ${areaLabel(p.area)} (${p.done + 1} de ${p.total})`;
      if (p.etapa === 'carregando') return 'Carregando a base unificada';
      if (p.etapa === 'crimes') return `Colocando cada crime na sua célula: ${areaLabel(p.area)} (${p.done + 1} de ${p.total})`;
      return 'Processando…';
    },
    fraction(p) {
      if (!p || !p.total) return 0.02;
      if (p.etapa === 'malha') return 0.02 + (p.done / p.total) * 0.45;
      if (p.etapa === 'carregando') return 0.5;
      if (p.etapa === 'crimes') return 0.52 + (p.done / p.total) * 0.46;
      return 0.5;
    },
    metricsHtml(m) {
      const t = areaTable(m.areas, [
        ['grids_malha', 'Linhas da malha'], ['celulas_unicas', 'Células únicas'], ['grids_com_rua', 'Células com rua'],
        ['registros_na_area', 'Registros na área'], ['crimes_mapeados', 'Crimes nas células'], ['grids_com_crime', 'Células com crime'],
      ], true);
      const dup = Object.entries(m.areas || {}).filter(([, a]) => a.crimes_mapeados > (a.registros_na_area || 0) * 1.02);
      const warn = dup.length ? `<div class="callout" data-tone="warn">${icon('warn')}<div><b>Crimes contados mais de uma vez</b> em ${dup.length} área(s):
        ${nf(sumOf(Object.fromEntries(dup), 'crimes_mapeados'))} crimes nas células para ${nf(sumOf(Object.fromEntries(dup), 'registros_na_area'))} registros.
        A malha tem células repetidas. Marque "Juntar as células repetidas da malha" e rode de novo.</div></div>` : '';
      return t + warn;
    },
    doneText: (m) => {
      const a = m.metrics?.areas || {};
      const n = Object.keys(a).length;
      return n ? `${n} área(s): ${nf(sumOf(a, 'crimes_mapeados'))} crimes em ${nf(sumOf(a, 'grids_com_crime'))} células` : 'Crimes colocados nas células';
    },
    cancelText: 'Cancelada. As áreas que já tinham terminado foram gravadas; rode de novo para completar.',
  },

  features: {
    describe(p) {
      if (!p) return 'Preparando…';
      const etapa = { lendo: 'lendo os crimes', matriz: 'montando o histórico semanal', juntando: 'juntando lags, médias e vizinhos', gravando: 'gravando o dataset' }[p.etapa] || 'processando';
      return `${areaLabel(p.area)} (${p.done + 1} de ${p.total}): ${etapa}`;
    },
    fraction(p) {
      if (!p || !p.total) return 0.02;
      const sub = { lendo: 0.05, matriz: 0.2, juntando: 0.7, gravando: 0.85 }[p.etapa] ?? 0.5;
      return Math.min(0.98, (p.done + sub) / p.total);
    },
    metricsHtml(m) {
      return areaTable(m.areas, [
        ['celulas', 'Células'], ['semanas', 'Semanas'],
        ['primeira_semana', 'De', dmy, false], ['ultima_semana', 'Até', dmy, false],
        ['linhas', 'Linhas'], ['crimes_futuros', 'Crimes a prever'],
      ], true);
    },
    doneText: (m) => {
      const a = m.metrics?.areas || {};
      const n = Object.keys(a).length;
      return n ? `${n} dataset(s): ${nf(sumOf(a, 'linhas'))} linhas` : 'Datasets gravados';
    },
    cancelText: 'Cancelada. Os datasets das áreas que já tinham terminado foram gravados; rode de novo para completar.',
  },
};

// ── Treino: matriz modelo × área ───────────────────────────────────────────────
const MODEL_ORDER = ['RF', 'LSTM', 'Transformer'];
const MODEL_LABEL = { RF: 'Random Forest', LSTM: 'LSTM', Transformer: 'Transformer' };
function trainCells(m) {
  const plan = m.plan || {};
  const models = plan.modelos || MODEL_ORDER;
  const areas = plan.areas || [...new Set(Object.values(m.train || {}).map((x) => x.area))].sort();
  return { models, areas };
}
function sparkline(vals, color = 'var(--accent)') {
  if (!vals || vals.length < 2) return '';
  const w = 90, h = 22, mx = Math.max(...vals), mn = Math.min(...vals), r = mx - mn || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - mn) / r) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}
JOBS.train = {
  describe(_p, live) {
    const act = Object.entries(live?.metrics?.active || {}).filter(([, a]) => a && !a.done);
    if (!act.length) return 'Carregando os datasets…';
    return act.map(([mod, a]) => `${mod} · ${areaLabel(a.area)}${a.epoch ? ` · época ${a.epoch} de ${a.epochs}` : a.fase === 'final' ? ' · modelo final' : a.fase ? ` · ${a.fase}` : ''}`).join('   |   ');
  },
  fraction(_p, live) {
    const m = live?.metrics || {};
    const { models, areas } = trainCells(m);
    const total = Math.max(1, models.length * Math.max(1, areas.length));
    let done = Object.keys(m.train || {}).length;
    for (const a of Object.values(m.active || {})) {
      if (a && !a.done && a.epochs) done += clamp01(((a.epoch - 1) + (a.batch || 0) / Math.max(1, a.nb || 1)) / a.epochs) * 0.95;
    }
    return Math.max(0.02, Math.min(0.99, done / total));
  },
  metricsHtml(m) {
    const { models, areas } = trainCells(m);
    if (!areas.length) return '';
    const cell = (mod, area) => {
      const done = (m.train || {})[`${mod}|${area}`];
      const act = (m.active || {})[mod];
      const curve = (m.curves || {})[`${mod}|${area}`];
      if (done) return `<span class="tc done">${icon('check')} ${fmtSecs(done.secs || 0)}</span>${curve?.loss?.length > 1 ? sparkline(curve.loss) : ''}`;
      if (act && !act.done && act.area === area) {
        const pct = act.epochs ? Math.round((((act.epoch - 1) + (act.batch || 0) / Math.max(1, act.nb || 1)) / act.epochs) * 100) : null;
        return `<span class="tc run"><i class="spin"></i>${act.epochs ? `época ${act.epoch}/${act.epochs}` : act.fase === 'final' ? 'modelo final' : esc(act.fase || 'treinando')}</span>
          ${pct != null ? `<span class="mini"><i style="width:${pct}%"></i></span>` : ''}${curve?.loss?.length > 1 ? sparkline(curve.loss) : ''}`;
      }
      return '<span class="tc muted">—</span>';
    };
    const plan = m.plan || {};
    return `<div class="tbl-wrap"><table class="tbl train-matrix"><thead><tr><th>Área</th>${models.map((x) => `<th>${esc(MODEL_LABEL[x] || x)}</th>`).join('')}</tr></thead>
      <tbody>${areas.map((a) => `<tr><td><b>${esc(areaLabel(a))}</b></td>${models.map((x) => `<td>${cell(x, a)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${plan.modo ? `<p class="note">${plan.fast ? 'Treino rápido (só o modelo final)' : 'Treino completo (com validação cruzada temporal)'} · ${plan.modo === 'paralelo' ? 'modelos em paralelo' : 'um modelo por vez'}. A linha ao lado de cada modelo é a perda por época: descendo, o modelo está aprendendo.</p>` : ''}`;
  },
  doneText: (m) => {
    const n = Object.keys(m.metrics?.train || {}).length;
    const areas = new Set(Object.values(m.metrics?.train || {}).map((x) => x.area)).size;
    return n ? `${n} modelo(s) treinado(s) em ${areas} área(s)` : 'Modelos gravados';
  },
  cancelText: 'Cancelada. Os modelos que já tinham terminado foram gravados; os outros continuam como estavam.',
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ── Previsão e Validação ───────────────────────────────────────────────────────
export const monthLabel = (mes) => (mes ? mes.replace('_', '-').split('-').reverse().join('/') : '');
export const MODO = {
  cega: ['Mês futuro', 'done', 'Usa a última semana conhecida: é um teste cego.'],
  replay: ['Replay', 'done', 'Dataset cortado na data final: o modelo não viu o mês. Teste cego.'],
  retroativa: ['Retroativa', 'stale', 'O mês já estava nos dados de treino: o acerto medido fica otimista.'],
  desconhecido: ['Sem registro', 'pending', 'Previsão feita fora do app: não há registro de como foi gerada.'],
};
export const modoPill = (m) => { const [l, st, t] = MODO[m] || MODO.desconhecido; return `<span class="pill" data-status="${st}" title="${esc(t)}">${esc(l)}</span>`; };
const pct = (v) => (v == null ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);
const dec = (v, d = 2) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const fmtPct = pct; export const fmtDec = dec;
function stepFrac(p) {
  if (!p || !p.total) return 0.02;
  const sub = p.subtotal ? (p.sub || 0) / p.subtotal : 0.5;
  return Math.max(0.02, Math.min(0.98, (p.done + sub) / p.total));
}
function skippedHtml(areas) {
  const sk = Object.entries(areas || {}).filter(([, a]) => a.pulada);
  return sk.length ? `<div class="callout" data-tone="warn">${icon('warn')}<div><b>Área(s) pulada(s):</b>
    ${sk.map(([a, x]) => `${esc(areaLabel(a))}: ${esc(x.pulada)}`).join('<br>')}</div></div>` : '';
}
JOBS.predict = {
  describe(p, live) {
    if (!p) return `Carregando os modelos${live?.metrics?.plan?.mes ? ` para ${monthLabel(live.metrics.plan.mes)}` : ''}…`;
    const etapa = { modelos: `previsão do ${p.modelo || 'modelo'}`, ensemble: 'juntando os modelos no Ensemble', mapa: 'gerando o mapa de risco', historico: 'histórico das células' }[p.etapa] || 'processando';
    return `${areaLabel(p.area)} (${p.done + 1} de ${p.total}): ${etapa}`;
  },
  fraction: stepFrac,
  metricsHtml(m) {
    const areas = Object.fromEntries(Object.entries(m.areas || {}).filter(([, a]) => !a.pulada));
    const t = areaTable(areas, [
      ['modo', 'Tipo', (v) => (MODO[v] || MODO.desconhecido)[0], false], ['ultima_semana', 'Último dado', dmy, false],
      ['celulas', 'Células'], ['celulas_ativas', 'Com risco'], ['hotspots', 'Zona vermelha'],
      ['modelos', 'Modelos', (v) => (Array.isArray(v) ? v.length + 1 : '—') + (Array.isArray(v) ? ' (com Ensemble)' : ''), false],
    ], true);
    const retro = Object.values(areas).some((a) => a.modo === 'retroativa');
    return (m.plan?.mes ? `<p class="note">Mês previsto: <b>${esc(monthLabel(m.plan.mes))}</b> · ${m.plan.semanas || 4} semanas a partir de ${esc(dmy(m.plan.inicio))}.</p>` : '') + t
      + (retro ? `<div class="callout" data-tone="warn">${icon('warn')}<div>${esc(MODO.retroativa[2])} Para um teste honesto, preveja um mês depois do último dado do dataset (ou use a data final em Features).</div></div>` : '')
      + skippedHtml(m.areas);
  },
  doneText: (m) => {
    const a = Object.values(m.metrics?.areas || {}).filter((x) => !x.pulada && x.celulas != null);
    const mes = m.metrics?.plan?.mes || m.options?.mes;
    return `Previsão${mes ? ` de ${monthLabel(mes)}` : ''}: ${a.length} área(s), ${nf(a.reduce((s, x) => s + (x.hotspots || 0), 0))} células na zona vermelha`;
  },
  cancelText: 'Cancelada. As áreas que já tinham terminado ficaram gravadas.',
};
JOBS.validate = {
  describe(p, live) {
    if (!p) return `Conferindo os dados reais${live?.metrics?.plan?.mes ? ` de ${monthLabel(live.metrics.plan.mes)}` : ''}…`;
    const etapa = { gabarito: 'separando os crimes reais do mês', metricas: 'calculando acerto e PAI', zhang: 'métricas de Zhang' }[p.etapa] || 'processando';
    return `${areaLabel(p.area)} (${p.done + 1} de ${p.total}): ${etapa}`;
  },
  fraction: stepFrac,
  metricsHtml(m) {
    const names = Object.keys(m.areas || {}).filter((a) => m.areas[a].resultado).sort();
    const models = ['Ensemble', 'RF', 'LSTM', 'Transformer'].filter((x) => names.some((a) => m.areas[a].resultado[x]));
    const t = names.length ? `<div class="tbl-wrap"><table class="tbl val-mini"><thead><tr><th>Área</th><th>Tipo</th><th class="r" title="Ocorrências do mês dentro das células da área (pontos pretos no mapa)">Ocorrências no mês</th>
        ${models.map((x) => `<th class="r">${esc(x === 'RF' ? 'Random Forest' : x)}<br><span class="muted">acerto · PAI</span></th>`).join('')}</tr></thead>
      <tbody>${names.map((a) => { const A = m.areas[a]; return `<tr><td><b>${esc(areaLabel(a))}</b></td><td>${modoPill(A.modo)}</td><td class="r num">${nf(A.crimes_reais)}</td>
        ${models.map((x) => { const r = A.resultado[x]; return `<td class="r num">${r ? `<b>${pct(r.foco)}</b> · ${dec(r.pai, 1)}` : '—'}</td>`; }).join('')}</tr>`; }).join('')}</tbody></table></div>
      <p class="note">Acerto = crimes do mês que caíram na zona vermelha. PAI = quantas vezes melhor que escolher células ao acaso (1 = igual ao acaso).</p>` : '';
    return t + skippedHtml(m.areas);
  },
  doneText: (m) => {
    const n = Object.values(m.metrics?.areas || {}).filter((x) => x.resultado).length;
    const mes = m.metrics?.plan?.mes || m.options?.mes;
    return `Validação${mes ? ` de ${monthLabel(mes)}` : ''}: ${n} área(s)`;
  },
  cancelText: 'Cancelada. As métricas das áreas que já tinham terminado foram gravadas.',
};

// Áreas de estudo do operador: grade e OpenStreetMap
JOBS.areas = {
  describe(p, live) {
    const plan = live?.metrics?.plan || {};
    if (!p) return plan.acao === 'osm' ? 'Conectando ao OpenStreetMap…' : 'Lendo o arquivo das áreas…';
    const i = (plan.areas || []).indexOf(p.area);
    const nome = (i >= 0 && plan.nomes?.[i]) || areaLabel(p.area);
    const etapa = { grade: 'gerando a grade de células', ruas: 'baixando as ruas do OpenStreetMap', 'pontos de interesse': 'baixando os pontos de interesse' }[p.etapa] || 'processando';
    return p.total ? `${nome} (${Math.min(p.done + 1, p.total)} de ${p.total}): ${etapa}` : 'Concluindo…';
  },
  fraction(p) {
    if (!p || !p.total) return 0.03;
    const sub = { grade: 0.1, ruas: 0.4, 'pontos de interesse': 0.75 }[p.etapa] ?? 0.9;
    return Math.min(0.98, (p.done + sub) / p.total);
  },
  metricsHtml(m) {
    const rows = Object.entries(m.areas || {}).filter(([, a]) => a.criada).map(([k, a]) => a.criada);
    if (!rows.length) return '';
    return `<div class="tbl-wrap"><table class="tbl run-areas"><thead><tr><th>Área</th><th>Identificador</th><th class="r">Células</th><th>Ruas</th><th>Pontos de interesse</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><b>${esc(r.nome)}</b></td><td class="mono">${esc(r.area)}</td><td class="r num">${nf(r.celulas)}</td>
        <td>${r.ruas ? `${icon('check')} OSM` : '<span class="muted">—</span>'}</td><td>${r.pois ? `${icon('check')} OSM` : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  },
  doneText: (m) => {
    const p = m.metrics?.plan || m.options || {};
    if ((m.options?.acao || p.acao) === 'osm') return 'Ruas e pontos de interesse baixados';
    const n = Object.values(m.metrics?.areas || {}).filter((a) => a.criada).length;
    return `${n} área(s) criada(s). Próximo passo: Filtragem.`;
  },
  cancelText: 'Cancelada. As áreas que já tinham terminado foram criadas; as outras não.',
};

JOBS.ensemble = {
  describe(p, live) {
    if (live?.options?.previa || live?.metrics?.areas && Object.values(live.metrics.areas).some((a) => a.previa)) return 'Recalculando o Ensemble com os valores da tela…';
    return p ? `${areaLabel(p.area)}: variante ${p.etapa} (${(p.sub ?? 0) + 1} de ${p.subtotal || '?'})` : 'Recalculando o Ensemble…';
  },
  fraction(p) { return !p || !p.total ? 0.1 : Math.min(0.98, (p.done + ((p.sub ?? 0) + 1) / (p.subtotal || 1)) / p.total); },
  metricsHtml(m) {
    const pv = Object.entries(m.areas || {}).filter(([, a]) => a.previa);
    if (!pv.length) return '';
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Área</th><th class="r">Entram no alto risco</th><th class="r">Saem</th><th class="r">Ficam</th><th class="r">Correlação</th></tr></thead>
      <tbody>${pv.map(([a, x]) => `<tr><td><b>${esc(areaLabel(a))}</b></td><td class="r num">${nf(x.previa.entram)}</td><td class="r num">${nf(x.previa.saem)}</td><td class="r num">${nf(x.previa.ficam)}</td><td class="r num">${esc(String(x.previa.correlacao).replace('.', ','))}</td></tr>`).join('')}</tbody></table></div>`;
  },
  doneText: (m) => (m.options?.previa ? 'Pré-visualização pronta' : `Variantes do Ensemble gravadas (${(m.options?.variantes || []).map((v) => (v === 'poicat' ? 'ablação por categoria de POI' : v.startsWith('poiset:') ? `conjunto ${v.slice(7)}` : v)).join(', ') || '6'})`),
  cancelText: 'Cancelada. O Ensemble salvo não foi alterado.',
};

JOBS.pois = {
  describe(p, live) {
    const plan = live?.metrics?.plan || {};
    if (!p) return plan.acao === 'osm' || live?.options?.acao === 'osm' ? 'Conectando ao OpenStreetMap…' : 'Lendo o arquivo…';
    const etapa = { baixando: 'baixando do OpenStreetMap', recortando: 'recortando pelo contorno da área' }[p.etapa] || 'processando';
    return p.total ? `${areaLabel(p.area)} (${Math.min(p.done + 1, p.total)} de ${p.total}): ${etapa}` : 'Concluindo…';
  },
  fraction(p) { return !p || !p.total ? 0.03 : Math.min(0.98, (p.done + 0.5) / p.total); },
  metricsHtml(m) {
    const rows = Object.entries(m.areas || {}).filter(([, a]) => a.contagem).map(([k, a]) => [k, a.contagem]);
    if (!rows.length) return '';
    const tot = (c) => Object.values(c).reduce((s, v) => s + v, 0);
    return `<div class="tbl-wrap"><table class="tbl run-areas"><thead><tr><th>Área</th><th class="r">Pontos</th><th>Categorias com mais pontos</th></tr></thead>
      <tbody>${rows.map(([k, c]) => `<tr><td><b>${esc(areaLabel(k))}</b></td><td class="r num">${nf(tot(c))}</td>
        <td class="small">${esc(Object.entries(c).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([n, v]) => `${n} ${nf(v)}`).join(' · '))}</td></tr>`).join('')}</tbody></table></div>`;
  },
  doneText: (m) => {
    const c = m.metrics?.conjunto;
    return c ? `Conjunto ${c.nome || c.id}: ${nf(c.total)} pontos (rascunho: confira e salve)` : 'Conjunto de pontos de interesse criado';
  },
  cancelText: 'Cancelada. Nenhum conjunto foi criado; o que já foi baixado fica no cache.',
};

JOBS.science = {
  describe: () => 'Calculando as métricas (rótulos reais, top-k exato, linhas de base, calibração, Wilcoxon)…',
  fraction: () => 0.5,
  metricsHtml: () => '',
  doneText: (m) => ({ agregar: 'Sementes agregadas', vazamento: 'Comparação com vazamento pronta' }[m.options?.acao] || `Métricas da semente ${m.options?.seed ?? ''} prontas`),
  cancelText: 'Cancelada. Nenhuma previsão foi alterada.',
};

/** Junta um evento do treino nas métricas (mesma estrutura do manifesto). */
function trainEvent(m, ev) {
  if (ev.t === 'plan') m.plan = { areas: ev.areas, modelos: ev.modelos, fast: ev.fast, modo: ev.modo };
  if (ev.t === 'train') {
    m.active = m.active || {};
    if (ev.status === 'start') m.active[ev.model] = { area: ev.area, fase: null };
    if (ev.status === 'end') {
      m.train = m.train || {};
      m.train[`${ev.model}|${ev.area}`] = { model: ev.model, area: ev.area, secs: ev.secs, linhas: ev.linhas, positivos: ev.positivos };
      m.active[ev.model] = { ...(m.active[ev.model] || {}), done: true };
    }
  }
  if (ev.t === 'progress' && ev.id === 'train') {
    m.active = m.active || {};
    m.active[ev.model] = { area: ev.area, fase: ev.fase, epoch: ev.epoch, epochs: ev.epochs, batch: ev.done, nb: ev.total };
  }
  if (ev.t === 'metric' && ev.id === 'train') {
    const k = `${ev.model}|${ev.area}`;
    m.curves = m.curves || {};
    const c = (m.curves[k] = m.curves[k] || { loss: [], auc: [] });
    if (ev.key === 'loss' && ev.fase === 'final') c.loss.push(ev.value);
    if (ev.key === 'auc_fold') c.auc.push(ev.value);
    if (ev.key === 'loss' && m.active?.[ev.model]) Object.assign(m.active[ev.model], { lastLoss: ev.value, epoch: ev.epoch, epochs: ev.epochs, batch: ev.epochs ? 0 : 0 });
  }
}

const STATE = {
  running: ['Executando', 'running'], ok: ['Concluída', 'done'], error: ['Falhou', 'error'],
  cancelled: ['Cancelada', 'stale'], interrupted: ['Interrompida', 'stale'],
};

/**
 * Monta o painel em `el`. Devolve { run(opts), unmount(), isRunning() }.
 * opts.anim: elemento <pc-phase-anim> para acompanhar o progresso.
 * opts.onEnd(status) / opts.onState(state): avisos para a tela.
 */
export function mountRunPanel(el, job, { anim, onEnd, onState, onTrainEvent, endAction } = {}) {
  const J = JOBS[job];
  let live = null;     // execução em andamento ou a última (past=true)
  let timer = null;

  el.innerHTML = `<div class="card run-card" id="rp-card" hidden></div>
    <div class="card" id="rp-history"><h2>Execuções anteriores</h2><div class="empty">Carregando…</div></div>`;
  const $ = (s) => el.querySelector(s);
  const startTimer = () => {
    clearInterval(timer);
    timer = setInterval(() => { const t = el.querySelector('.run-time'); if (t && live?.status === 'running') t.textContent = fmtSecs((Date.now() - live.startedAt) / 1000); }, 1000);
  };

  function renderCard() {
    const card = $('#rp-card');
    if (!live) { card.hidden = true; return; }
    card.hidden = false;
    const [lbl, st] = STATE[live.status] || STATE.running;
    const secs = live.secs ?? ((live.endedAt || Date.now()) - live.startedAt) / 1000;
    const frac = live.status === 'ok' ? 1 : J.fraction(live.progress, live);
    card.dataset.state = live.status;
    card.innerHTML = `
      <h2>${live.past ? `Última execução · ${esc(fmtDate(live.startedAt))}` : 'Execução'} <span class="pill" data-status="${st}">${esc(lbl)}</span>
        ${live.area ? `<span class="pill" data-status="pending">${esc(areaLabel(live.area))}</span>` : ''}
        <span class="spacer"></span><span class="num run-time">${fmtSecs(secs)}</span></h2>
      <div class="run-stage">${live.status === 'running' ? esc(J.describe(live.progress, live))
        : live.status === 'ok' ? `${icon('check')} ${esc(J.doneText(live.manifest || live))}`
        : live.status === 'cancelled' ? esc(J.cancelText) : 'A execução parou com erro.'}</div>
      ${live.past ? '' : `<div class="prog-track ${live.status === 'running' ? 'busy' : ''}"><i style="width:${Math.round(frac * 100)}%"></i></div>`}
      ${live.error ? `<div class="callout" data-tone="err">${icon('x')}<div><b>${esc(live.error.msg || 'Erro')}</b>${live.error.hint ? `<br>${esc(live.error.hint)}` : ''}</div></div>` : ''}
      ${J.metricsHtml(live.metrics || {})}
      ${live.past ? '' : `<details class="run-log" ${live.status === 'error' ? 'open' : ''}><summary>Log desta execução (${live.lines.length} linhas)</summary>
        <div class="loglist">${live.lines.slice(-200).map((l) => `<div class="logline" data-level="${l.level}"><span class="msg">${esc(l.text)}</span></div>`).join('')}</div></details>`}
      <div class="btn-row" style="margin-top:12px">
        ${live.status === 'running' ? `<button class="btn" data-rp="cancel">${icon('x')} Cancelar</button>` : ''}
        <button class="btn" data-rp="open" data-run="${esc(live.runId)}">${icon('folder')} Abrir registro</button>
      </div>`;
    const lg = card.querySelector('.run-log .loglist');
    if (lg) lg.scrollTop = lg.scrollHeight;
    if (anim) anim.setAttribute('progress', live.status === 'running' ? String(frac) : live.status === 'ok' && !live.past ? '1' : '');
  }

  async function renderHistory() {
    const box = $('#rp-history');
    let list = [];
    try { list = await call('run:list', job, 8); } catch { /* sem pasta */ }
    if (!live && list[0]?.status === 'ok') {
      const m = list[0];
      live = { past: true, runId: m.runId, startedAt: Date.parse(m.startedAt), secs: m.secs, status: 'ok', area: m.area, metrics: m.metrics || {}, options: m.options, manifest: m, lines: [] };
      renderCard();
    }
    if (!list.length) { box.innerHTML = `<h2>Execuções anteriores</h2><div class="empty">Esta fase ainda não foi executada pelo app.</div>`; return; }
    box.innerHTML = `<h2>Execuções anteriores</h2>
      <table class="tbl"><thead><tr><th>Início</th><th>Situação</th><th>Áreas</th><th class="r">Duração</th><th>Resultado</th><th></th></tr></thead>
      <tbody>${list.map((m) => {
        const [lbl, st] = STATE[m.status] || ['—', 'pending'];
        const started = m.startedAt ? Date.parse(m.startedAt) : runIdDate(m.runId);
        const mes = m.options?.mes || m.metrics?.plan?.mes;
        const areasTxt = (mes ? `${monthLabel(mes)} · ` : '') + (m.area ? areaLabel(m.area) : m.metrics?.plan?.areas?.length && m.metrics.plan.areas.length < 4 ? m.metrics.plan.areas.map(areaLabel).join(', ') : 'Todas as áreas');
        return `<tr><td>${started ? fmtDate(started) : esc(m.runId)}</td>
          <td><span class="pill" data-status="${st}">${esc(lbl)}</span></td>
          <td>${job === 'clean' ? '—' : esc(areasTxt)}</td>
          <td class="r num">${m.secs != null ? fmtSecs(m.secs) : '—'}</td>
          <td>${m.status === 'ok' ? esc(J.doneText(m)) : m.error ? esc(m.error.msg || '') : ''}<span class="vr" id="vr-${esc(m.runId)}"></span></td>
          <td class="r nowrap">${m.status === 'ok' ? `<button class="btn sm" data-rp="verify" data-run="${esc(m.runId)}" title="Confere se os arquivos gerados ainda são os mesmos">${icon('validate')} Verificar</button>` : ''}
            <button class="btn sm" data-rp="open" data-run="${esc(m.runId)}" title="Abrir a pasta do registro">${icon('folder')}</button></td></tr>`;
      }).join('')}</tbody></table>
      <p class="note">Cada execução fica registrada em <span class="mono">runs</span> na pasta de trabalho: parâmetros, versões, arquivos de entrada e o sha256 dos arquivos gerados.</p>`;
  }

  const off = window.pc.on('run:event', (p) => {
    if (p.job !== job) return;
    if (p.t === 'start') {
      live = { runId: p.runId, startedAt: p.startedAt, area: p.area, progress: null, metrics: {}, lines: [], status: 'running', error: null };
      startTimer();
      onState?.('running');
    }
    if (!live || live.runId !== p.runId) return;
    if (p.t === 'lines') { live.lines.push(...p.lines); if (live.lines.length > 1000) live.lines.splice(0, live.lines.length - 1000); }
    if (p.t === 'event') {
      const ev = p.ev;
      if (job === 'train') { trainEvent(live.metrics, ev); onTrainEvent?.(ev, live.metrics); }
      if (ev.t === 'progress') live.progress = { done: ev.done, total: ev.total, etapa: ev.etapa, arquivo: ev.arquivo, area: ev.area, modelo: ev.modelo, sub: ev.sub, subtotal: ev.subtotal };
      if (ev.t === 'plan' && job !== 'train') { const { v, t, ts, ...plan } = ev; live.metrics.plan = plan; }
      if (ev.t === 'metric' && job !== 'train') {
        if (ev.area) {
          live.metrics.areas = live.metrics.areas || {};
          const a = (live.metrics.areas[ev.area] = live.metrics.areas[ev.area] || {});
          if (ev.model) (a[ev.key] = a[ev.key] || {})[ev.model] = ev.value; else a[ev.key] = ev.value;
        } else live.metrics[ev.key] = ev.value;
      }
      if (ev.t === 'error') live.error = { msg: ev.msg, hint: ev.hint };
    }
    if (p.t === 'end') {
      live.status = p.status; live.endedAt = Date.now(); live.manifest = p.manifest;
      clearInterval(timer);
      refreshWorkspace(); renderHistory();
      if (p.status === 'ok') toast(`${p.manifest?.label || 'Execução'} concluída em ${fmtSecs(p.secs)}.`, 'ok', 10000, endAction?.(p) || null);
      else if (p.status === 'error') toast(live.error?.hint || live.error?.msg || 'A execução falhou. Veja o log.', 'err', 10000);
      onEnd?.(p.status);
    }
    renderCard();
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rp]');
    if (!b) return;
    const act = b.dataset.rp, runId = b.dataset.run;
    try {
      if (act === 'cancel' && await confirmar('Cancelar a execução?', { detalhe: J.cancelText.replace(/^Cancelada\.\s*/, ''), ok: 'Cancelar a execução', cancelar: 'Continuar rodando', perigo: true })) await call('run:cancel');
      if (act === 'open') await call('run:open', runId);
      if (act === 'verify') {
        b.disabled = true;
        const r = await call('run:verify', runId);
        const vr = el.querySelector(`#vr-${CSS.escape(runId)}`);
        if (vr) vr.innerHTML = r.ok ? ` <span class="pill" data-status="done">${icon('check')}íntegro</span>`
          : ` <span class="pill" data-status="error">${icon('x')}${esc(r.files.filter((f) => f.state !== 'ok').map((f) => `${f.path.split('/').pop()} ${f.state === 'missing' ? 'sumiu' : 'mudou'}`).join(', '))}</span>`;
        b.disabled = false;
      }
    } catch (err) { toast(err.message, 'err'); b.disabled = false; }
  });

  // retoma uma execução em andamento (ex.: o operador saiu e voltou para a tela)
  call('run:status').then((s) => {
    if (s && s.job === job) {
      live = { runId: s.runId, startedAt: s.startedAt, area: s.area, progress: s.progress, metrics: s.metrics || {}, lines: [], status: 'running', error: null };
      startTimer();
      renderCard();
      onState?.('running');
    }
  }).catch(() => {}).finally(renderHistory);

  return {
    async run(opts) { return call('run:start', job, opts || {}); },
    isRunning: () => live?.status === 'running',
    unmount() { off(); clearInterval(timer); },
  };
}

/**
 * Botão "Executar" com a escolha da área, ou o motivo de não poder executar.
 * ctx: { job, label, python, running, areas, area, blocker: {text, go?, goLabel?} }
 */
export function execControls({ job, label, python, running, areas = [], area = '', blocker = null, note = '' }) {
  if (!python) return `<button class="btn primary" disabled>${icon('refresh')} Verificando o Python…</button>`;
  if (!python.jobs?.[job]) {
    return `<div class="exec-row"><button class="btn primary" data-go="env">${icon('env')} Preparar o ambiente</button>
      <span class="muted">Para executar, o app precisa do Python e dos pacotes do pipeline. A tela <b>Ambiente</b> prepara tudo com um botão.</span></div>`;
  }
  if (blocker) {
    return `<div class="exec-row">${blocker.go ? `<button class="btn" data-go="${esc(blocker.go)}">${icon('chevron-left')} ${esc(blocker.goLabel)}</button>` : ''}
      <span class="muted">${esc(blocker.text)}</span></div>`;
  }
  return `<div class="exec-row">
    ${areas.length > 1 ? `<label class="field inline">Áreas
      <select data-exec-area ${running ? 'disabled' : ''}>
        <option value="">Todas (${areas.length})</option>
        ${areas.map((a) => `<option value="${esc(a)}" ${a === area ? 'selected' : ''}>${esc(areaLabel(a))}</option>`).join('')}
      </select></label>` : ''}
    <button class="btn primary" data-act="run" ${running ? 'disabled' : ''}>${icon('play')} ${running ? 'Executando…' : `Executar ${esc(label)}`}</button>
    ${note ? `<span class="muted">${note}</span>` : ''}</div>`;
}
