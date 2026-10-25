// Features: monta o dataset que os modelos usam. Aqui o operador escolhe o período
// (de quando a quando) sobre a base unificada gerada pela Limpeza.
// Vai para o pipeline como DATE_START_DATA (início) e DATA_END (fim, quando não é o último mês).
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { mountPadraoLine } from '../components/padrao-line.js';
import { botaoRestaurar, confirmarRestaurar, seloCampo } from '../lib/padrao.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { phaseHead, animCard, statusCardHtml } from './phase.js';
import { mountRunPanel, execControls } from '../components/run-panel.js';

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const ymLabel = (ym) => (ym ? `${ym.slice(5)}/${ym.slice(0, 4)}` : '—');
const callout = (tone, html) => `<div class="callout" data-tone="${tone}">${icon(tone === 'err' ? 'x' : tone === 'info' ? 'info' : 'warn')}<div>${html}</div></div>`;
const nextYm = (ym) => { let [y, m] = ym.split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; };

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('features', `<div class="btn-row">
        ${botaoRestaurar('data-act="reset"')}
        <button class="btn primary" data-act="save">${icon('save')} Salvar período</button></div>`)}
    <div id="padrao-line"></div>
    <div id="body"><div class="empty">Carregando…</div></div>
    <div class="card" id="exec"></div>
    <div id="run-panel"></div>
    <div id="status-card"></div>
    ${animCard('features')}`;

  const $ = (s) => el.querySelector(s);
  let view = null, saved = null, form = null, timer = null;

  function render() {
    if (!view.files || !view.first) {
      $('#body').innerHTML = `<div class="empty">Ainda não há planilhas lidas.<br>Importe as planilhas e escolha os parâmetros da Limpeza primeiro.
        <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-go="clean">${icon('chevron-left')} Limpeza</button></div></div>`;
      return;
    }
    $('#body').innerHTML = `
      <section class="card">
        <h2>Período do dataset</h2>
        <p class="muted" style="margin-bottom:12px">De quando a quando os modelos aprendem. A base unificada tem de ${ymLabel(view.first)} a ${ymLabel(view.last)}
          (${esc(view.clean.ocorrencias.join(', '))} · ${!view.clean.veiculos ? 'todos os tipos de veículo' : view.clean.veiculos.length <= 3 ? esc(view.clean.veiculos.join(', ')) : `${view.clean.veiculos.length} tipos de veículo`};
          <a href="#" data-go="clean">mudar na Limpeza</a>).</p>
        <div class="period2">
          <label class="field">De<input type="month" id="ini" min="${esc(view.first)}" max="${esc(view.last)}"></label>
          <label class="field">Até<input type="month" id="fim" min="${esc(view.first)}" max="${esc(view.last)}"></label>
          <label class="chk" style="align-self:end;margin-bottom:8px"><input type="checkbox" id="ate-ultimo"> Até o último mês com dados</label>
        </div>
        <div id="chart"></div>
        <div id="sum"></div>
        <div id="warn"></div>
        <div id="dirty" class="dirty" hidden>${icon('info')} Alterações ainda não salvas</div>
      </section>`;
    fill();
  }

  function fill() {
    $('#ini').value = form.inicio;
    $('#ate-ultimo').checked = !form.fim;
    $('#fim').value = form.fim || view.last;
    $('#fim').disabled = !form.fim;
    draw();
  }

  function read() {
    const ini = /^\d{4}-\d{2}$/.test($('#ini').value) ? $('#ini').value : form.inicio;
    const ultimo = $('#ate-ultimo').checked;
    const fim = ultimo ? null : (/^\d{4}-\d{2}$/.test($('#fim').value) ? $('#fim').value : view.last);
    return { inicio: ini, fim: fim && fim >= view.last ? null : fim };
  }

  function draw() {
    const months = Object.keys(view.months).sort();
    const end = form.fim || view.last;
    const vals = months.map((m) => view.months[m]);
    const vmax = Math.max(1, ...vals);
    const w = 600, h = 90, bw = w / months.length;
    const inRange = (m) => m >= form.inicio && m <= end;
    $('#chart').innerHTML = `<div class="months big">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Registros por mês e período escolhido">
        ${vals.map((v, i) => `<rect class="${inRange(months[i]) ? 'in' : 'out'}" x="${(i * bw).toFixed(2)}" y="${(h - (v / vmax) * h).toFixed(2)}" width="${Math.max(0.5, bw - 0.8).toFixed(2)}" height="${((v / vmax) * h).toFixed(2)}"><title>${ymLabel(months[i])}: ${nf(v)}</title></rect>`).join('')}
      </svg>
      <div class="fl-top"><span class="muted num">${ymLabel(months[0])}</span><span class="muted num">${ymLabel(months[months.length - 1])}</span></div></div>`;
    const sel = view.selected;
    $('#sum').innerHTML = `<div class="kpis">
      <div><b class="num">${sel.months}</b><span>meses</span></div>
      <div><b class="num">${nf(sel.registros)}</b><span>registros com localização</span></div>
      <div><b class="num">${ymLabel(nextYm(end))}</b><span>primeiro mês que dá para prever</span></div></div>`;
    let warn = '';
    if (form.fim && form.fim < form.inicio) warn = callout('err', 'O fim é antes do início.');
    else if (sel.months < 12) warn = callout('warn', `Só ${sel.months} mês(es). Os modelos usam 24 semanas de histórico por célula; use ao menos 12 meses, o ideal são 3 anos ou mais.`);
    const empty = months.filter((m) => inRange(m) && !view.months[m]);
    if (empty.length) {
      const yrs = [...new Set(empty.map((m) => m.slice(0, 4)))];
      warn += callout('warn', `${empty.length} mês(es) do período sem nenhum registro (${yrs.join(', ')}). Falta importar a planilha desses anos em Dados SSP, ou ajuste o período.`);
    }
    if (form.fim) warn += callout('info', `Com o fim em ${ymLabel(form.fim)}, os modelos treinam só com o que se sabia até lá, e a previsão é para ${ymLabel(nextYm(form.fim))}. Útil para testar o modelo num mês que já aconteceu. A <b>Validação</b> desse mês não depende desta data: ela usa os crimes da Filtragem, que guardam todos os meses.`);
    $('#warn').innerHTML = warn;
    const dirty = JSON.stringify(form) !== JSON.stringify(saved);
    $('#dirty').hidden = !dirty;
    renderExec();
    el.querySelector('[data-act="save"]').disabled = !dirty || (form.fim && form.fim < form.inicio);
  }

  async function recompute() {
    form = read();
    $('#fim').disabled = $('#ate-ultimo').checked;
    try { view = await call('dataset:view', form); draw(); } catch (e) { toast(e.message, 'err'); }
  }

  // ── execução ───────────────────────────────────────────────────────────────
  let area = '';
  function renderExec() {
    const { ws, python } = store.get();
    if (!ws) return;
    const filt = ws.phases?.find((p) => p.id === 'filter');
    const areas = filt?.areasDone || [];
    const dirty = view && saved && $('#ini') && JSON.stringify(read()) !== JSON.stringify(saved);
    const blocker = !areas.length ? { text: 'As Features usam os crimes por célula. Rode a Filtragem antes.', go: 'filter', goLabel: 'Ir para a Filtragem' } : null;
    $('#exec').innerHTML = `<h2>Execução</h2>
      ${execControls({ job: 'features', label: 'Features', python, running: panel.isRunning(), areas, area, blocker,
        note: `Monta um dataset por área com o período acima${dirty ? ' (as alterações do período são salvas antes)' : ''}. Leva alguns minutos por área.` })}`;
  }
  async function startRun() {
    if (view && saved && $('#ini') && JSON.stringify(read()) !== JSON.stringify(saved)) await save();
    try { await panel.run({ area: area || null }); renderExec(); scrollToEl($('#run-panel')); } catch (err) { toast(err.message, 'err', 8000); }
  }

  async function save() {
    form = read();
    try {
      view = await call('dataset:save', form);
      saved = view.dataset; form = { ...saved };
      draw(); await refreshWorkspace();
      toast('Período do dataset salvo.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-exec-area]')) { area = e.target.value; return; }
    if (!view || !e.target.closest('.period2')) return;
    if (e.target.id === 'ate-ultimo' && !e.target.checked) $('#fim').value = view.last;
    clearTimeout(timer); timer = setTimeout(recompute, 100);
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('a[data-go]')) e.preventDefault();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'run') startRun();
    if (act === 'save') save();
    if (act === 'reset') {
      if (!(await confirmarRestaurar('O período do dataset (de 01/2020 até o último mês com dados)'))) return;
      try {
        view = await call('dataset:reset'); saved = view.dataset; form = { ...saved };
        fill(); refreshWorkspace();
        toast('Período de volta ao padrão da dissertação: de 01/2020 até o último mês com dados.', 'ok', 6000);
      } catch (err) { toast(err.message, 'err'); }
    }
    const open = e.target.closest('[data-open]');
    if (open) call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err'));
    const go = e.target.closest('[data-go]');
    if (go && view && saved && $('#ini') && JSON.stringify(read()) !== JSON.stringify(saved)) save();
  });

  const panel = mountRunPanel($('#run-panel'), 'features', {
    anim: el.querySelector('pc-phase-anim'), onState: renderExec, onEnd: renderExec,
  });
  const renderStatus = () => { $('#status-card').innerHTML = statusCardHtml('features'); };
  const offWs = store.subscribe((_s, why) => { if (why === 'ws') { renderStatus(); renderExec(); } if (why === 'python') renderExec(); });
  renderStatus();

  call('dataset:view').then((v) => {
    view = v; saved = v.dataset; form = { ...v.dataset };
    render(); renderExec();
  }).catch((e) => { $('#body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });

  const pLine = mountPadraoLine(el.querySelector('#padrao-line'), 'features');
  return () => { offWs(); clearTimeout(timer); panel.unmount(); pLine.unmount(); };
}
