// Tela de uma fase do pipeline: o que ela faz (texto e animação) e a situação na pasta
// de trabalho. O botão Executar é ligado nas próximas fases do plano.
import { store, call } from '../lib/store.js';
import { icon, STATUS_ICON, STATUS_LABEL } from '../lib/icons.js';
import { esc, toast } from '../lib/dom.js';
import { PHASE_INFO, PIPELINE_ORDER } from '../lib/phases.js';
import '../components/pc-phase-anim.js';

export const FOLDERS = { clean: 'raw', filter: 'processed', features: 'processed', train: 'processed', predict: 'processed', validate: 'processed', publish: 'publish' };

/** Cabeçalho da fase. Nas fases do pipeline, a navegação anterior/próxima fica no topo. */
export function phaseHead(id, actionsHtml, navOpts) {
  const info = PHASE_INFO[id];
  const nav = PIPELINE_ORDER.includes(id) ? phaseNav(id, navOpts) : '';
  return `${nav}<div class="phase-head">
      <div style="flex:1"><h1>${icon(info.icon)} ${esc(info.title)}</h1><p>${esc(info.what)}</p></div>
      ${actionsHtml}
    </div>`;
}

/** Barra fixa no topo da tela com a fase anterior e a próxima (fica visível ao rolar). */
export function phaseNav(id, { nextLabel, nextDisabled = false, nextTitle = '' } = {}) {
  const i = PIPELINE_ORDER.indexOf(id);
  const prev = i === 0 ? 'env' : PIPELINE_ORDER[i - 1], next = PIPELINE_ORDER[i + 1];
  return `<nav class="phase-nav" aria-label="Navegar entre as fases">
      ${prev ? `<button class="btn" data-go="${prev}">${icon('chevron-left')} Voltar: ${esc(PHASE_INFO[prev].title)}</button>` : '<span></span>'}
      <span class="phase-nav-pos">Etapa ${i + 2} de ${PIPELINE_ORDER.length + 1} · <b>${esc(PHASE_INFO[id].title)}</b></span>
      ${next ? `<button class="btn primary" data-go="${next}" ${nextDisabled ? 'disabled' : ''} title="${esc(nextTitle)}">Próximo: ${esc(nextLabel || PHASE_INFO[next].title)} ${icon('chevron-right')}</button>` : '<span></span>'}
    </nav>`;
}

export function animCard(id) {
  return `<div class="card anim-card"><h2>Como funciona</h2><pc-phase-anim phase="${id}"></pc-phase-anim></div>`;
}

/** Cartão "Situação" da fase, a partir do estado da pasta de trabalho. */
export function statusCardHtml(id) {
  const { ws } = store.get();
  const p = ws?.phases?.find((x) => x.id === id);
  if (!p) return '';
  const ic = STATUS_ICON[p.status] ? icon(STATUS_ICON[p.status]) : '';
  const extra = id === 'validate' && p.waiting?.length
    ? `<p class="muted" style="margin-top:6px">Aguardando validação: ${p.waiting.map((t) => esc(t.split('_').reverse().join('/'))).join(', ')}</p>` : '';
  const canOpen = FOLDERS[id] && (ws?.stagesReady || id === 'ssp');
  return `<div class="card">
    <h2>Situação <span class="pill" data-status="${p.status}">${ic}${esc(STATUS_LABEL[p.status])}</span></h2>
    <p>${esc(p.summary)}</p>
    ${p.reason ? `<p style="color:var(--stale);margin-top:6px">${esc(p.reason)}</p>` : ''}
    ${extra}
    ${canOpen ? `<div class="btn-row" style="margin-top:12px"><button class="btn" data-open="${FOLDERS[id]}">${icon('folder')} Abrir pasta</button></div>` : ''}
  </div>`;
}

export function mountPhase(id) {
  return function mount(el) {
    el.innerHTML = `
      ${phaseHead(id, `<button class="btn primary" disabled title="Em breve">${icon('play')} Executar</button>`)}
      <div id="status-card"></div>
      ${animCard(id)}`;
    const box = el.querySelector('#status-card');
    const render = () => { box.innerHTML = statusCardHtml(id); };
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-open]');
      if (!b) return;
      try { await call('workspace:open', b.dataset.open); } catch (err) { toast(err.message, 'err'); }
    });
    const off = store.subscribe((_s, why) => { if (why === 'ws') render(); });
    render();
    return off;
  };
}

export function mountEnv(el) {
  // Resumo da máquina. O diagnóstico completo, com instalação por botão, vem a seguir.
  const info = PHASE_INFO.env;
  const { metrics, info: app } = store.get();
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('env')} ${esc(info.title)}</h1><p>${esc(info.what)}</p></div>
      <button class="btn primary" disabled title="Em breve">${icon('refresh')} Verificar ambiente</button></div>
    <div class="cards">
      <div class="card"><h2>Este computador</h2>
        <dl class="kv">
          <dt>Memória</dt><dd class="num">${metrics ? `${metrics.ramTotalGb} GB` : '—'}</dd>
          <dt>Núcleos</dt><dd class="num">${metrics?.cores ?? '—'}</dd>
        </dl></div>
      <div class="card"><h2>Pre-Crime Studio</h2>
        <dl class="kv"><dt>Versão</dt><dd>${esc(app?.version || '—')}</dd></dl></div>
    </div>`;
}
