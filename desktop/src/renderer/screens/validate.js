// Validação: compara a previsão de um mês com os crimes que de fato aconteceram.
// Separada da Previsão: roda quando a SSP publica o mês e o dataset passa a ter os crimes reais.
import { store, call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { seloPersonalizado } from '../lib/padrao.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { phaseHead, animCard, statusCardHtml } from './phase.js';
import { mountRunPanel, execControls, areaLabel, monthLabel, modoPill, fmtPct, fmtDec } from '../components/run-panel.js';

const dmy = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const callout = (tone, html) => `<div class="callout" data-tone="${tone}">${icon(tone === 'info' ? 'info' : 'warn')}<div>${html}</div></div>`;
const MODELS = [['Ensemble', 'Ensemble'], ['RF', 'Random Forest'], ['LSTM', 'LSTM'], ['Transformer', 'Transformer']];
const avg = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('validate', '')}
    <div class="card" id="opts"><div class="empty">Carregando…</div></div>
    <div id="run-panel"></div>
    <div class="card" id="results"></div>
    <div class="card" id="history"></div>
    <div id="status-card"></div>
    ${animCard('validate')}`;
  const $ = (s) => el.querySelector(s);
  let fi = null;
  let tag = store.get().validateMonth || null;
  let area = '';
  store.set({ validateMonth: null });

  const month = () => fi?.months.find((m) => m.tag === tag);
  const pred = (a) => fi.areas.find((x) => x.area === a)?.predictions?.[tag];

  function pickDefault() {
    if (tag && fi.months.some((m) => m.tag === tag)) return;
    const ready = fi.months.filter((m) => m.readyToValidate.some((a) => !m.validated.includes(a)));
    const done = fi.months.filter((m) => m.validated.length);
    tag = (ready[ready.length - 1] || done[done.length - 1] || fi.months[fi.months.length - 1])?.tag || null;
  }

  function renderOpts() {
    const { python } = store.get();
    if (!fi) return;
    if (!fi.months.length) {
      $('#opts').innerHTML = `<h2>Mês a validar</h2><div class="empty">Ainda não há previsão para validar.
        <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-go="predict">${icon('chevron-left')} Ir para Previsão</button></div></div>`;
      return;
    }
    const m = month();
    if (area && !m.readyToValidate.includes(area)) area = '';
    const falta = !m.readyToValidate.length;
    const blocker = falta ? { text: 'Bloqueada até os crimes reais do mês entrarem pela Filtragem (veja o aviso em vermelho acima).', go: 'ssp', goLabel: 'Ir para Dados SSP' } : null;
    // A validação usa como gabarito os crimes da Filtragem (todos os meses), não o dataset das
    // Features: a data final do período corta só o treino e a previsão.
    const crimeAte = m.areas.map((a) => fi.areas.find((x) => x.area === a)?.lastCrime).filter(Boolean).sort()[0] || null;
    const needBox = falta ? `<div class="need-box" role="alert">
        ${icon('warn')}
        <div>
          <p class="need-title">Faltam os crimes reais para validar ${esc(monthLabel(tag))}: é preciso ter dados até ${esc(dmy(m.needUntil))}.</p>
          <p>A validação compara cada semana prevista com os crimes das <b>4 semanas seguintes</b> a ela. A última semana prevista começa em
            ${esc(dmy(m.lastNeeded))}, então os crimes precisam ir até <b>${esc(dmy(m.needUntil))}</b>.
            ${crimeAte ? `Hoje os crimes reais (Limpeza → Filtragem) vão até <b>${esc(dmy(crimeAte))}</b>.` : 'Ainda não há crimes da Filtragem nesta pasta.'}</p>
          <ol>
            <li><b>Importe</b> a planilha da SSP que cobre até ${esc(dmy(m.needUntil))} em <b>Dados SSP</b>.</li>
            <li>Rode <b>Limpeza</b> e <b>Filtragem</b>.</li>
            <li>Volte aqui e clique em <b>Executar Validação</b>.</li>
          </ol>
          <p class="need-ok">${icon('check')} Não precisa refazer as Features, treinar nem prever: a validação lê os crimes direto da Filtragem.
            A data final do período (Features) continua protegendo o treino das próximas previsões.</p>
          <div class="btn-row"><button class="btn danger" data-go="ssp">${icon('ssp')} Importar a planilha em Dados SSP</button></div>
        </div>
      </div>` : '';
    const replayInfo = !falta && fi.dataEnd ? `<div class="callout" data-tone="info">${icon('info')}<div>O período do dataset termina em <b>${esc(fi.dataEnd.split('-').reverse().join('/'))}</b> (Features).
        A validação usa os crimes da Filtragem como gabarito, então enxerga as semanas depois disso sem que o treino e as próximas previsões as vejam.</div></div>` : '';
    const retro = m.areas.filter((a) => pred(a)?.modo === 'retroativa');

    $('#opts').innerHTML = `
      <h2>Mês a validar</h2>
      ${needBox}
      <div class="pred-row">
        <label class="field">Previsão<select id="tag">${[...fi.months].reverse().map((x) => `<option value="${esc(x.tag)}" ${x.tag === tag ? 'selected' : ''}>${esc(monthLabel(x.tag))}${x.validated.length ? ' · validada' : x.readyToValidate.length ? ' · pronta' : ''}</option>`).join('')}</select></label>
        <div class="pred-explain"><p>A validação precisa dos crimes reais das 4 semanas previstas (até a semana de <b>${esc(dmy(m.lastNeeded))}</b>) e das 4 semanas seguintes a cada uma.</p></div>
      </div>
      ${replayInfo}
      ${retro.length ? callout('warn', `A previsão de ${esc(monthLabel(tag))} em ${retro.map((a) => esc(areaLabel(a))).join(', ')} foi <b>retroativa</b>: o mês estava nos dados de treino e o acerto fica otimista. Não use esses números como resultado da pesquisa.`) : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Área</th><th>Tipo da previsão</th><th>Crimes reais (Filtragem)</th><th>Validação</th></tr></thead>
        <tbody>${m.areas.map((a) => {
          const A = fi.areas.find((x) => x.area === a);
          const ok = m.readyToValidate.includes(a);
          return `<tr><td><b>${esc(areaLabel(a))}</b></td><td>${modoPill(pred(a)?.modo || 'desconhecido')}</td>
            <td>${ok ? `<span class="pill" data-status="done">${icon('check')}disponíveis</span>` : `<span class="muted">até ${esc(dmy(A?.lastCrime))}</span>`}</td>
            <td>${m.validated.includes(a) ? `<span class="pill" data-status="done">${icon('check')}feita</span>` : ok ? '<span class="pill" data-status="partial">pronta</span>' : '—'}</td></tr>`;
        }).join('')}</tbody></table></div>
      ${execControls({ job: 'validate', label: 'Validação', python, running: panel.isRunning(), areas: m.readyToValidate, area, blocker,
        note: m.validated.length ? 'Executar de novo substitui as métricas deste mês nas áreas escolhidas.' : 'Leva poucos segundos por área.' })}`;
  }

  // Modelos × linhas de base sem aprendizado, todos com o top exato (a mesma fração de células)
  function justaHtml() {
    const J = fi.justa?.[tag] || {};
    const areas = Object.keys(J).sort();
    if (!areas.length) return '';
    const nomes = [...new Set(areas.flatMap((a) => Object.keys(J[a])))];
    const ord = ['Ensemble', 'RF', 'LSTM', 'Transformer'];
    nomes.sort((a, b) => (ord.includes(a) ? ord.indexOf(a) : 9) - (ord.includes(b) ? ord.indexOf(b) : 9));
    const m = (n, k) => avg(areas.map((a) => J[a][n]?.[k]).filter((x) => x != null));
    const q = J[areas[0]][nomes[0]]?.q;
    const melhorBase = Math.max(...nomes.filter((n) => J[areas[0]][n]?.base || areas.some((a) => J[a][n]?.base)).map((n) => m(n, 'pai')));
    const ens = m('Ensemble', 'pai');
    return `<h3 class="pgroup" style="margin-top:16px">Comparação justa com as linhas de base <span class="muted">— top ${q ? Math.round((1 - q) * 100) : 10}% exato, média de ${areas.length} área(s)</span></h3>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Modelo</th><th class="r">Acerto</th><th class="r">PAI</th><th class="r">F1</th></tr></thead>
      <tbody>${nomes.map((n) => { const base = areas.some((a) => J[a][n]?.base); return `<tr class="${base ? 'muted' : ''}"><td><b>${esc(n)}</b>${base ? ' <span class="tag-chip">sem IA</span>' : ''}</td>
        <td class="r num">${fmtPct(m(n, 'foco'))}</td><td class="r num">${fmtDec(m(n, 'pai'), 2)}</td><td class="r num">${fmtDec(m(n, 'f1'), 3)}</td></tr>`; }).join('')}</tbody></table></div>
      ${Number.isFinite(ens) && Number.isFinite(melhorBase) && ens <= melhorBase ? `<div class="callout" data-tone="warn">${icon('warn')}<div><b>O Ensemble não supera a média histórica neste mês.</b> Uma regra simples, sem IA (marcar as células com mais crimes nas semanas anteriores), teve PAI igual ou maior.</div></div>` : ''}
      <p class="note">As linhas de base não usam aprendizado: "Média 24 semanas" marca as células com mais crimes, em média, nas 24 semanas antes do mês; "Últimas 4 semanas", as com mais crimes nas 4 semanas antes. Aqui todos os modelos marcam exatamente a mesma fração de células (top exato, empates desempatados com a semente), por isso os números podem diferir da tabela acima, que usa a regra "maior ou igual ao quantil" da dissertação.</p>`;
  }

  function renderResults() {
    if (!fi || !tag) { $('#results').innerHTML = ''; return; }
    const V = fi.validations[tag] || {};
    const Z = fi.zhang[tag] || {};
    const areas = Object.keys(V).sort();
    if (!areas.length) { $('#results').innerHTML = `<h2>Resultado de ${esc(monthLabel(tag))}</h2><div class="empty">Este mês ainda não foi validado.</div>`; return; }
    const models = MODELS.filter(([k]) => areas.some((a) => V[a][k]));
    const best = (a) => models.reduce((b, [k]) => (V[a][k]?.foco ?? -1) > (V[a][b]?.foco ?? -1) ? k : b, models[0][0]);
    const persM = fi.months.find((x) => x.tag === tag)?.personalizado || [];
    $('#results').innerHTML = `<h2>Resultado de ${esc(monthLabel(tag))} ${seloPersonalizado(persM)}<span class="spacer"></span>
        <button class="btn sm" data-map="${esc(tag)}" data-area="${esc(areas[0])}" data-tab="perf">${icon('map')} Ver desempenho no mapa</button></h2>
      <div class="tbl-wrap"><table class="tbl val-tbl"><thead>
        <tr><th rowspan="2">Área</th><th rowspan="2" class="r" title="Soma, nas 4 semanas previstas, dos crimes das 4 semanas seguintes a cada uma (método da dissertação): um crime pode contar em mais de uma semana.">Crimes avaliados</th>${models.map(([, l]) => `<th colspan="3" class="c grp">${esc(l)}</th>`).join('')}</tr>
        <tr>${models.map(() => '<th class="r">Acerto</th><th class="r">Cobertura</th><th class="r">PAI</th>').join('')}</tr></thead>
        <tbody>${areas.map((a) => { const b = best(a); return `<tr><td><b>${esc(areaLabel(a))}</b> ${modoPill(pred(a)?.modo || 'desconhecido')}</td>
          <td class="r num">${(V[a].Ensemble || Object.values(V[a])[0])?.crimes?.toLocaleString('pt-BR') ?? '—'}</td>
          ${models.map(([k]) => { const r = V[a][k]; return r ? `<td class="r num grp ${k === b ? 'best' : ''}">${fmtPct(r.foco)}</td><td class="r num">${fmtPct(r.cobertura)}</td><td class="r num">${fmtDec(r.pai, 1)}</td>` : '<td class="r grp">—</td><td></td><td></td>'; }).join('')}</tr>`; }).join('')}</tbody>
        ${areas.length > 1 ? `<tfoot><tr><td>Média</td><td></td>${models.map(([k]) => `<td class="r num grp">${fmtPct(avg(areas.map((a) => V[a][k]?.foco)))}</td><td class="r num">${fmtPct(avg(areas.map((a) => V[a][k]?.cobertura)))}</td><td class="r num">${fmtDec(avg(areas.map((a) => V[a][k]?.pai)), 1)}</td>`).join('')}</tr></tfoot>` : ''}
      </table></div>
      <dl class="gloss">
        <div><dt>Acerto (foco)</dt><dd>Parte dos crimes do mês que caiu na zona vermelha (células de maior risco).</dd></div>
        <div><dt>Cobertura</dt><dd>Parte dos crimes que caiu na zona vermelha ou amarela.</dd></div>
        <div><dt>Crimes avaliados</dt><dd>Para cada semana prevista, os crimes das 4 semanas seguintes (como na dissertação). Um mesmo crime entra em até 4 semanas, por isso o número é maior que as ocorrências do mês.</dd></div>
        <div><dt>PAI</dt><dd>Quantas vezes a zona vermelha concentra mais crimes do que a mesma área escolhida ao acaso. 1 = igual ao acaso.</dd></div>
      </dl>
      ${justaHtml()}
      ${Object.keys(Z).length ? `<details class="pk"><summary>Métricas de Zhang (top 10% das células)</summary>
        <table class="tbl"><thead><tr><th>Área</th>${models.map(([, l]) => `<th class="r">${esc(l)}<br><span class="muted">HitRn · HitEn</span></th>`).join('')}</tr></thead>
        <tbody>${Object.keys(Z).sort().map((a) => `<tr><td><b>${esc(areaLabel(a))}</b></td>${models.map(([k]) => { const z = Z[a][k]; return `<td class="r num">${z ? `${fmtDec(z.hitrn)} · ${fmtDec(z.hiten)}` : '—'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>
        <p class="note">HitRn: fração dos crimes nas células previstas. HitEn: eficiência de acerto (Zhang et al., 2020, eq. 10), comparável às tabelas do artigo.</p></details>` : ''}
      <p class="note">${icon('check')} O acerto em destaque é o do modelo que mais acertou na área. As métricas ficam em <span class="mono">processed/results/metrics_summary_all.csv</span> e <span class="mono">processed/metrics/zhang_comparison.csv</span>.</p>`;
  }

  function renderHistory() {
    const tags = Object.keys(fi?.validations || {}).sort();
    if (tags.length < 1) { $('#history').innerHTML = ''; return; }
    const rows = tags.map((t) => {
      const V = fi.validations[t];
      const areas = Object.keys(V);
      const modos = [...new Set(areas.map((a) => fi.areas.find((x) => x.area === a)?.predictions?.[t]?.modo || 'desconhecido'))];
      return { t, n: areas.length, modos, foco: avg(areas.map((a) => V[a].Ensemble?.foco)), pai: avg(areas.map((a) => V[a].Ensemble?.pai)) };
    });
    const mx = Math.max(1, ...rows.map((r) => r.foco || 0));
    $('#history').innerHTML = `<h2>Meses validados (Ensemble, média das áreas)</h2>
      <table class="tbl"><thead><tr><th>Mês</th><th>Áreas</th><th>Tipo</th><th>Acerto</th><th class="r">PAI</th></tr></thead>
      <tbody>${rows.reverse().map((r) => `<tr class="${r.t === tag ? 'sel' : ''}" data-pick="${esc(r.t)}"><td><b>${esc(monthLabel(r.t))}</b></td><td>${r.n}</td><td>${r.modos.map(modoPill).join(' ')}</td>
        <td><span class="hbar"><i style="width:${r.foco ? Math.round((r.foco / mx) * 100) : 0}%"></i></span> <span class="num">${fmtPct(r.foco)}</span></td><td class="r num">${fmtDec(r.pai, 1)}</td></tr>`).join('')}</tbody></table>
      <p class="note">Clique num mês para ver o detalhe. Compare só meses do mesmo tipo: os retroativos ficam otimistas.</p>`;
  }

  async function load() {
    try { fi = await call('forecast:info'); } catch (e) { $('#opts').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (fi.months.length) pickDefault();
    renderOpts(); renderResults(); renderHistory();
  }

  el.addEventListener('change', (e) => {
    if (e.target.id === 'tag') { tag = e.target.value; area = ''; renderOpts(); renderResults(); renderHistory(); }
    if (e.target.matches('[data-exec-area]')) { area = e.target.value; renderOpts(); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="run"]')) {
      try { await panel.run({ area: area || null, mes: tag.replace('_', '-') }); renderOpts(); scrollToEl($('#run-panel')); } catch (err) { toast(err.message, 'err', 8000); }
    }
    const pk = e.target.closest('[data-pick]');
    if (pk) { tag = pk.dataset.pick; renderOpts(); renderResults(); renderHistory(); scrollToEl($('#results')); }
    const mp = e.target.closest('[data-map]');
    if (mp) { store.set({ mapFocus: { tag: mp.dataset.map, area: mp.dataset.area, tab: mp.dataset.tab || 'map' } }); store.set({ screen: 'map' }); }
    const open = e.target.closest('[data-open]');
    if (open) call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err'));
  });

  const panel = mountRunPanel($('#run-panel'), 'validate', {
    anim: el.querySelector('pc-phase-anim'),
    onState: renderOpts,
    onEnd: () => load(),
    endAction: () => ({ label: 'Ver resultado', fn: () => scrollToEl($('#results')) }),
  });
  const renderStatus = () => { $('#status-card').innerHTML = statusCardHtml('validate'); };
  const off = store.subscribe((_s, why) => {
    if (why === 'ws') { renderStatus(); load(); }
    if (why === 'python') renderOpts();
  });
  renderStatus(); load();
  return () => { off(); panel.unmount(); };
}
