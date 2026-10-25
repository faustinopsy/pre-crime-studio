// Configurações: pasta de trabalho, tema e tamanho da interface.
import { store, call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast } from '../lib/dom.js';
import { applySettings } from '../app.js';
import { workspacePicker } from './welcome.js';
import { confirmar } from '../lib/dialog.js';
import { RESTAURAR } from '../lib/padrao.js';

export function mount(el) {
  const s = store.get().settings || {};
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('settings')} Configurações</h1>
      <p>Onde o app guarda o trabalho e como ele aparece.</p></div></div>
    <div class="card">
      <h2>${icon('folder')} Pasta de trabalho atual</h2>
      <dl class="kv"><dt>Local</dt><dd class="mono">${esc(s.dataDir || '—')}</dd></dl>
      <div class="btn-row" style="margin-top:12px"><button class="btn" data-act="open">${icon('folder')} Abrir no Explorer</button></div>
    </div>
    <div class="card" id="defaults"><h2>${icon('undo')} Padrão da dissertação</h2><div class="empty">Conferindo…</div></div>
    <div id="picker"></div>
    <div class="card">
      <h2>Aparência</h2>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
        <div><div class="muted" style="font-size:12px;margin-bottom:6px">Tema</div>
          <div class="seg" role="group" aria-label="Tema" id="theme"></div></div>
        <div><div class="muted" style="font-size:12px;margin-bottom:6px">Tamanho da interface: <b id="zv">${Math.round((s.zoom || 1) * 100)}%</b></div>
          <input type="range" min="0.8" max="1.5" step="0.05" value="${s.zoom || 1}" id="zoom" aria-label="Tamanho da interface"></div>
      </div>
    </div>`;

  const drawTheme = () => {
    const t = store.get().settings?.theme;
    el.querySelector('#theme').innerHTML = [['system', 'Sistema'], ['dark', 'Escuro'], ['light', 'Claro']]
      .map(([v, l]) => `<button data-theme="${v}" class="${t === v ? 'on' : ''}">${l}</button>`).join('');
  };
  drawTheme();

  // "Restaurar tudo ao padrão da dissertação", com a lista do que vai mudar
  let resumo = null;
  async function drawDefaults() {
    const box = el.querySelector('#defaults');
    if (!s.dataDir) { box.hidden = true; return; }
    try { resumo = await call('defaults:summary'); } catch (err) { box.innerHTML = `<h2>${icon('undo')} Padrão da dissertação</h2><p class="muted">${esc(err.message)}</p>`; return; }
    box.innerHTML = `<h2>${icon('undo')} Padrão da dissertação</h2>
      ${resumo.padrao ? `<p><span class="selo-padrao">${icon('check')} padrão da dissertação</span> Todos os parâmetros desta pasta de trabalho são os usados na dissertação.</p>`
        : `<p>Diferente da dissertação nesta pasta de trabalho:</p>
          <ul class="restore-list">${resumo.itens.map((i) => `<li><b>${esc(i.tela)}</b>: ${esc(i.o.join(', '))} <button class="link-btn" data-go="${esc(i.screen)}">abrir</button></li>`).join('')}</ul>`}
      <p class="muted small" style="margin-top:8px">Volta Limpeza, Filtragem, Features, Treino (parâmetros e semente) e Mapa de risco aos valores da dissertação. Não apaga dados, modelos nem previsões: rode as fases de novo para os resultados seguirem os valores restaurados.</p>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="restore-all" ${resumo.padrao ? 'disabled' : ''}>${icon('undo')} Restaurar tudo ao padrão da dissertação</button></div>`;
  }
  drawDefaults();

  workspacePicker(el.querySelector('#picker'), {
    title: 'Trocar a pasta de trabalho',
    intro: 'Escolha uma pasta nova ou outra pasta de trabalho que você já tenha. O app cria as pastas de cada etapa sozinho. Nada é apagado da pasta atual.',
    onDone: () => store.set({ screen: 'home' }),
  });

  el.addEventListener('click', async (e) => {
    const theme = e.target.closest('[data-theme]')?.dataset.theme;
    try {
      if (theme) { await applySettings(await call('settings:set', { theme })); drawTheme(); }
      if (e.target.closest('[data-act="open"]')) await call('workspace:open', '');
      if (e.target.closest('[data-act="restore-all"]') && resumo && !resumo.padrao) {
        const lista = resumo.itens.map((i) => `${i.tela} (${i.o.join(', ')})`).join('; ');
        if (!(await confirmar(`${RESTAURAR}: tudo?`, { detalhe: `Vai mudar: ${lista}. Dados, modelos e previsões ficam como estão.`, ok: 'Restaurar tudo', cancelar: 'Voltar' }))) return;
        await call('defaults:restoreAll');
        toast('Tudo de volta ao padrão da dissertação.', 'ok', 8000);
        drawDefaults();
      }
    } catch (err) { toast(err.message, 'err'); }
  });
  el.addEventListener('change', async (e) => {
    if (e.target.id === 'zoom') await applySettings(await call('settings:set', { zoom: Number(e.target.value) }));
  });
  el.addEventListener('input', (e) => { if (e.target.id === 'zoom') el.querySelector('#zv').textContent = `${Math.round(e.target.value * 100)}%`; });
}
