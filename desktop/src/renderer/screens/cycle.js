// Ciclo mensal: o fluxo do operador quando a SSP publica um mês novo, num lugar só.
// Planilha nova → Limpeza → Filtragem → Features → Validação → (Treino) → Previsão → pacote.
// "Fazer tudo" enfileira os passos marcados; o operador pode sair da frente do computador.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { mountSeqView, seqHistoryHtml, totalSecs, estTxt } from '../components/seq-view.js';

const monthLabel = (m) => (m ? m.split(/[-_]/).reverse().join('/') : '—');

export function mount(el) {
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('cycle')} Ciclo mensal</h1>
      <p>Quando a SSP publica um mês novo: importe a planilha e use <b>Fazer tudo</b>. O app refaz a base, valida as previsões que agora têm crimes reais, prevê o próximo mês e monta o pacote de publicação. Cada passo pode ser desmarcado.</p></div></div>
    <section class="card" id="c-ssp"><div class="empty">Carregando…</div></section>
    <section class="card" id="c-steps"></section>
    <section class="card" id="c-run" hidden></section>
    <section class="card" id="c-hist"><h2>Ciclos anteriores</h2><div class="empty">Carregando…</div></section>`;
  const $ = (s) => el.querySelector(s);
  let plan = null;
  let skips = {};

  async function load() {
    try { plan = await call('cycle:plan'); } catch (e) { $('#c-ssp').innerHTML = `<div class="empty">${esc(e.message)}</div>`; $('#c-steps').hidden = true; return; }
    skips = Object.fromEntries(plan.steps.map((s) => [s.id, !!s.skip]));
    render();
  }

  function render() {
    const s = plan.state;
    const running = !!view.current() && view.current().status === 'running';
    $('#c-ssp').innerHTML = `<h2>${icon('ssp')} 1. Planilha da SSP</h2>
      <div class="cyc-row">
        <div class="cyc-fact"><b>${esc(monthLabel(s.lastData))}</b><span class="muted">último mês com dados nas planilhas</span></div>
        <div class="cyc-fact"><b>${s.sspFiles}</b><span class="muted">planilha(s) importada(s)</span></div>
        <div class="cyc-fact"><b>${esc(monthLabel(s.suggested))}</b><span class="muted">próximo mês a prever</span></div>
        <div class="cyc-fact"><b>${s.pendingValidation.length ? esc(s.pendingValidation.map(monthLabel).join(', ')) : 'nenhuma'}</b><span class="muted">previsões esperando validação</span></div>
      </div>
      ${s.cleanStatus === 'stale' ? `<div class="callout" data-tone="info">${icon('info')}<div>${esc(s.cleanReason || 'Há planilha nova.')} O ciclo refaz a base.</div></div>` : ''}
      <p class="muted" style="margin:10px 0">A SSP publica uma planilha por ano, atualizada a cada mês. Baixe a do ano corrente no site da SSP-SP e importe: a do mesmo ano é substituída.</p>
      <div class="btn-row"><button class="btn" data-go="ssp">${icon('ssp')} Importar planilhas</button>
        <button class="btn" data-act="reload">${icon('refresh')} Já importei, verificar de novo</button></div>`;

    const steps = plan.steps.map((x) => ({ ...x, skip: skips[x.id] }));
    $('#c-steps').innerHTML = `<h2>${icon('play')} 2. Passos</h2>
      ${s.datasetFim ? `<div class="callout" data-tone="warn">${icon('warn')}<div>O período em Features termina em ${esc(monthLabel(s.datasetFim))}. No ciclo, o dataset vai até o último mês com dados.</div></div>` : ''}
      <ol class="cyc-steps">${steps.map((x) => `<li class="${x.skip ? 'off' : ''}"><label class="chk"><input type="checkbox" data-step="${x.id}" ${x.skip ? '' : 'checked'} ${running ? 'disabled' : ''}>
          <span><b>${esc(x.label)}</b> <span class="muted small">${esc(estTxt(x.secs))}</span><span class="muted cyc-what">${esc(x.what)}${x.reason ? ` ${esc(x.reason)}` : ''}</span></span></label></li>`).join('')}</ol>
      <div class="exec-row" style="margin-top:12px">
        <button class="btn primary" data-act="run" ${running || !steps.some((x) => !x.skip) ? 'disabled' : ''}>${icon('play')} ${running ? 'Em andamento…' : 'Fazer tudo'}</button>
        <span class="muted">${steps.filter((x) => !x.skip).length} passo(s) · ${esc(estTxt(totalSecs(steps)))} pelas execuções anteriores${steps.some((x) => !x.skip && !x.secs) ? ' (alguns passos sem estimativa)' : ''}. Pode deixar o computador trabalhando: o app avisa no fim.</span>
      </div>`;
  }

  async function renderHist() {
    try { const list = await call('seq:list', 15); $('#c-hist').innerHTML = `<h2>Ciclos anteriores</h2>${seqHistoryHtml(list, 'ciclo')}`; this_list = list; } catch { /* sem pasta */ }
  }
  let this_list = [];

  const view = mountSeqView($('#c-run'), 'ciclo', {
    onEnd: (r) => {
      toast(r.status === 'ok' ? 'Ciclo mensal concluído.' : 'O ciclo mensal parou. Veja o passo com problema.', r.status === 'ok' ? 'ok' : 'err', 10000);
      refreshWorkspace(); load(); renderHist();
    },
  });

  el.addEventListener('change', (e) => {
    const id = e.target.dataset?.step;
    if (id) { skips[id] = !e.target.checked; render(); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="reload"]')) { $('#c-ssp').innerHTML = '<div class="empty">Verificando…</div>'; load(); return; }
    if (e.target.closest('[data-act="run"]')) {
      try {
        const rec = await call('seq:start', { kind: 'ciclo', title: plan.title, steps: plan.steps.map((x) => ({ ...x, skip: skips[x.id] })) });
        view.show(rec); render(); scrollToEl($('#c-run'));
      } catch (err) { toast(err.message, 'err', 9000); }
      return;
    }
    const sh = e.target.closest('[data-seq-show]');
    if (sh) { const r = this_list.find((x) => x.id === sh.dataset.seqShow); if (r) { view.show(r); scrollToEl($('#c-run')); } }
  });

  call('seq:status').then((r) => { if (r?.kind === 'ciclo') view.show(r); }).catch(() => {}).finally(() => { load(); renderHist(); });
  return () => view.unmount();
}
