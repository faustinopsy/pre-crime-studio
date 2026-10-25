// Trilha das fases do pipeline com estado de cada uma (padrão fb-stepper do FastStudio).
import { store, envStatus } from '../lib/store.js';
import { icon, STATUS_ICON, STATUS_LABEL } from '../lib/icons.js';
import { esc } from '../lib/dom.js';
import { PHASE_INFO, PIPELINE_ORDER } from '../lib/phases.js';

class PcStepper extends HTMLElement {
  #off = null;
  connectedCallback() {
    this.setAttribute('role', 'navigation');
    this.setAttribute('aria-label', 'Fases do pipeline');
    this.#off = store.subscribe(() => this.render());
    this.addEventListener('click', (e) => {
      const b = e.target.closest('[data-screen]');
      if (b) store.set({ screen: b.dataset.screen });
    });
    this.render();
  }
  disconnectedCallback() { this.#off?.(); }

  render() {
    const { ws, screen } = store.get();
    const by = Object.fromEntries((ws?.phases || []).map((p) => [p.id, p]));
    const py = store.get().python;
    by.env = { status: envStatus(), summary: !py ? 'verificando' : py.state === 'ready' ? `Python ${py.python.version} pronto` : py.state === 'missing' ? 'Python ainda não preparado' : `falta: ${py.missing.join(', ')}` };
    const run = store.get().run;
    if (run && by[run.job]) by[run.job] = { ...by[run.job], status: 'running' };
    const steps = ['env', ...PIPELINE_ORDER];
    this.innerHTML = steps.map((id, i) => {
      const p = by[id] || { status: id === 'env' ? 'pending' : 'pending', summary: '' };
      const badge = STATUS_ICON[p.status] ? icon(STATUS_ICON[p.status]) : String(i + 1);
      const tip = `${PHASE_INFO[id].title}: ${STATUS_LABEL[p.status] || ''}${p.summary ? ' — ' + p.summary : ''}${p.reason ? '\n' + p.reason : ''}`;
      return `${i ? `<span class="step-sep">${icon('chevron')}</span>` : ''}
        <button class="step ${screen === id ? 'active' : ''}" data-screen="${id}" data-status="${p.status}" title="${esc(tip)}" aria-current="${screen === id ? 'step' : 'false'}">
          <span class="step-badge">${badge}</span>${esc(PHASE_INFO[id].title)}
        </button>`;
    }).join('');
  }
}
customElements.define('pc-stepper', PcStepper);
