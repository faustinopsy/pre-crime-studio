// Execuções: todas as execuções registradas em runs/, com filtro, "Verificar" e a comparação
// lado a lado de duas execuções da mesma fase (parâmetros que mudaram e diferença das métricas).
import { call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast, fmtDate, scrollToEl } from '../lib/dom.js';
import { fmtSecs, areaLabel } from '../components/run-panel.js';

const JOBS = [['', 'Todas as fases'], ['clean', 'Limpeza'], ['filter', 'Filtragem'], ['features', 'Features'], ['train', 'Treino'], ['predict', 'Previsão'], ['validate', 'Validação']];
const LABEL = Object.fromEntries(JOBS);
const STATE = { ok: ['Concluída', 'done'], error: ['Falhou', 'error'], cancelled: ['Cancelada', 'stale'], interrupted: ['Interrompida', 'stale'], running: ['Executando', 'running'] };
const runIdDate = (id) => { const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(id || ''); return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
const nf = (v, d = 4) => (typeof v === 'number' ? v.toLocaleString('pt-BR', { maximumFractionDigits: d }) : v == null ? '—' : String(v));

/** Achata um objeto em { 'a.b.c': valor } (só valores simples; listas curtas viram texto). */
function flatten(obj, pre = '', out = {}) {
  if (obj == null) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = pre ? `${pre} › ${k}` : k;
    if (Array.isArray(v)) { if (v.length <= 6 && v.every((x) => typeof x !== 'object')) out[p] = v.join(', '); else out[p] = `${v.length} valores`; }
    else if (v && typeof v === 'object') flatten(v, p, out);
    else out[p] = v;
  }
  return out;
}

export function mount(el) {
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('runs')} Execuções</h1>
      <p>Cada execução do pipeline fica registrada em <span class="mono">runs</span> com os parâmetros, as versões, os arquivos de entrada e o sha256 dos arquivos gerados. Marque duas execuções da mesma fase para comparar.</p></div></div>
    <section class="card" id="r-list"></section>
    <section class="card" id="r-cmp" hidden></section>`;
  const $ = (s) => el.querySelector(s);
  let job = '';
  let list = [];
  const sel = new Set();

  async function load() {
    try { list = await call('run:list', job || undefined, 80); } catch (e) { $('#r-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    render();
  }
  function render() {
    const picked = list.filter((m) => sel.has(m.runId));
    const same = picked.length === 2 && picked[0].job === picked[1].job;
    $('#r-list').innerHTML = `<h2>Registro <span class="spacer"></span>
        <label class="field inline">Fase<select id="r-job">${JOBS.map(([k, l]) => `<option value="${k}" ${k === job ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn sm primary" data-act="compare" ${same ? '' : 'disabled'} title="${same ? '' : 'Marque duas execuções da mesma fase'}">${icon('compare')} Comparar</button></h2>
      ${!list.length ? '<div class="empty">Nenhuma execução registrada.</div>' : `
      <table class="tbl runs-tbl"><thead><tr><th></th><th>Início</th><th>Fase</th><th>Situação</th><th>Detalhe</th><th class="r">Duração</th><th></th></tr></thead>
      <tbody>${list.map((m) => {
        const [l, st] = STATE[m.status] || ['—', 'pending'];
        const o = m.options || {};
        const det = [m.area ? areaLabel(m.area) : (m.job !== 'clean' ? 'todas as áreas' : ''), o.mes && `mês ${o.mes.split('-').reverse().join('/')}`,
          o.dataEnd && `dados até ${o.dataEnd.split('-').reverse().join('/')}`, o.seed != null && `semente ${o.seed}`, o.modo, o.completo && 'completo',
          o.sequencia && (o.sequencia.id.endsWith('_replay') ? 'replay' : 'ciclo mensal')].filter(Boolean).join(' · ');
        return `<tr class="${sel.has(m.runId) ? 'sel' : ''}"><td><input type="checkbox" data-pick="${esc(m.runId)}" ${sel.has(m.runId) ? 'checked' : ''} ${m.status === 'interrupted' ? 'disabled' : ''} aria-label="Marcar para comparar"></td>
          <td>${esc(fmtDate(m.startedAt ? Date.parse(m.startedAt) : runIdDate(m.runId)))}</td><td><b>${esc(LABEL[m.job] || m.job)}</b></td>
          <td><span class="pill" data-status="${st}">${esc(l)}</span></td><td class="muted">${esc(det)}${m.error?.msg ? `<br><span style="color:var(--err)">${esc(m.error.msg.slice(0, 120))}</span>` : ''}</td>
          <td class="r num">${m.secs != null ? fmtSecs(m.secs) : '—'}</td>
          <td class="r nowrap">${m.status === 'ok' ? `<button class="btn sm" data-verify="${esc(m.runId)}" title="Confere se os arquivos gerados ainda são os mesmos">${icon('validate')}</button>` : ''}
            <button class="btn sm" data-openrun="${esc(m.runId)}" title="Abrir a pasta">${icon('folder')}</button><span class="vr" id="vr-${esc(m.runId)}"></span></td></tr>`;
      }).join('')}</tbody></table>`}`;
  }

  async function compare() {
    const [a, b] = list.filter((m) => sel.has(m.runId)).sort((x, y) => x.runId.localeCompare(y.runId));
    const [A, B] = await Promise.all([call('run:get', a.runId), call('run:get', b.runId)]);
    const ma = A.manifest || {}, mb = B.manifest || {};
    const pa = flatten({ opções: ma.options, parâmetros: ma.params, área: ma.area || 'todas' }), pb = flatten({ opções: mb.options, parâmetros: mb.params, área: mb.area || 'todas' });
    const ea = flatten({ python: ma.env?.python, pacotes: ma.env?.packages, cuda: ma.env?.torchCuda, app: ma.app?.version }), eb = flatten({ python: mb.env?.python, pacotes: mb.env?.packages, cuda: mb.env?.torchCuda, app: mb.app?.version });
    const diffRows = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().filter((k) => String(x[k]) !== String(y[k]));
    const params = diffRows(pa, pb), env = diffRows(ea, eb);
    const files = (m, k) => Object.fromEntries((m[k] || []).map((f) => [f.path, f]));
    const ia = files(ma, 'inputs'), ib = files(mb, 'inputs'), oa = files(ma, 'outputs'), ob = files(mb, 'outputs');
    const fdiff = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().map((p) => {
      const u = x[p], v = y[p];
      const st = !u ? 'só na B' : !v ? 'só na A' : u.sha256 && v.sha256 ? (u.sha256 === v.sha256 ? 'igual' : 'mudou') : u.bytes === v.bytes && u.mtime === v.mtime ? 'igual' : 'mudou';
      return { p, st, a: u, b: v };
    });
    const ins = fdiff(ia, ib), outs = fdiff(oa, ob);
    const metA = flatten(ma.metrics || {}), metB = flatten(mb.metrics || {});
    const mkeys = [...new Set([...Object.keys(metA), ...Object.keys(metB)])].filter((k) => !/^(curves|active|plan › config)/.test(k)).sort();
    const delta = (x, y) => (typeof x === 'number' && typeof y === 'number' ? y - x : null);
    const box = $('#r-cmp');
    box.hidden = false;
    const fileTable = (rows, title) => `<details class="pk" ${rows.some((r) => r.st !== 'igual') ? 'open' : ''}><summary>${title}: ${rows.filter((r) => r.st !== 'igual').length} de ${rows.length} diferentes</summary>
      <table class="tbl"><tbody>${rows.map((r) => `<tr class="${r.st === 'igual' ? '' : 'chg'}"><td class="mono small">${esc(r.p)}</td><td>${esc(r.st)}</td>
        <td class="mono small">${esc(r.a?.sha256?.slice(0, 12) || (r.a ? `${r.a.bytes} B` : '—'))}</td><td class="mono small">${esc(r.b?.sha256?.slice(0, 12) || (r.b ? `${r.b.bytes} B` : '—'))}</td></tr>`).join('')}</tbody></table></details>`;
    box.innerHTML = `<h2>${icon('compare')} Comparação · ${esc(LABEL[ma.job] || ma.job)} <span class="spacer"></span><button class="btn sm" data-act="close-cmp">${icon('x')} Fechar</button></h2>
      <table class="tbl cmp-head"><thead><tr><th></th><th>A</th><th>B</th></tr></thead><tbody>
        <tr><td>Execução</td><td class="mono small">${esc(ma.runId)}</td><td class="mono small">${esc(mb.runId)}</td></tr>
        <tr><td>Situação</td><td>${esc(ma.status)}</td><td>${esc(mb.status)}</td></tr>
        <tr><td>Duração</td><td class="num">${ma.secs != null ? fmtSecs(ma.secs) : '—'}</td><td class="num">${mb.secs != null ? fmtSecs(mb.secs) : '—'}</td></tr>
      </tbody></table>
      <h3 class="cmp-sub">Parâmetros que mudaram</h3>
      ${params.length ? `<table class="tbl"><tbody>${params.map((k) => `<tr class="chg"><td>${esc(k)}</td><td class="mono small">${esc(nf(pa[k]))}</td><td class="mono small">${esc(nf(pb[k]))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Os mesmos parâmetros.</p>'}
      ${env.length ? `<h3 class="cmp-sub">Ambiente que mudou</h3><table class="tbl"><tbody>${env.map((k) => `<tr class="chg"><td>${esc(k)}</td><td class="mono small">${esc(nf(ea[k]))}</td><td class="mono small">${esc(nf(eb[k]))}</td></tr>`).join('')}</tbody></table>` : ''}
      <h3 class="cmp-sub">Arquivos</h3>
      ${fileTable(ins, 'Entradas')}${fileTable(outs, 'Saídas')}
      <h3 class="cmp-sub">Métricas</h3>
      ${mkeys.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Métrica</th><th class="r">A</th><th class="r">B</th><th class="r">B − A</th></tr></thead><tbody>${mkeys.map((k) => {
        const d = delta(metA[k], metB[k]);
        const same = String(metA[k]) === String(metB[k]);
        return `<tr class="${same ? '' : 'chg'}"><td>${esc(k)}</td><td class="r num">${esc(nf(metA[k]))}</td><td class="r num">${esc(nf(metB[k]))}</td>
          <td class="r num ${d > 0 ? 'up' : d < 0 ? 'down' : ''}">${d == null || d === 0 ? '' : (d > 0 ? '+' : '') + nf(d)}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">Sem métricas registradas.</p>'}`;
    scrollToEl(box);
  }

  el.addEventListener('change', (e) => {
    if (e.target.id === 'r-job') { job = e.target.value; sel.clear(); load(); return; }
    const p = e.target.dataset?.pick;
    if (p) { if (e.target.checked) { sel.add(p); while (sel.size > 2) sel.delete(sel.values().next().value); } else sel.delete(p); render(); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="compare"]')) { try { await compare(); } catch (err) { toast(err.message, 'err'); } return; }
    if (e.target.closest('[data-act="close-cmp"]')) { $('#r-cmp').hidden = true; return; }
    const o = e.target.closest('[data-openrun]');
    if (o) { call('run:open', o.dataset.openrun).catch((err) => toast(err.message, 'err')); return; }
    const v = e.target.closest('[data-verify]');
    if (v) {
      v.disabled = true;
      try {
        const r = await call('run:verify', v.dataset.verify);
        const span = el.querySelector(`#vr-${CSS.escape(v.dataset.verify)}`);
        if (span) span.innerHTML = r.ok ? ` <span class="pill" data-status="done">${icon('check')}íntegro</span>` : ` <span class="pill" data-status="error">${r.files.filter((f) => f.state !== 'ok').length} mudou</span>`;
      } catch (err) { toast(err.message, 'err'); }
      v.disabled = false;
    }
  });
  load();
}
