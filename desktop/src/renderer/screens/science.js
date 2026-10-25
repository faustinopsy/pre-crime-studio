// Modo científico: replay sem vazamento, multi-seed, origem móvel, variantes do Ensemble,
// comparação com vazamento e as métricas do Artigo 1 (top-k exato, linhas de base, calibração,
// Wilcoxon com Holm).
import { store, call, refreshWorkspace } from '../lib/store.js';
import { confirmar } from '../lib/dialog.js';
import { icon } from '../lib/icons.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { mountSeqView, seqHistoryHtml, totalSecs, estTxt } from '../components/seq-view.js';
import { fmtPct, fmtDec, areaLabel } from '../components/run-panel.js';
import { seloCampo, seloPersonalizado } from '../lib/padrao.js';

const monthLabel = (m) => (m ? m.split(/[-_]/).reverse().join('/') : '—');
const addMonths = (mes, n) => { const [y, m] = mes.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const PREF = 'precrime.science.form';
const loadForm = () => { try { return JSON.parse(localStorage.getItem(PREF)) || null; } catch { return null; } };
const saveForm = (f) => { try { localStorage.setItem(PREF, JSON.stringify(f)); } catch { /* sem armazenamento */ } };
const MODELS = [['rf', 'Random Forest'], ['lstm', 'LSTM'], ['transformer', 'Transformer']];
const SUGESTOES = [42, 43, 44, 45, 46];
const RETREINO = [[0, 'Só no início (dissertação)'], [1, 'Todo mês'], [3, 'A cada 3 meses'], [6, 'A cada 6 meses'], [12, 'A cada 12 meses']];
const NOME = { rf: 'RF', lstm: 'LSTM', transformer: 'Transformer', ensemble: 'Ensemble', base_media24sem: 'Média 24 semanas (sem IA)', base_ultimas4sem: 'Últimas 4 semanas (sem IA)' };
const VAR_NOME = { semrf: 'sem o RF', semmax: 'sem o máximo', sempoi: 'sem POI', semfiltro: 'sem filtro de histórico', semsuav: 'sem suavização', comsuav: 'com a suavização das simulações iniciais', ranks: 'média dos postos' };
// variantes de pontos de interesse: ensemble-sem-<categoria> (ablação; ':' vira '.' no nome do arquivo) e ensemble-poi-<conjunto>
const ehAblacao = (m) => /^ensemble-sem-/.test(m);
const ehConjunto = (m) => /^ensemble-poi-/.test(m);
const nomeModelo = (m) => NOME[m] || (ehAblacao(m) ? `Ensemble sem ${m.slice(13).replace('.', ':')}`
  : ehConjunto(m) ? `Ensemble com o conjunto de POI ${m.slice(13)}` : m.startsWith('ensemble-') ? `Ensemble ${VAR_NOME[m.slice(9)] || m.slice(9)}` : m);
const ORDEM = ['ensemble', 'rf', 'lstm', 'transformer', 'base_media24sem', 'base_ultimas4sem'];
const ordem = (m) => (ORDEM.includes(m) ? ORDEM.indexOf(m) : 10 + m.length);
const n3 = (x) => (x == null || Number.isNaN(Number(x)) ? '—' : Number(x).toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
const pFmt = (p) => (p == null ? '—' : p < 0.001 ? '< 0,001' : Number(p).toLocaleString('pt-BR', { maximumFractionDigits: 3 }));

export function mount(el) {
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('flask')} Modo científico</h1>
      <p>Replay sem vazamento: reproduz o que o sistema teria previsto em cada mês usando só o que se sabia antes dele. Os modelos são treinados com dados até o fim do mês anterior ao primeiro mês avaliado (e, se você escolher, retreinados a cada N meses); cada mês é previsto com o dataset cortado no fim do mês anterior. No final, as previsões são comparadas com os crimes reais com as métricas do artigo: top-k exato, duas linhas de base sem aprendizado, calibração e testes estatísticos. Com várias sementes, mede a variação entre treinos.</p></div></div>
    <section class="card" id="s-form"></section>
    <section class="card" id="s-plan" hidden></section>
    <section class="card" id="s-run" hidden></section>
    <section class="card" id="s-sci"></section>
    <section class="card" id="s-res"></section>
    <section class="card" id="s-hist"><h2>Replays anteriores</h2><div class="empty">Carregando…</div></section>`;
  const $ = (s) => el.querySelector(s);
  const hw = store.get().hardware;
  let form = { inicio: null, n: 3, seeds: [42], retreino: 0, variantes: false, vazamento: false, personalizado: false, poiSet: 'dissertacao', ablacaoPoi: false, comparar: [], modelos: ['rf', 'lstm', 'transformer'], modo: hw?.verdict?.profile === 'eco' ? 'sequencial' : 'paralelo', ...(loadForm() || {}) };
  if (typeof form.seeds === 'string') form.seeds = form.seeds.split(/[,;\s]+/).map(Number).filter(Number.isInteger);
  if (!Array.isArray(form.seeds) || !form.seeds.length) form.seeds = [42];
  let plan = null;
  let hist = [];
  let pers = null;            // defaults:summary (o que está diferente da dissertação)
  let conjuntos = [];         // pois:list (só os salvos)

  function meses() { return form.inicio ? Array.from({ length: Math.max(1, Math.min(24, Number(form.n) || 1)) }, (_, i) => addMonths(form.inicio, i)) : []; }
  const endPrev = (mes) => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10).split('-').reverse().join('/'); };

  function seedsHtml(running) {
    const extras = form.seeds.filter((s) => !SUGESTOES.includes(s));
    return `<div class="seed-chips" role="group" aria-label="Sementes">${[...SUGESTOES, ...extras].map((s) => {
      const on = form.seeds.includes(s);
      return `<button class="seed-chip ${on ? 'on' : ''}" data-seed="${s}" aria-pressed="${on}" ${running ? 'disabled' : ''}>${s}${on && form.seeds[0] === s ? '<span class="principal">principal</span>' : ''}</button>`;
    }).join('')}
      <input id="f-seed-add" type="number" min="0" placeholder="outra" class="poi-in" ${running ? 'disabled' : ''} aria-label="Outra semente"></div>
      <p class="muted small">A primeira escolhida é a principal: os modelos e previsões que ficam na pasta são os dela. ${seloCampo(form.seeds.length === 1 && form.seeds[0] === 42, '42 (uma semente)')}</p>`;
  }

  async function renderForm() {
    if (!form.inicio) {
      try { const v = await call('dataset:view'); form.inicio = v.last ? addMonths(v.last, -(Number(form.n) + 2)) : null; } catch { /* sem planilhas */ }
    }
    try { pers = await call('defaults:summary'); } catch { pers = null; }
    try { conjuntos = (await call('pois:list')).conjuntos.filter((c) => c.status === 'pronto'); } catch { conjuntos = []; }
    if (!conjuntos.some((c) => c.id === form.poiSet)) form.poiSet = 'dissertacao';
    form.comparar = (form.comparar || []).filter((id) => id !== form.poiSet && conjuntos.some((c) => c.id === id));
    const running = view.current()?.status === 'running';
    const ms = meses();
    const areas = store.get().ws?.phases?.find((p) => p.id === 'filter')?.areasDone || [];
    const D = running ? 'disabled' : '';
    const persItens = (pers?.itens || []).filter((i) => i.screen === 'train' || i.screen === 'risk');
    $('#s-form').innerHTML = `<h2>Experimento</h2>
      <div class="sci-grid">
        <label class="field">Primeiro mês avaliado<input type="month" id="f-ini" value="${esc(form.inicio || '')}" ${D}></label>
        <label class="field">Quantos meses <span class="muted">(até 24)</span><input type="number" id="f-n" min="1" max="24" value="${esc(form.n)}" ${D}></label>
        <label class="field">Retreinar os modelos<select id="f-ret" ${D}>${RETREINO.map(([v, l]) => `<option value="${v}" ${Number(form.retreino) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Áreas<select id="f-area" ${D}><option value="">Todas</option>${areas.map((a) => `<option value="${a}" ${form.area === a ? 'selected' : ''}>${esc(areaLabel(a))}</option>`).join('')}</select></label>
        <fieldset><legend>Modelos</legend>${MODELS.map(([k, l]) => `<label class="chk"><input type="checkbox" name="f-m" value="${k}" ${form.modelos.includes(k) ? 'checked' : ''} ${D}> ${l}</label>`).join('')}</fieldset>
        <fieldset><legend>Treino</legend>
          <label class="chk"><input type="radio" name="f-modo" value="paralelo" ${form.modo === 'paralelo' ? 'checked' : ''} ${D}> Três ao mesmo tempo</label>
          <label class="chk"><input type="radio" name="f-modo" value="sequencial" ${form.modo === 'sequencial' ? 'checked' : ''} ${D}> Um por vez</label></fieldset>
      </div>
      <div class="field" style="margin-top:10px">Sementes ${seedsHtml(running)}</div>
      <div class="sci-grid" style="margin-top:10px">
        <label class="field">Conjunto de pontos de interesse<select id="f-poi" ${D}>${conjuntos.map((c) => `<option value="${esc(c.id)}" ${c.id === form.poiSet ? 'selected' : ''}>${esc(c.nome || c.id)}${c.id === 'dissertacao' ? ' (padrão)' : ''}</option>`).join('')}</select>
          <span>${seloCampo(form.poiSet === 'dissertacao', 'Dissertação', 'data-act="poi-reset"')} <button class="link-btn" data-go="pois">gerenciar conjuntos</button></span></label>
      </div>
      <div class="choice" style="margin-top:10px">
        <label class="opt"><input type="checkbox" id="f-var" ${form.variantes ? 'checked' : ''} ${D}><span><b>Variantes do Ensemble</b>
          <span class="muted">Depois de cada previsão, recalcula só o Ensemble sem o RF, sem o máximo, sem POI, sem o filtro de histórico, sem suavização e com a média dos postos, pelo próprio step5 (sem novo treino). Antes, confere que o Ensemble recalculado sem mudança nenhuma é idêntico ao salvo.</span></span></label>
        <label class="opt"><input type="checkbox" id="f-abl" ${form.ablacaoPoi ? 'checked' : ''} ${D}><span><b>Ablação por categoria de ponto de interesse</b>
          <span class="muted">Recalcula o Ensemble uma vez para cada categoria do conjunto que tem pelo menos um ponto na área, com o peso dela zerado só ali (sem_&lt;categoria&gt;), e uma vez sem pontos de interesse (sempoi). Mesmo teste de identidade das variantes. Resultados em ensemble_variantes.csv e wilcoxon_variantes.csv. Pode levar alguns minutos por mês.</span></span></label>
        ${conjuntos.length > 1 ? `<div class="opt"><span><b>Comparar com outros conjuntos de pontos de interesse</b>
          <span class="muted">Recalcula o Ensemble com outro conjunto sobre as mesmas previsões salvas (variante poi_&lt;conjunto&gt;), sem novo treino.</span>
          <span class="chk-grid">${conjuntos.filter((c) => c.id !== form.poiSet).map((c) => `<label class="chk"><input type="checkbox" name="f-cmp" value="${esc(c.id)}" ${form.comparar.includes(c.id) ? 'checked' : ''} ${D}> ${esc(c.nome || c.id)}</label>`).join('')}</span></span></div>` : ''}
        <label class="opt"><input type="checkbox" id="f-vaz" ${form.vazamento ? 'checked' : ''} ${D}><span><b>Rodar também a versão com vazamento (só para comparação)</b>
          <span class="muted">Treina com todos os dados, inclusive os meses avaliados, e prevê os mesmos meses. <strong class="forte">Não é uma avaliação válida</strong>: serve para mostrar no artigo como o vazamento muda a ordem dos modelos. No fim, as previsões do replay voltam para a pasta.</span></span></label>
        ${persItens.length ? `<label class="opt"><input type="checkbox" id="f-pers" ${form.personalizado ? 'checked' : ''} ${D}><span><b>Usar a configuração personalizada neste replay</b>
          <span class="muted">Diferente da dissertação: ${esc(persItens.map((i) => `${i.tela} (${i.o.join(', ')})`).join('; '))}. Desmarcado, o replay usa os valores da dissertação (modelos, Ensemble e cobertura) e não muda sem querer.</span></span></label>` : ''}
      </div>
      ${persItens.length && !form.personalizado ? `<div class="callout" data-tone="info">${icon('info')}<div>A configuração atual do Treino ou do Mapa de risco é diferente da dissertação. Este replay vai usar os valores da dissertação.</div></div>` : ''}
      ${form.poiSet !== 'dissertacao' ? `<div class="callout" data-tone="warn">${icon('warn')}<div>O replay vai usar o conjunto de pontos de interesse <b>${esc(conjuntos.find((c) => c.id === form.poiSet)?.nome || form.poiSet)}</b> (configuração personalizada). O identificador e o hash do conjunto ficam no registro de cada semente.</div></div>` : ''}
      ${persItens.length && form.personalizado ? `<div class="callout" data-tone="warn">${icon('warn')}<div>O replay vai usar a configuração personalizada. Os números não são os da dissertação.</div></div>` : ''}
      <p class="muted" style="margin-top:10px">${ms.length ? `Meses: <b>${esc(ms.length > 6 ? `${monthLabel(ms[0])} a ${monthLabel(ms[ms.length - 1])} (${ms.length})` : ms.map(monthLabel).join(', '))}</b>. Primeiro treino com dados até <b>${esc(endPrev(ms[0]))}</b>.` : 'Escolha o primeiro mês.'}</p>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-act="plan" ${running || !ms.length ? 'disabled' : ''}>${icon('runs')} Ver o plano</button></div>`;
  }

  function readForm() {
    form = {
      ...form,
      inicio: $('#f-ini')?.value || form.inicio, n: Math.min(24, Number($('#f-n')?.value || form.n)),
      retreino: Number($('#f-ret')?.value ?? form.retreino),
      modelos: [...el.querySelectorAll('input[name="f-m"]:checked')].map((i) => i.value),
      modo: el.querySelector('input[name="f-modo"]:checked')?.value || form.modo,
      area: $('#f-area')?.value || '',
      variantes: !!$('#f-var')?.checked, vazamento: !!$('#f-vaz')?.checked, personalizado: !!$('#f-pers')?.checked,
      poiSet: $('#f-poi')?.value || form.poiSet, ablacaoPoi: !!$('#f-abl')?.checked,
      comparar: [...el.querySelectorAll('input[name="f-cmp"]:checked')].map((i) => i.value),
    };
    saveForm(form);
  }

  function renderPlan() {
    const box = $('#s-plan');
    if (!plan) { box.hidden = true; return; }
    box.hidden = false;
    const jobs = plan.steps.filter((s) => s.kind === 'job');
    const o = plan.origens || [];
    const treinos = [...new Set(o.map((x) => x.treinoAte))];
    box.innerHTML = `<h2>Plano · ${plan.steps.length} passos <span class="spacer"></span><span class="muted">${esc(estTxt(totalSecs(plan.steps)))}</span></h2>
      ${plan.aviso ? `<div class="callout" data-tone="warn">${icon('warn')}<div>${esc(plan.aviso)}</div></div>` : ''}
      ${o.length > 1 ? `<h3 class="pgroup">Qual treino cada mês usa <span class="muted">— ${treinos.length} treino(s)</span></h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mês previsto</th><th>Modelos treinados com dados até</th><th></th></tr></thead>
        <tbody>${o.map((x) => `<tr><td>${esc(monthLabel(x.mes))}</td><td>${esc(x.treinoAte.split('-').reverse().join('/'))}</td><td>${x.retreino ? '<span class="tag-chip on">treino</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <details class="pk" style="margin-top:8px"><summary>Todos os passos</summary>
      <ol class="seq-steps plan">${plan.steps.map((s) => `<li data-state="pending"><span class="dotc"></span><div><b>${esc(s.label)}</b>
        ${s.overrides?.DATA_END ? `<span class="tag-chip">dados até ${esc(s.overrides.DATA_END.split('-').reverse().join('/'))}</span>` : s.kind === 'job' && ['features', 'train', 'predict'].includes(s.job) ? '<span class="tag-chip on">todos os dados</span>' : ''}
        ${s.secs ? `<span class="muted small">${esc(estTxt(s.secs))}</span>` : ''}</div></li>`).join('')}</ol></details>
      <p class="note">${jobs.filter((s) => s.job === 'train').length} treino(s), ${jobs.filter((s) => s.job === 'predict').length} previsão(ões), ${jobs.filter((s) => s.job === 'validate').length} validação(ões), ${jobs.filter((s) => s.job === 'science').length} cálculo(s) de métricas. ${plan.params?.malha ? `Malha: <b>${esc(plan.params.malha)}</b>. ` : ''}${plan.params?.padraoDissertacao ? 'Modelos, Ensemble, cobertura e pontos de interesse: padrão da dissertação.' : 'Usa a configuração personalizada.'}${plan.params?.poiSet && plan.params.poiSet !== 'dissertacao' ? ` Conjunto de pontos de interesse: <b>${esc(plan.params.poiSet)}</b>.` : ''}${plan.params?.ablacaoPoi ? ' Com ablação por categoria de ponto de interesse.' : ''}${plan.params?.compararConjuntos?.length ? ` Compara com ${plan.params.compararConjuntos.length} conjunto(s) de POI.` : ''} As Features são refeitas várias vezes (com e sem data final); no fim, o dataset volta a ter todos os dados. Os modelos que ficam na pasta são os do replay${plan.params?.vazamento ? ' com vazamento (treinados com todos os dados)' : ' (da semente principal), treinados só com dados até a data final: para voltar a prever o próximo mês, o Ciclo mensal pede um treino novo'}.</p>
      <div class="btn-row"><button class="btn primary" data-act="run">${icon('play')} Executar o replay</button></div>`;
  }

  // ── métricas científicas (pipeline/science) ───────────────────────────────────────────────
  async function renderSci() {
    let R = null;
    try { R = await call('replay:results'); } catch { /* nada */ }
    const box = $('#s-sci');
    if (!R) {
      box.innerHTML = `<h2>Métricas do artigo</h2><p class="muted">Depois de um replay, aqui aparecem o PAI e o F1 de cada modelo com o top 10% exato, as duas linhas de base sem aprendizado, a calibração e o teste de Wilcoxon.</p>`;
      return;
    }
    const S = R.sementes[0];
    const r = S.resumo;
    const meses = [...new Set(r.porModeloMes.map((x) => x.Tag))].sort();
    const modelos = [...new Set(r.porModeloMes.map((x) => x.Modelo))].filter((m) => !ehAblacao(m) && !ehConjunto(m)).sort((a, b) => ordem(a) - ordem(b));
    const cel = (m, t, k) => r.porModeloMes.find((x) => x.Modelo === m && x.Tag === t)?.[k];
    const best = (t, k) => Math.max(...modelos.map((m) => cel(m, t, k) ?? -Infinity));
    const tabela = (k, titulo) => `<h3 class="pgroup">${titulo} <span class="muted">— média das áreas, top 10% exato</span></h3>
      <div class="tbl-wrap"><table class="tbl sci-tbl"><thead><tr><th>Modelo</th>${meses.map((t) => `<th class="r">${esc(monthLabel(t))}</th>`).join('')}</tr></thead>
      <tbody>${modelos.map((m) => `<tr class="${m.startsWith('base_') ? 'base' : ''}"><td><b>${esc(nomeModelo(m))}</b></td>${meses.map((t) => { const v = cel(m, t, k); return `<td class="r num ${v != null && Math.abs(v - best(t, k)) < 1e-12 ? 'melhor' : ''}">${n3(v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
    const wil = (r.wilcoxon || []).filter((w) => w.Metrica === 'PAI');
    const cal = (r.calibracao || []).filter((c) => !ehAblacao(c.Modelo) && !ehConjunto(c.Modelo)).sort((a, b) => ordem(a.Modelo) - ordem(b.Modelo));
    const evm = r.ensembleVsMembros || [];
    const sup = evm.filter((x) => x.supera_melhor_PAI === true || x.supera_melhor_PAI === 'True').length;
    const supM = evm.filter((x) => x.supera_media_PAI === true || x.supera_media_PAI === 'True').length;
    const colapso = Object.entries(r.fracSelMaiorIgual || {}).filter(([, f]) => f > 0.15);
    const reg = S.registro || {};
    const poiReg = reg.pois && reg.pois.id && reg.pois.id !== 'dissertacao' ? reg.pois : null;
    box.innerHTML = `<h2>Métricas do artigo <span class="spacer"></span><span class="muted">semente ${esc(S.seed)}${R.sementes.length > 1 ? ` (mais recente de ${R.sementes.length})` : ''}</span>${seloPersonalizado(Object.keys(reg.personalizado || {}).length ? Object.keys(reg.personalizado) : [])}</h2>
      ${R.malhasDiferentes ? `<div class="callout" data-tone="err">${icon('warn')}<div><b>Malhas diferentes.</b> As sementes guardadas usaram malhas diferentes (com e sem células repetidas): os números de uma e de outra não são comparáveis.</div></div>` : ''}
      <p class="muted small">Malha ${reg.malha_com_celulas_repetidas ? '<b>original (com células repetidas)</b>' : '<b>sem células repetidas</b>'}${reg.celulas_por_area ? ` · ${Object.keys(reg.celulas_por_area).length} área(s), ${Object.values(reg.celulas_por_area).reduce((a, b) => a + (b || 0), 0).toLocaleString('pt-BR')} células` : ''} · dados desde ${esc((reg.DATE_START_DATA || '').split('-').reverse().join('/'))}${reg.origens ? ` · ${new Set(reg.origens.map((o) => o.treinoAte)).size} treino(s)` : ''} · pontos de interesse: ${poiReg ? `<b>${esc(poiReg.nome || poiReg.id)}</b> <span class="mono">${esc(poiReg.id)} · ${esc(String(poiReg.hash || '').slice(0, 12))}</span>` : 'conjunto da dissertação'}</p>
      ${tabela('PAI', 'PAI')}
      ${tabela('F1', 'F1')}
      ${colapso.length ? `<div class="callout" data-tone="warn">${icon('warn')}<div>Com a regra "maior ou igual" da validação padrão, ${esc(colapso.map(([m, f]) => `${nomeModelo(m)} chega a selecionar ${fmtPct(f * 100)}`).join('; '))} das células (empates no corte). Por isso as métricas do artigo usam o top exato.</div></div>` : ''}
      ${evm.length ? `<p style="margin-top:8px">O Ensemble supera o melhor dos três membros em <b>${sup} de ${evm.length}</b> pares área × mês e a média dos três em <b>${supM} de ${evm.length}</b> (PAI, top 10% exato).</p>` : ''}
      <h3 class="pgroup">Calibração <span class="muted">— média das áreas</span></h3>
      <div class="tbl-wrap"><table class="tbl sci-tbl"><thead><tr><th>Modelo</th><th class="r">ECE (10 faixas)</th><th class="r">Brier</th><th class="r">PR-AUC</th></tr></thead>
        <tbody>${cal.map((c) => `<tr><td><b>${esc(nomeModelo(c.Modelo))}</b></td><td class="r num">${n3(c.ECE)}</td><td class="r num">${n3(c.Brier)}</td><td class="r num">${n3(c.PR_AUC)}</td></tr>`).join('')}</tbody></table></div>
      ${wil.length ? `<h3 class="pgroup">Wilcoxon pareado (PAI) <span class="muted">— pares área × mês, correção de Holm</span></h3>
        <div class="tbl-wrap"><table class="tbl sci-tbl"><thead><tr><th>A</th><th>B</th><th class="r">Diferença média</th><th class="r">A maior em</th><th class="r">p</th><th class="r">p (Holm)</th></tr></thead>
        <tbody>${wil.map((w) => `<tr><td>${esc(nomeModelo(w.A))}</td><td>${esc(nomeModelo(w.B))}</td><td class="r num">${n3(w.dif_media)}</td><td class="r num">${esc(w.pos)} de ${esc(w.n)}</td><td class="r num">${pFmt(w.p)}</td><td class="r num ${w.p_holm < 0.05 ? 'melhor' : ''}">${pFmt(w.p_holm)}</td></tr>`).join('')}</tbody></table></div>
        <p class="note">Os pares de meses diferentes da mesma área não são independentes; F1, HitEn e ECE estão em <span class="mono">wilcoxon_replay.csv</span>.</p>` : ''}
      ${(r.variantes || []).length ? variantesHtml(r) : ''}
      ${S.vazamento ? `<div class="vaz-warn card" style="margin-top:12px"><h3 class="pgroup">${icon('warn')} Com e sem vazamento <span class="muted">— a versão com vazamento não é uma avaliação válida</span></h3>
        <div class="tbl-wrap"><table class="tbl sci-tbl"><thead><tr><th>Modelo</th><th class="r">PAI sem vazamento</th><th class="r">PAI com vazamento</th></tr></thead>
        <tbody>${S.vazamento.sort((a, b) => ordem(a.Modelo) - ordem(b.Modelo)).map((v) => `<tr><td><b>${esc(nomeModelo(v.Modelo))}</b></td><td class="r num">${n3(v.PAI_sem_vazamento)}</td><td class="r num">${n3(v.PAI_com_vazamento)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
      <p class="note">Tudo por área, mês, modelo, quantil (0,95, 0,90 e 0,80) e regra de corte em <span class="mono">processed\\replay_seeds\\seed_${esc(S.seed)}\\metricas_replay.csv</span>.</p>
      <div class="btn-row"><button class="btn primary" data-act="export">${icon('save')} Exportar resultados do replay</button><button class="btn" data-open="processed">${icon('folder')} Abrir a pasta</button></div>`;
  }

  // variantes do Ensemble: as fixas e os conjuntos de POI inteiros; a ablação por categoria pode ter
  // centenas de linhas, então mostra as que mais mudam o PAI (pareado com o Ensemble na mesma área e mês)
  function variantesHtml(r) {
    const linhas = r.variantes.filter((v) => v.Modelo !== 'ensemble');
    const ens = new Map(r.variantes.filter((v) => v.Modelo === 'ensemble').map((v) => [`${v.Tag}|${v.Area}`, v]));
    const grupos = new Map();
    for (const v of linhas) { if (!grupos.has(v.Modelo)) grupos.set(v.Modelo, []); grupos.get(v.Modelo).push(v); }
    const media = (l, k) => l.reduce((a, b) => a + Number(b[k]), 0) / (l.length || 1);
    const dPai = (l) => media(l.map((v) => ({ d: Number(v.PAI) - Number(ens.get(`${v.Tag}|${v.Area}`)?.PAI ?? NaN) })).filter((x) => Number.isFinite(x.d)), 'd');
    const wv = new Map((r.wilcoxonVariantes || []).filter((w) => w.Metrica === 'PAI').map((w) => [w.B, w]));
    const linha = (m, l) => { const w = wv.get(m); const d = dPai(l); return `<tr><td><b>${esc(l[0].Variante && ehAblacao(m) ? l[0].Variante : nomeModelo(m))}</b></td><td class="r num">${l.length}</td><td class="r num">${n3(media(l, 'PAI'))}</td>
      <td class="r num ${d < 0 ? 'neg' : ''}">${Number.isFinite(d) ? (d > 0 ? '+' : '') + n3(d) : '—'}</td><td class="r num">${n3(media(l, 'F1'))}</td><td class="r num">${n3(media(l, 'ECE'))}</td><td class="r num">${w ? pFmt(w.p_holm) : '—'}</td></tr>`; };
    const cab = (t) => `<thead><tr><th>${t}</th><th class="r">Pares</th><th class="r">PAI</th><th class="r">Δ PAI</th><th class="r">F1</th><th class="r">ECE</th><th class="r">p (Holm)</th></tr></thead>`;
    const fixas = [...grupos.keys()].filter((m) => !ehAblacao(m)).sort((a, b) => ordem(a) - ordem(b));
    const abl = [...grupos.keys()].filter(ehAblacao).map((m) => [m, dPai(grupos.get(m))]).sort((a, b) => Math.abs(b[1] || 0) - Math.abs(a[1] || 0));
    const N = 15;
    return `<h3 class="pgroup">Variantes do Ensemble <span class="muted">— média das áreas e meses, top 10% exato; Δ PAI pareado com o Ensemble completo</span></h3>
      ${fixas.length ? `<div class="tbl-wrap"><table class="tbl sci-tbl">${cab('Variante')}<tbody>${fixas.map((m) => linha(m, grupos.get(m))).join('')}</tbody></table></div>` : ''}
      ${abl.length ? `<h3 class="pgroup">Ablação por categoria de ponto de interesse <span class="muted">— ${abl.length} categoria(s); as ${Math.min(N, abl.length)} que mais mudam o PAI</span></h3>
        <div class="tbl-wrap"><table class="tbl sci-tbl">${cab('Sem a categoria')}<tbody>${abl.slice(0, N).map(([m]) => linha(m, grupos.get(m))).join('')}</tbody></table></div>
        <p class="note">Δ negativo: tirar a categoria piora o PAI (ela ajuda o Ensemble). Todas as categorias em <span class="mono">ensemble_variantes.csv</span> e <span class="mono">wilcoxon_variantes.csv</span>, na pasta da semente.</p>` : ''}`;
  }

  async function renderResults() {
    let sum = null;
    try { sum = await call('replay:summary'); } catch { /* nada */ }
    const box = $('#s-res');
    if (!sum) {
      box.innerHTML = `<h2>Validação padrão do replay</h2><p class="muted">Com uma semente, a validação padrão do app (a mesma do Ciclo mensal) aparece na tela <a href="#" data-go="validate">Validação</a> (tipo "Replay"). Com várias sementes, o resumo (média ± desvio entre sementes) aparece aqui e fica em <span class="mono">processed\\replay_seeds</span>.</p>`;
      return;
    }
    const key = (r) => `${r.Tag}|${r.Modelo}`;
    const g = new Map();
    for (const r of sum.linhas) {
      if (!g.has(key(r))) g.set(key(r), { Tag: r.Tag, Modelo: r.Modelo, foco: [], focoSd: [], pai: [], paiSd: [] });
      const x = g.get(key(r)); x.foco.push(r.foco.mean); x.focoSd.push(r.foco.sd); x.pai.push(r.pai.mean); x.paiSd.push(r.pai.sd);
    }
    const avg = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
    const ORDER = ['Ensemble', 'RF', 'LSTM', 'Transformer'];
    const rows = [...g.values()].sort((a, b) => a.Tag.localeCompare(b.Tag) || ORDER.indexOf(a.Modelo) - ORDER.indexOf(b.Modelo));
    box.innerHTML = `<h2>Validação padrão · multi-seed <span class="spacer"></span><span class="muted">${sum.seeds.length} sementes (${esc(sum.seeds.join(', '))}) · ${esc(new Date(sum.geradoEm).toLocaleString('pt-BR'))}</span></h2>
      <table class="tbl"><thead><tr><th>Mês</th><th>Modelo</th><th class="r">Acerto (média ± dp)</th><th class="r">PAI (média ± dp)</th><th class="r">Áreas</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(monthLabel(r.Tag))}</td><td><b>${esc(r.Modelo)}</b></td>
        <td class="r num">${fmtPct(avg(r.foco))} ± ${fmtDec(avg(r.focoSd), 1)}</td><td class="r num">${fmtDec(avg(r.pai), 2)} ± ${fmtDec(avg(r.paiSd), 2)}</td><td class="r num">${r.foco.length}</td></tr>`).join('')}</tbody></table>
      <p class="note">Regra "maior ou igual ao quantil" da validação padrão (com os empates, pode marcar mais que 10% das células; as métricas do artigo, acima, usam o top exato). O desvio é entre sementes. As métricas do artigo com todas as sementes: <span class="mono">metricas_multiseed.csv</span> e <span class="mono">wilcoxon_multiseed.csv</span>.</p>`;
  }

  async function renderHist() {
    try { hist = await call('seq:list', 15); $('#s-hist').innerHTML = `<h2>Replays anteriores</h2>${seqHistoryHtml(hist, 'replay')}`; } catch { /* sem pasta */ }
  }

  const view = mountSeqView($('#s-run'), 'replay', {
    onEnd: (r) => {
      toast(r.status === 'ok' ? 'Replay concluído.' : 'O replay parou. Veja o passo com problema.', r.status === 'ok' ? 'ok' : 'err', 10000);
      refreshWorkspace(); renderForm(); renderSci(); renderResults(); renderHist();
    },
  });

  const reform = () => { readForm(); plan = null; renderPlan(); renderForm(); };
  el.addEventListener('change', (e) => {
    if (e.target.id === 'f-seed-add') {
      const n = Number(e.target.value);
      if (Number.isInteger(n) && n >= 0 && !form.seeds.includes(n)) form.seeds.push(n);
      reform(); return;
    }
    if (e.target.closest('#s-form')) reform();
  });
  el.addEventListener('click', async (e) => {
    const sc = e.target.closest('[data-seed]');
    if (sc) {
      const n = Number(sc.dataset.seed);
      if (form.seeds.includes(n)) { if (form.seeds.length > 1) form.seeds = form.seeds.filter((x) => x !== n); else toast('Escolha ao menos uma semente.', 'err'); }
      else form.seeds.push(n);
      reform(); return;
    }
    if (e.target.closest('[data-act="poi-reset"]')) { form.poiSet = 'dissertacao'; saveForm(form); plan = null; renderPlan(); renderForm(); return; }
    if (e.target.closest('[data-act="plan"]')) {
      readForm();
      if (!form.modelos.length) { toast('Escolha ao menos um modelo.', 'err'); return; }
      try {
        plan = await call('replay:plan', { meses: meses(), seeds: form.seeds, modelos: form.modelos, modo: form.modo, area: form.area || null,
          retreino: form.retreino, variantes: form.variantes, vazamento: form.vazamento, personalizado: form.personalizado,
          poiSet: form.poiSet, ablacaoPoi: form.ablacaoPoi, compararConjuntos: form.comparar });
        renderPlan(); scrollToEl($('#s-plan'));
      } catch (err) { toast(err.message, 'err', 9000); }
      return;
    }
    if (e.target.closest('[data-act="run"]') && plan) {
      if (!(await confirmar('Executar o replay?', { detalhe: `São ${plan.steps.length} passos (${estTxt(totalSecs(plan.steps))}). Os datasets, modelos e previsões da pasta de trabalho são refeitos.`, ok: 'Executar o replay' }))) return;
      try { const rec = await call('seq:start', plan); plan = null; renderPlan(); view.show(rec); renderForm(); scrollToEl($('#s-run')); } catch (err) { toast(err.message, 'err', 9000); }
      return;
    }
    if (e.target.closest('[data-act="export"]')) {
      const b = e.target.closest('[data-act="export"]');
      b.disabled = true;
      try { const r = await call('replay:export'); toast(`Resultados exportados (${r.n} arquivos): ${r.arquivo.split(/[\\/]/).pop()}`, 'ok', 10000); } catch (err) { toast(err.message, 'err', 9000); }
      b.disabled = false;
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) { call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err')); return; }
    const sh = e.target.closest('[data-seq-show]');
    if (sh) { const r = hist.find((x) => x.id === sh.dataset.seqShow); if (r) { view.show(r); scrollToEl($('#s-run')); } }
  });

  call('seq:status').then((r) => { if (r?.kind === 'replay') view.show(r); }).catch(() => {}).finally(() => { renderForm(); renderSci(); renderResults(); renderHist(); });
  return () => view.unmount();
}
