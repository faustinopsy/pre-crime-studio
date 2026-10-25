// Linha "padrão da dissertação" no topo das telas de parâmetros (Limpeza, Filtragem, Features):
// diz se os valores salvos são os da dissertação ou o que está diferente.
import { store, call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc } from '../lib/dom.js';

export function mountPadraoLine(box, screen) {
  async function render() {
    let s = null;
    try { s = await call('defaults:summary'); } catch { box.innerHTML = ''; return; }
    const it = s.itens.find((i) => i.screen === screen);
    box.innerHTML = it
      ? `<div class="dev-line">${icon('warn')}<span><i class="pdot"></i> Diferente do padrão da dissertação: <b>${esc(it.o.join(', '))}</b>. O botão <b>Restaurar padrão da dissertação</b> volta tudo desta tela.</span></div>`
      : `<div class="dev-line"><span class="selo-padrao">${icon('check')} padrão da dissertação</span><span class="muted">Os valores salvos desta tela são os usados na dissertação.</span></div>`;
  }
  const off = store.subscribe((_s, why) => { if (why === 'ws') render(); });
  render();
  return { refresh: render, unmount: off };
}
