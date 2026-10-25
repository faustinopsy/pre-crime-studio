// Primeira abertura: escolher a pasta de trabalho (só a pasta principal). As pastas de
// cada etapa o app cria sozinho, depois que as planilhas forem importadas.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast } from '../lib/dom.js';
import { applySettings } from '../app.js';

const KIND_ICON = { new: 'folder', empty: 'folder', workspace: 'check', legacy: 'check', other: 'folder', error: 'x' };

/** Bloco reutilizado pela tela de boas-vindas e pelas Configurações. */
export function workspacePicker(el, { onDone, title = 'Pasta de trabalho', intro = '' }) {
  let candidate = null;
  const render = () => {
    el.innerHTML = `
      <div class="card ws-picker">
        <h2>${icon('folder')} ${esc(title)}</h2>
        ${intro ? `<p class="muted" style="margin-bottom:12px">${intro}</p>` : ''}
        ${candidate ? `<div class="ws-cand" data-kind="${candidate.kind}">
            ${icon(KIND_ICON[candidate.kind] || 'folder')}
            <div><div class="mono">${esc(candidate.dir)}</div><div class="muted">${esc(candidate.note)}</div></div>
          </div>` : '<p class="muted">Carregando sugestão…</p>'}
        <div class="btn-row" style="margin-top:14px">
          <button class="btn primary" data-act="use" ${!candidate || candidate.kind === 'error' ? 'disabled' : ''}>${icon('check')} Usar esta pasta</button>
          <button class="btn" data-act="browse">${icon('folder')} Escolher outra pasta…</button>
        </div>
        <div class="setup-log muted" id="setup-log"></div>
      </div>`;
  };
  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'browse') {
      const c = await call('workspace:browse').catch((err) => toast(err.message, 'err'));
      if (c) { candidate = c; render(); }
    }
    if (act === 'use' && candidate) {
      el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const logEl = el.querySelector('#setup-log');
      logEl.textContent = 'Preparando a pasta…';
      const off = window.pc.on('workspace:progress', (p) => { logEl.textContent = p.msg; });
      try {
        const r = await call('workspace:setup', candidate.dir);
        await applySettings(await call('settings:get'));
        await refreshWorkspace();
        toast('Pasta de trabalho selecionada. Agora importe as planilhas da SSP.', 'ok');
        onDone?.(r);
      } catch (err) { toast(err.message, 'err', 8000); render(); }
      finally { off(); }
    }
  });
  call('workspace:suggest').then((c) => { candidate = c; render(); }).catch(() => render());
  render();
}

export function mount(el) {
  el.innerHTML = `
    <div class="welcome">
      <div class="welcome-head">
        <img class="brand-mark big" src="assets/logo-full.svg" alt="">
        <h1>Bem-vindo ao Pre-Crime Studio</h1>
        <p class="muted">Antes de começar, escolha onde o app vai guardar o trabalho: as planilhas da SSP que você importar,
        os modelos treinados, as previsões e os pacotes de publicação. Pode ser uma pasta nova ou uma pasta de dados do Pre-Crime que você já tenha.</p>
      </div>
      <div id="picker"></div>
      <div class="cards welcome-steps">
        <div class="card"><h2>1 · Pasta de trabalho</h2><p class="muted">Você escolhe só esta pasta. Nenhuma outra pasta é pedida depois.</p></div>
        <div class="card"><h2>2 · Planilhas da SSP</h2><p class="muted">Você importa os arquivos ou a pasta onde eles estão. Em seguida o app cria as pastas de cada etapa.</p></div>
        <div class="card"><h2>3 · Processar</h2><p class="muted">Limpeza, filtragem, treino, previsão e validação, uma fase por vez.</p></div>
      </div>
    </div>`;
  workspacePicker(el.querySelector('#picker'), {
    title: 'Onde guardar',
    onDone: () => store.set({ screen: 'ssp' }),
  });
}
