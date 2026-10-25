// Andamento de uma sequência (ciclo mensal ou modo científico): passos, execuções de cada passo,
// tempo e o que está rodando agora. Usado pelas telas Ciclo mensal e Modo científico.
import { call } from '../lib/store.js';
import { areaLabel } from './run-panel.js';
import { confirmar } from '../lib/dialog.js';
import { icon } from '../lib/icons.js';
import { esc, toast, fmtDate } from '../lib/dom.js';
import { fmtSecs } from './run-panel.js';

const ST = {
  pending: ['Aguardando', 'pending', ''], running: ['Executando', 'running', ''], done: ['Concluído', 'done', 'check'],
  skipped: ['Pulado', 'pending', ''], error: ['Falhou', 'error', 'x'], cancelled: ['Cancelado', 'stale', 'x'],
};
const REC = { running: ['Em andamento', 'running'], ok: ['Concluída', 'done'], error: ['Parou com erro', 'error'], cancelled: ['Cancelada', 'stale'], interrupted: ['Interrompida', 'stale'] };
const JOB_SCREEN = { clean: 'clean', filter: 'filter', features: 'features', train: 'train', predict: 'predict', validate: 'validate' };
const monthLabel = (m) => (m ? m.split(/[-_]/).reverse().join('/') : '');

export function totalSecs(steps) { return steps.filter((s) => !s.skip).reduce((a, s) => a + (s.secs || 0), 0); }
export function estTxt(secs) { return secs ? `~${fmtSecs(secs)}` : 'sem estimativa'; }

/**
 * Monta o acompanhamento em `el`. kind: 'ciclo' | 'replay'. onEnd(rec) quando a sequência termina.
 * Devolve { show(rec), unmount() }.
 */
export function mountSeqView(el, kind, { onEnd } = {}) {
  let rec = null;
  let lastLine = '';
  let timer = null;

  function render() {
    if (!rec) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const [lbl, st] = REC[rec.status] || REC.running;
    const done = rec.steps.filter((s) => ['done', 'skipped'].includes(s.status)).length;
    const total = rec.steps.length;
    const secs = rec.secs ?? (Date.now() - Date.parse(rec.startedAt)) / 1000;
    el.innerHTML = `<h2>${esc(rec.title)} <span class="pill" data-status="${st}">${esc(lbl)}</span>
        <span class="spacer"></span><span class="num seq-time">${fmtSecs(secs)}</span></h2>
      <p class="muted" style="margin-bottom:10px">Iniciada em ${esc(fmtDate(Date.parse(rec.startedAt)))} · ${done} de ${total} passos${rec.status === 'running' && lastLine ? ` · <span class="mono">${esc(lastLine.slice(0, 140))}</span>` : ''}</p>
      ${rec.status === 'running' ? `<div class="prog-track busy"><i style="width:${Math.max(3, Math.round((done / total) * 100))}%"></i></div>` : ''}
      <ol class="seq-steps">${rec.steps.map((s) => {
        const [sl, ss, si] = ST[s.status] || ST.pending;
        const runs = s.runs?.length ? `<span class="seq-runs">${s.runs.map((r) => `<span class="tag-chip ${r.status === 'ok' ? 'on' : ''}" title="${esc(r.runId)}">${r.mes ? esc(monthLabel(r.mes)) : r.area ? esc(areaLabel(r.area)) : 'execução'}${r.secs ? ` · ${fmtSecs(r.secs)}` : ''}</span>`).join('')}</span>` : '';
        return `<li data-state="${s.status}"><span class="dotc">${si ? icon(si) : s.status === 'running' ? '<i class="spin"></i>' : ''}</span>
          <div><b>${esc(s.label)}</b> <span class="pill" data-status="${ss}">${esc(sl)}</span>
            ${s.kind === 'job' && JOB_SCREEN[s.job] && s.runs?.length ? `<button class="link-btn" data-go="${JOB_SCREEN[s.job]}">ver</button>` : ''}
            ${runs}
            ${s.detail ? `<span class="muted seq-detail">${esc(s.detail)}</span>` : ''}</div></li>`;
      }).join('')}</ol>
      <div class="btn-row" style="margin-top:12px">
        ${rec.status === 'running' ? `<button class="btn" data-seq="cancel">${icon('x')} Cancelar a sequência</button>` : ''}
        ${rec.status !== 'running' && rec.steps.some((s) => s.internal === 'publishCycle' && s.status === 'done') ? `<button class="btn primary" data-go="publish">${icon('publish')} Pré-visualizar e exportar o pacote</button>` : ''}
      </div>
      <p class="note">Registro em <span class="mono">runs\\_sequencias\\${esc(rec.id)}.json</span>, com o identificador de cada execução (cada uma tem o seu manifesto em <span class="mono">runs</span>).</p>`;
  }

  const offSeq = window.pc.on('seq:event', (r) => {
    if (r.kind !== kind) return;
    const wasRunning = rec?.status === 'running';
    rec = r;
    render();
    if (wasRunning && r.status !== 'running') onEnd?.(r);
  });
  const offRun = window.pc.on('run:event', (p) => {
    if (rec?.status !== 'running') return;
    if (p.t === 'lines' && p.lines?.length) {
      const l = [...p.lines].reverse().find((x) => x.level !== 'debug' && x.text.trim());
      if (l) { lastLine = l.text.trim(); render(); }
    }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-seq="cancel"]') && await confirmar('Cancelar a sequência?', { detalhe: 'A execução em andamento é interrompida e os passos seguintes não rodam.', ok: 'Cancelar a sequência', cancelar: 'Continuar', perigo: true })) {
      try { await call('seq:cancel'); } catch (err) { toast(err.message, 'err'); }
    }
  });
  timer = setInterval(() => { const t = el.querySelector('.seq-time'); if (t && rec?.status === 'running') t.textContent = fmtSecs((Date.now() - Date.parse(rec.startedAt)) / 1000); }, 1000);

  return {
    show(r) { rec = r; render(); },
    current: () => rec,
    unmount() { offSeq(); offRun(); clearInterval(timer); },
  };
}

/** Tabela das sequências anteriores de um tipo. */
export function seqHistoryHtml(list, kind) {
  const rows = list.filter((r) => r.kind === kind);
  if (!rows.length) return '<div class="empty">Nenhuma ainda.</div>';
  return `<table class="tbl"><thead><tr><th>Início</th><th>Sequência</th><th>Situação</th><th class="r">Passos</th><th class="r">Duração</th></tr></thead>
    <tbody>${rows.map((r) => {
      const [lbl, st] = REC[r.status] || REC.running;
      const tags = kind === 'replay' ? [r.params?.malha ? `malha ${r.params.malha}` : null, r.params?.padraoDissertacao === false ? 'configuração personalizada' : null, r.params?.vazamento ? 'com comparação de vazamento' : null].filter(Boolean) : [];
      return `<tr data-seq-show="${esc(r.id)}"><td>${esc(fmtDate(Date.parse(r.startedAt)))}</td><td>${esc(r.title)}${tags.map((t) => ` <span class="tag-chip">${esc(t)}</span>`).join('')}</td>
        <td><span class="pill" data-status="${st}">${esc(lbl)}</span></td>
        <td class="r num">${r.steps.filter((s) => s.status === 'done').length}/${r.steps.length}</td>
        <td class="r num">${r.secs ? fmtSecs(r.secs) : '—'}</td></tr>`;
    }).join('')}</tbody></table>`;
}
