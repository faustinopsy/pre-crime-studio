// Padrão da dissertação: as mesmas peças em todas as telas.
//   selo "padrão da dissertação" quando o valor é o da dissertação;
//   "padrão: X" e um ponto de aviso quando o operador mudou;
//   botão "Restaurar padrão da dissertação" (ícone undo) com a mesma confirmação;
//   selo "configuração personalizada" nas telas de resultado (Validação, Publicação, Modo científico).
import { icon } from './icons.js';
import { esc } from './dom.js';
import { confirmar } from './dialog.js';

export const RESTAURAR = 'Restaurar padrão da dissertação';

export const seloPadrao = () => `<span class="selo-padrao">${icon('check')} padrão da dissertação</span>`;

export const padraoAoLado = (txt, attrs = '') =>
  `<span class="padrao-lado"><i class="pdot" title="Diferente do padrão da dissertação"></i>padrão: <b>${esc(txt)}</b>${attrs ? ` <button class="link-btn" ${attrs}>${icon('undo')} voltar</button>` : ''}</span>`;

/** Selo do campo: o padrão (igual) ou "padrão: X" (diferente). */
export const seloCampo = (igual, txtPadrao, attrs = '') => (igual ? seloPadrao() : padraoAoLado(txtPadrao, attrs));

export const botaoRestaurar = (attrs, { disabled = false, label = RESTAURAR } = {}) =>
  `<button class="btn" ${attrs} ${disabled ? 'disabled' : ''}>${icon('undo')} ${esc(label)}</button>`;

/** A mesma confirmação em todas as telas. oQue: "Os parâmetros da Limpeza" etc. */
export const confirmarRestaurar = (oQue, extra = '') => confirmar(`${RESTAURAR}?`, {
  detalhe: `${oQue} volta${/s$/.test(oQue.split(' ')[0]) ? 'm' : ''} aos valores usados na dissertação.${extra ? ` ${extra}` : ''}`,
  ok: 'Restaurar', cancelar: 'Voltar',
});

/** Selo das telas de resultado. itens: lista de textos curtos ("área de cobertura", …). */
export const seloPersonalizado = (itens) => (itens && itens.length
  ? `<span class="pill sel-pers" data-status="partial" title="${esc(`Diferente do padrão da dissertação: ${itens.join(', ')}`)}">${icon('settings')} configuração personalizada</span>`
  : '');
