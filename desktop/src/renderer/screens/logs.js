// Log completo do sistema com filtro por nível e busca.
import { call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { LOG, logLineHtml } from '../components/pc-log-drawer.js';
import { toast } from '../lib/dom.js';

const ORDER = { debug: 10, info: 20, ok: 25, warn: 30, error: 40 };

export function mount(el) {
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('logs')} Logs</h1>
      <p>Tudo o que o app e o pipeline registraram. Os arquivos ficam em UTF-8, um por dia.</p></div>
      <button class="btn" data-act="dir">${icon('folder')} Abrir pasta dos logs</button></div>
    <div class="toolbar">
      <select id="lv" aria-label="Nível mínimo">
        <option value="debug">Tudo</option><option value="info" selected>Informação e acima</option>
        <option value="warn">Avisos e erros</option><option value="error">Só erros</option>
      </select>
      <input type="search" id="q" placeholder="Buscar no log" aria-label="Buscar no log">
      <span class="muted" id="count"></span>
    </div>
    <div class="card loglist" style="padding:0" id="list" role="log"></div>`;
  const list = el.querySelector('#list'), lv = el.querySelector('#lv'), q = el.querySelector('#q'), count = el.querySelector('#count');

  const pass = (e) => ORDER[e.level] >= ORDER[lv.value] && (!q.value || `${e.scope} ${e.msg}`.toLowerCase().includes(q.value.toLowerCase()));
  const render = () => {
    const rows = LOG.entries.filter(pass);
    list.innerHTML = rows.length ? rows.map(logLineHtml).join('') : '<div class="empty" style="border:0">Nada para mostrar com esse filtro.</div>';
    count.textContent = `${rows.length} linha(s)`;
  };
  const onNew = (e) => { if (pass(e)) { list.querySelector('.empty')?.remove(); list.insertAdjacentHTML('beforeend', logLineHtml(e)); } };
  lv.addEventListener('change', render);
  q.addEventListener('input', render);
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="dir"]')) { try { await call('logs:openDir'); } catch (err) { toast(err.message, 'err'); } }
  });
  LOG.listeners.add(onNew);
  render();
  return () => LOG.listeners.delete(onNew);
}
