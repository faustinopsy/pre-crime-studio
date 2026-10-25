// Gaveta de log no rodapé: última linha sempre visível; abre ao clicar ou em caso de erro.
import { icon } from '../lib/icons.js';
import { esc, fmtTime } from '../lib/dom.js';
import { call } from '../lib/store.js';

const MAX = 600;
export const LOG = { entries: [], listeners: new Set() };

export function logLineHtml(e) {
  return `<div class="logline" data-level="${esc(e.level)}"><span class="num">${fmtTime(e.ts)}</span><span class="lv">${esc(e.level.toUpperCase())}</span><span class="scope" title="${esc(e.scope)}">${esc(e.scope)}</span><span class="msg">${esc(e.msg)}${e.extra ? ' ' + esc(e.extra) : ''}</span></div>`;
}

function push(e) {
  LOG.entries.push(e);
  if (LOG.entries.length > MAX) LOG.entries.splice(0, LOG.entries.length - MAX);
  for (const fn of LOG.listeners) fn(e);
}

export async function initLog() {
  try { for (const e of await call('logs:recent', 300)) push(e); } catch { /* sem log ainda */ }
  window.pc.on('log:entry', push);
}

class PcLogDrawer extends HTMLElement {
  #errors = 0;
  connectedCallback() {
    this.innerHTML = `
      <div class="drawer-head">
        <button class="toggle" aria-expanded="false">${icon('up')} LOG</button>
        <span class="badge-err" hidden></span>
        <span class="last"></span>
      </div>
      <div class="drawer-body loglist" role="log"></div>`;
    this.body = this.querySelector('.drawer-body');
    this.last = this.querySelector('.last');
    this.badge = this.querySelector('.badge-err');
    this.btn = this.querySelector('.toggle');
    this.btn.addEventListener('click', () => this.toggle());
    for (const e of LOG.entries.slice(-200)) this.add(e, false);
    LOG.listeners.add((e) => this.add(e, true));
  }
  toggle(force) {
    const open = force ?? !this.hasAttribute('open');
    this.toggleAttribute('open', open);
    this.btn.setAttribute('aria-expanded', String(open));
    this.btn.innerHTML = `${icon(open ? 'down' : 'up')} LOG`;
    if (open) { this.#errors = 0; this.badge.hidden = true; this.body.scrollTop = this.body.scrollHeight; }
  }
  add(e, live) {
    this.body.insertAdjacentHTML('beforeend', logLineHtml(e));
    while (this.body.childElementCount > 400) this.body.firstElementChild.remove();
    this.last.textContent = `${fmtTime(e.ts)}  ${e.msg}`;
    if (live && e.level === 'error' && !this.hasAttribute('open')) {
      this.#errors++; this.badge.hidden = false; this.badge.textContent = `${this.#errors} erro(s)`;
    }
    if (this.hasAttribute('open')) this.body.scrollTop = this.body.scrollHeight;
  }
}
customElements.define('pc-log-drawer', PcLogDrawer);
