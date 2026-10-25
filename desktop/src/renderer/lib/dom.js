// Utilidades de DOM. Todo texto vindo de dados passa por esc() antes de virar HTML.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Aviso no canto da tela. action: { label, fn } vira um botão dentro do aviso. */
export function toast(msg, kind = 'info', ms = 4500, action = null) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const txt = document.createElement('span');
  txt.textContent = msg;
  el.append(txt);
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => { action.fn(); el.remove(); });
    el.append(b);
  }
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1).replace('.', ',')} ${u[i]}`;
}

export function fmtDate(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour12: false });
}

/** Rola só a área de conteúdo até o elemento (scrollIntoView rolaria a janela inteira). */
export function scrollToEl(el, offset = 70) {
  const sc = document.getElementById('screen');
  if (!sc || !el) return;
  sc.scrollTo({ top: el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - offset, behavior: 'smooth' });
}
