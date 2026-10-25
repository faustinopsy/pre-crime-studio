// Início: em que pé está o sistema e o que fazer agora.
import { store, refreshWorkspace } from '../lib/store.js';
import { icon, STATUS_ICON, STATUS_LABEL } from '../lib/icons.js';
import { esc, fmtDate } from '../lib/dom.js';
import { PHASE_INFO, PIPELINE_ORDER, nextAction } from '../lib/phases.js';

export function mount(el) {
  const render = () => {
    const { ws, wsError } = store.get();
    if (wsError) { el.innerHTML = `<div class="empty">Não consegui ler a pasta de dados.<br>${esc(wsError)}</div>`; return; }
    if (!ws?.phases) { el.innerHTML = '<div class="empty">Lendo a pasta de dados…</div>'; return; }
    const next = nextAction(ws, store.get().python);
    const by = Object.fromEntries(ws.phases.map((p) => [p.id, p]));
    el.innerHTML = `
      <div class="phase-head">
        <div style="flex:1">
          <h1>Visão geral</h1>
          <p>Estado de cada fase do pipeline na pasta de dados atual. Clique numa fase para ver os detalhes.</p>
        </div>
        <button class="btn" data-act="refresh">${icon('refresh')} Verificar de novo</button>
      </div>
      ${next ? `<div class="next"><div class="txt"><b>${esc(next.title)}</b><span class="muted">${esc(next.text)}</span></div>
        ${next.screen === 'home' ? '' : `<button class="btn primary" data-go="${esc(next.screen)}">Ir para ${esc(PHASE_INFO[next.screen]?.title || ({ map: 'Mapa', cycle: 'Ciclo mensal' })[next.screen] || 'Configurações')}</button>`}</div>` : ''}
      <div class="cards">
        ${PIPELINE_ORDER.map((id) => {
          const p = by[id];
          const ic = STATUS_ICON[p.status] ? icon(STATUS_ICON[p.status]) : '';
          return `<button class="card phase-card" data-go="${id}">
            <span class="title">${icon(PHASE_INFO[id].icon)} ${esc(PHASE_INFO[id].title)}
              <span class="pill" data-status="${p.status}">${ic}${esc(STATUS_LABEL[p.status])}</span></span>
            <span class="sum">${esc(p.summary)}</span>
            ${p.reason ? `<span class="sum" style="color:var(--stale)">${esc(p.reason)}</span>` : ''}
          </button>`;
        }).join('')}
      </div>
      <div class="cards">
        <div class="card">
          <h2>${icon('folder')} Pasta de dados</h2>
          <dl class="kv">
            <dt>Local</dt><dd class="mono">${esc(ws.dataDir)}</dd>
            <dt>Áreas</dt><dd>${ws.areas.length ? esc(ws.areas.join(', ')) : '—'}</dd>
            <dt>Verificado</dt><dd>${fmtDate(ws.checkedAt)}</dd>
          </dl>
          <div class="checks" style="margin-top:10px">
            ${chk(ws.exists, 'Pasta encontrada')}
            ${ws.stagesReady ? `${chk(ws.base.streets.ok, `Malhas das áreas (${ws.base.streets.grids} grids, ${ws.base.streets.ruas} ruas)`)}
            ${chk(ws.base.pois.ok, `Pontos de interesse (${ws.base.pois.files} arquivos)`)}`
            : `<span class="check">${icon('info')} As pastas de cada etapa são criadas depois da importação das planilhas.</span>`}
          </div>
          <div class="btn-row" style="margin-top:12px">
            <button class="btn" data-go="settings">${icon('settings')} Trocar pasta</button>
          </div>
        </div>
        <div class="card">
          <h2>${icon('map')} Mapa</h2>
          <p class="muted" style="margin-bottom:12px">${by.predict.status === 'pending' ? 'Ainda não há previsão para mostrar.' : 'Veja a previsão, os crimes reais e o desempenho dos modelos sem sair do app.'}</p>
          <button class="btn primary" data-go="map" ${by.predict.status === 'pending' ? 'disabled' : ''}>${icon('map')} Abrir mapa</button>
        </div>
      </div>`;
  };
  const chk = (ok, txt) => `<span class="check ${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x')} ${esc(txt)}</span>`;

  el.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]');
    if (go && !go.disabled) store.set({ screen: go.dataset.go });
    if (e.target.closest('[data-act="refresh"]')) await refreshWorkspace();
  });
  const off = store.subscribe((_s, why) => { if (why === 'ws' || why === 'python') render(); });
  render();
  return off;
}
