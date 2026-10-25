// Caixa de confirmação do próprio app, no lugar do confirm() nativo.
// No Windows, depois de um confirm()/alert() nativo, o Electron deixa campos e listas da página
// sem receber o foco até a janela perder e ganhar o foco de novo (os selects "travam").
import { esc } from './dom.js';
import { icon } from './icons.js';

/**
 * confirmar('Cancelar a execução?', { detalhe, ok: 'Cancelar execução', cancelar: 'Voltar', perigo: true })
 * → Promise<boolean>. Enter confirma, Esc fecha.
 */
export function confirmar(msg, { detalhe = '', ok = 'Confirmar', cancelar = 'Voltar', perigo = false } = {}) {
  return new Promise((resolve) => {
    const antes = document.activeElement;
    const fundo = document.createElement('div');
    fundo.className = 'dlg-fundo';
    fundo.innerHTML = `<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
        <div class="dlg-ico ${perigo ? 'perigo' : ''}">${icon(perigo ? 'warn' : 'info')}</div>
        <div class="dlg-corpo">
          <p class="dlg-t" id="dlg-t">${esc(msg)}</p>
          ${detalhe ? `<p class="dlg-d">${esc(detalhe)}</p>` : ''}
          <div class="dlg-acoes">
            <button class="btn" data-dlg="0">${esc(cancelar)}</button>
            <button class="btn ${perigo ? 'danger' : 'primary'}" data-dlg="1">${esc(ok)}</button>
          </div>
        </div>
      </div>`;
    document.body.append(fundo);
    const botoes = [...fundo.querySelectorAll('[data-dlg]')];
    botoes[1].focus();
    const fechar = (v) => {
      document.removeEventListener('keydown', tecla, true);
      fundo.remove();
      try { antes?.focus?.(); } catch { /* elemento saiu da tela */ }
      resolve(v);
    };
    const tecla = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(false); }
      if (e.key === 'Tab') { // foco preso na caixa
        e.preventDefault();
        const i = botoes.indexOf(document.activeElement);
        botoes[(i + (e.shiftKey ? botoes.length - 1 : 1)) % botoes.length].focus();
      }
    };
    document.addEventListener('keydown', tecla, true);
    fundo.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]');
      if (b) fechar(b.dataset.dlg === '1');
      else if (e.target === fundo) fechar(false);
    });
  });
}
