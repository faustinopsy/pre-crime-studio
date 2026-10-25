// Mapa interno: o mesmo dashboard que será publicado, servido pelo server/server.js
// a partir da pasta processed (modo "ao vivo"). Nada é exportado.
import { store, call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast } from '../lib/dom.js';

export function mount(el) {
  el.classList.add('flush');
  el.innerHTML = `
    <div class="map-toolbar">
      <b>${icon('map')} Mapa</b>
      <span class="muted" id="map-state">Iniciando o servidor do mapa…</span>
      <span class="spacer"></span>
      <button class="icon-btn" data-act="wide" title="Recolher ou expandir o menu do app para ampliar o mapa">${icon('sidebar')} <span id="wide-lbl"></span></button>
      <button class="icon-btn" data-act="reload" title="Recarregar dados">${icon('refresh')} Recarregar</button>
      <button class="icon-btn" data-act="external" title="Abrir no navegador">${icon('external')} Navegador</button>
    </div>
    <iframe class="map-frame" title="Mapa de risco"></iframe>`;
  const frame = el.querySelector('iframe');
  const state = el.querySelector('#map-state');
  let url = null;

  async function start() {
    try {
      const st = await call('map:start');
      const theme = store.get().settings?.themeResolved || st.theme;
      // vindo da Previsão ou da Validação: abre no mês e na área escolhidos
      const f = store.get().mapFocus;
      const q = new URLSearchParams({ theme });
      if (f?.tag) q.set('tag', f.tag);
      if (f?.area) q.set('area', f.area);
      if (f?.tab) q.set('tab', f.tab);
      if (f) store.set({ mapFocus: null });
      url = `${st.url}?${q}`;
      frame.src = url;
      state.textContent = `127.0.0.1:${st.port} · ${st.dataDir}`;
    } catch (e) {
      state.textContent = 'Servidor do mapa não iniciou';
      frame.replaceWith(Object.assign(document.createElement('div'), {
        className: 'empty', style: 'margin:20px', innerHTML: `Não foi possível abrir o mapa.<br><span class="muted">${esc(e.message)}</span>`,
      }));
    }
  }
  const wideLbl = () => { const l = el.querySelector('#wide-lbl'); if (l) l.textContent = document.body.classList.contains('nav-collapsed') ? 'Mostrar menu' : 'Ampliar mapa'; };
  wideLbl();
  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'wide') { document.querySelector('.topbar [data-act="nav"]')?.click(); setTimeout(wideLbl, 150); }
    if (act === 'reload' && url) frame.src = url.replace(/&t=\d+$/, '') + '&t=' + Date.now();
    if (act === 'external') { try { await call('map:openExternal'); } catch (err) { toast(err.message, 'err'); } }
  });
  start();
  return () => { el.classList.remove('flush'); };
}
