// Limpeza: gera a base unificada. O operador escolhe o tipo de ocorrência, os tipos de
// veículo e se remove repetidos. A cidade é fixa (só a capital tem malha viária) e o
// período não é cortado aqui: ele é escolhido em Features.
// Opções e contagens vêm das planilhas importadas, lidas uma vez pelo app.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { mountPadraoLine } from '../components/padrao-line.js';
import { botaoRestaurar, confirmarRestaurar, seloCampo } from '../lib/padrao.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { phaseHead, animCard, statusCardHtml } from './phase.js';
import { mountRunPanel } from '../components/run-panel.js';
import { newSheetBox, cleanLine } from '../components/new-sheet.js';

const OC_TEXT = {
  FURTADO: 'Veículo levado sem violência (estacionado, sem o dono por perto).',
  ROUBADO: 'Veículo levado com violência ou ameaça.',
  'LOCALIZADO/ENTREGUE': 'Veículo encontrado pela polícia ou devolvido ao dono.',
};
const PRESETS = [
  ['Furto e roubo', ['FURTADO', 'ROUBADO']],
  ['Só furto', ['FURTADO']],
  ['Só roubo', ['ROUBADO']],
  ['Só recuperados', ['LOCALIZADO/ENTREGUE']],
];
const CARROS = ['AUTOMOVEL', 'CAMINHONETE', 'CAMIONETA', 'UTILITARIO'];
const MOTOS = ['MOTOCICLO', 'MOTONETA', 'CICLOMOTO', 'CICLOMOTOR'];

const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const ymLabel = (ym) => (ym ? `${ym.slice(5)}/${ym.slice(0, 4)}` : '—');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canon = (p) => ({
  municipios: [...(p.municipios || ['S.PAULO'])].sort(),
  ocorrencias: [...p.ocorrencias].sort(),
  veiculos: Array.isArray(p.veiculos) ? [...p.veiculos].sort() : null,
  removerRepetidos: !!p.removerRepetidos,
});
const callout = (tone, html) => `<div class="callout" data-tone="${tone}">${icon(tone === 'err' ? 'x' : tone === 'info' ? 'info' : 'warn')}<div>${html}</div></div>`;
const fileList = (files) => files.map((f) => `<span class="mono">${esc(f.file)}</span> (${nf(f.n)})`).join(', ');

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('clean', `<div class="btn-row">
        ${botaoRestaurar('data-act="reset"')}
        <button class="btn primary" data-act="save">${icon('save')} Salvar parâmetros</button></div>`)}
    <div id="padrao-line"></div>
    <div class="card" id="ns-clean" hidden></div>
    <div class="card" id="reading" hidden>
      <h2>Lendo as planilhas</h2>
      <p class="muted" style="margin-bottom:8px">O app lê cada planilha uma vez para mostrar as opções e as contagens. Leva alguns segundos por arquivo.</p>
      <div class="prog-label"><span id="rd-name"></span><span id="rd-info" class="num"></span></div>
      <div class="prog-track"><i id="rd-bar"></i></div>
    </div>
    <div id="body"><div class="empty">Carregando as opções…</div></div>
    <div id="run-panel"></div>
    <div id="status-card"></div>
    ${animCard('clean')}`;

  const $ = (s) => el.querySelector(s);
  let view = null;      // última resposta do processo principal
  let saved = null;     // parâmetros gravados
  let form = null;      // parâmetros na tela
  let timer = null;

  // ── progresso da leitura das planilhas ─────────────────────────────────────
  const offProf = window.pc.on('ssp:profile', (p) => {
    if (p.state === 'pronto' && p.index === p.total) { $('#reading').hidden = true; return; }
    if (p.state !== 'lendo') return;
    $('#reading').hidden = false;
    $('#rd-name').textContent = `${p.index} de ${p.total} · ${p.name}`;
    $('#rd-info').textContent = `${p.pct || 0}%`;
    $('#rd-bar').style.width = `${((p.index - 1 + (p.pct || 0) / 100) / p.total) * 100}%`;
  });

  // ── formulário ─────────────────────────────────────────────────────────────
  function renderForm() {
    if (!view.files) {
      $('#body').innerHTML = `<div class="empty">Nenhuma planilha importada ainda.<br>Importe as planilhas da SSP no passo anterior.
        <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-go="ssp">${icon('chevron-left')} Dados SSP</button></div></div>`;
      return;
    }
    const o = view.options, out = view.outside;
    const otherOc = out.ocorrencias.n ? `
      <div class="tile tile-other" aria-disabled="true">
        ${icon('warn')}
        <span class="tile-body"><b>Outro tipo</b>
          <span class="muted">${nf(out.ocorrencias.n)} registro(s) com outro valor nesta coluna${out.ocorrencias.examples.length ? ` (ex.: ${out.ocorrencias.examples.map((x) => `“${esc(x.label)}”`).join(', ')})` : ''}. Ficam de fora.</span>
          <span class="tile-n">Confira na planilha original, coluna <span class="mono">DESCR_OCORRENCIA_VEICULO</span>: ${fileList(out.ocorrencias.files)}</span></span>
      </div>` : '';
    $('#body').innerHTML = `
      <div class="clean-grid">
        <div class="clean-form">
          <section class="card">
            <h2>1 · Tipo de ocorrência</h2>
            <div class="seg presets" role="group" aria-label="Atalhos">${PRESETS.map(([l], i) => `<button type="button" data-preset="${i}">${esc(l)}</button>`).join('')}</div>
            <div class="tiles">${o.ocorrencias.map((x) => `<label class="tile"><input type="checkbox" name="oc" value="${esc(x.key)}">
                <span class="tile-body"><b>${esc(x.title)}</b><span class="muted">${esc(OC_TEXT[x.key] || '')}</span>
                <span class="tile-n num">${nf(x.n)} registros · SSP: “${esc(x.label)}”</span></span></label>`).join('')}${otherOc}</div>
            <div id="oc-warn"></div>
          </section>

          <section class="card">
            <h2>2 · Cidades</h2>
            <div class="seg cid-modo" role="radiogroup" aria-label="Cidades">
              <label><input type="radio" name="cid" value="capital"> Só a capital</label>
              <label><input type="radio" name="cid" value="escolher"> Escolher cidades</label>
              <label><input type="radio" name="cid" value="todas"> Todas as cidades</label>
            </div>
            <div id="cid-box"></div>
            <div id="cid-info"></div>
          </section>

          <section class="card">
            <h2>3 · Tipos de veículo</h2>
            <div class="btn-row" style="margin-bottom:10px">
              <label class="chk"><input type="checkbox" id="ve-all"> <b>Todos os tipos</b></label>
              <span class="spacer"></span>
              <button class="btn sm" data-ve="carros" type="button">Só carros e utilitários</button>
              <button class="btn sm" data-ve="motos" type="button">Só motos</button>
            </div>
            <div class="chips" id="ve-list"></div>
            <div id="ve-out"></div>
          </section>

          <section class="card">
            <h2>4 · Registros repetidos</h2>
            <label class="chk"><input type="checkbox" id="dedup"> Remover repetidos (recomendado)</label>
            <p class="muted" style="margin-top:6px">Um mesmo fato às vezes aparece em mais de um boletim (B.O. complementar ou reemitido). Com esta opção, registros com mesmo local, data, hora e tipo de veículo contam uma vez.</p>
          </section>
        </div>

        <aside class="card funnel" aria-live="polite">
          <h2>Quantos registros entram <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500">· estimativa</span></h2>
          <div id="funnel"></div>
          <div id="months"></div>
          <div id="dirty" class="dirty" hidden>${icon('info')} Alterações ainda não salvas</div>
          <div id="exec"></div>
        </aside>
      </div>`;
    renderVehicles();
    fillForm(form);
  }

  // chips de veículo: lista fixa, contagem dentro das ocorrências escolhidas
  function renderVehicles() {
    const list = $('#ve-list');
    if (!list) return;
    const checked = new Set([...el.querySelectorAll('input[name="ve"]:checked')].map((i) => i.value));
    const all = $('#ve-all').checked;
    list.innerHTML = view.options.veiculos.map((v) => `<label class="chip"><input type="checkbox" name="ve" value="${esc(v.key)}" ${all || checked.has(v.key) ? 'checked' : ''} ${all ? 'disabled' : ''}><span>${esc(v.label)} <i class="num">${nf(v.n)}</i></span></label>`).join('');
    const out = view.outside.veiculos;
    $('#ve-out').innerHTML = out.n ? callout('warn', `<b>${nf(out.n)} registro(s) sem tipo de veículo válido ficam de fora</b>${out.examples.length ? ` (${out.examples.map((x) => `“${esc(x.label)}” ${nf(x.n)}`).join(', ')})` : ''}.
      Confira na planilha original, coluna <span class="mono">DESCR_TIPO_VEICULO</span>: ${fileList(out.files)}.`) : '';
  }

  // cidades: lista com busca (as planilhas da SSP têm as ~645 cidades do estado)
  let cidFiltro = '';
  function renderCities() {
    const box = $('#cid-box');
    if (!box) return;
    const modo = el.querySelector('input[name="cid"]:checked')?.value || 'capital';
    // ao entrar em "Escolher cidades" (lista ainda não desenhada), parte das cidades salvas ou da capital
    const naTela = el.querySelectorAll('input[name="mun"]').length > 0;
    const base = (form.municipios || []).filter((k) => k !== '*');
    const marcadas = new Set(modo === 'escolher' && naTela ? readCities() : base.length ? base : ['S.PAULO']);
    if (modo !== 'escolher') { box.innerHTML = ''; }
    else {
      const f = cidFiltro.trim().toLowerCase();
      const lista = view.options.cidades;
      const vis = lista.filter((c) => marcadas.has(c.key) || (f ? c.label.toLowerCase().includes(f) : true)).slice(0, f ? 200 : 40);
      box.innerHTML = `<input class="cid-busca" id="cid-busca" type="search" placeholder="Buscar cidade (ex.: Mogi, Guarulhos)" value="${esc(cidFiltro)}" aria-label="Buscar cidade">
        <div class="chips cid-list">${vis.map((c) => `<label class="chip"><input type="checkbox" name="mun" value="${esc(c.key)}" ${marcadas.has(c.key) ? 'checked' : ''}><span>${esc(c.label)} <i class="num">${nf(c.n)}</i></span></label>`).join('')}</div>
        ${!f && lista.length > 40 ? `<p class="muted small">Mostrando as 40 cidades com mais registros. Busque pelo nome para ver as outras ${nf(lista.length - 40)}.</p>` : ''}`;
    }
    const out = view.outside.otherCities;
    $('#cid-info').innerHTML = !view.cidadesTxt ? callout('err', 'Escolha ao menos uma cidade.') : callout('info', `<b>${nf(view.steps.cidade)}</b> registros de ${esc(view.cidadesTxt)}.
      ${out.n ? `${nf(out.n)} registros de outras ${nf(out.count)} cidades ficam de fora.` : ''}
      As 8 áreas da dissertação ficam na capital. Para analisar outra cidade, inclua a cidade aqui e crie a área dela em
      <a href="#" data-go="filter">Filtragem → Áreas de estudo</a>; a Filtragem só usa os registros que caem dentro das áreas.`);
  }
  const readCities = () => {
    const modo = el.querySelector('input[name="cid"]:checked')?.value || 'capital';
    if (modo === 'todas') return ['*'];
    if (modo === 'capital') return ['S.PAULO'];
    if (!el.querySelectorAll('input[name="mun"]').length) { const b = (form.municipios || []).filter((k) => k !== '*'); return b.length ? b : ['S.PAULO']; }
    const m = [...el.querySelectorAll('input[name="mun"]:checked')].map((i) => i.value);
    // as marcadas que estão fora da lista visível (busca) continuam
    const ocultas = (form.municipios || []).filter((k) => k !== '*' && !el.querySelector(`input[name="mun"][value="${CSS.escape(k)}"]`));
    return [...new Set([...m, ...ocultas])];
  };

  function fillForm(p) {
    const mun = p.municipios || ['S.PAULO'];
    const modo = mun.includes('*') ? 'todas' : mun.length === 1 && mun[0] === 'S.PAULO' ? 'capital' : 'escolher';
    el.querySelectorAll('input[name="cid"]').forEach((i) => { i.checked = i.value === modo; });
    renderCities();
    el.querySelectorAll('input[name="oc"]').forEach((i) => { i.checked = p.ocorrencias.includes(i.value); });
    const all = !Array.isArray(p.veiculos);
    $('#ve-all').checked = all;
    el.querySelectorAll('input[name="ve"]').forEach((i) => { i.checked = all || p.veiculos.includes(i.value); i.disabled = all; });
    $('#ve-list').classList.toggle('off', all);
    $('#dedup').checked = p.removerRepetidos;
    markPresets();
  }

  function readForm() {
    const all = $('#ve-all').checked;
    return {
      municipios: readCities(),
      ocorrencias: [...el.querySelectorAll('input[name="oc"]:checked')].map((i) => i.value),
      veiculos: all ? null : [...el.querySelectorAll('input[name="ve"]:checked')].map((i) => i.value),
      removerRepetidos: $('#dedup').checked,
    };
  }

  function markPresets() {
    const cur = [...el.querySelectorAll('input[name="oc"]:checked')].map((i) => i.value).sort();
    el.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', same([...PRESETS[b.dataset.preset][1]].sort(), cur)));
  }

  // ── funil e avisos ─────────────────────────────────────────────────────────
  function renderFunnel() {
    const s = view.steps, p = form;
    const rows = [
      ['Linhas nas planilhas', s.lidos],
      [p.municipios?.includes('*') ? 'Em todas as cidades' : (p.municipios || []).length === 1 && p.municipios[0] === 'S.PAULO' ? 'Em São Paulo (capital)' : 'Nas cidades escolhidas', s.cidade],
      ['Do tipo de ocorrência escolhido', s.ocorrencia],
      [Array.isArray(p.veiculos) ? `Dos ${p.veiculos.length} tipo(s) de veículo escolhidos` : 'Com tipo de veículo válido', s.veiculo],
      ['Com data válida', s.data],
      ['Com localização no mapa', s.coordenadas],
    ];
    const max = Math.max(1, s.lidos);
    $('#funnel').innerHTML = `<ol class="funnel-list">${rows.map(([l, n], i) => `
      <li><div class="fl-top"><span>${esc(l)}</span><b class="num">${nf(n)}</b></div>
      <div class="fl-bar"><i style="width:${Math.max(n ? 0.6 : 0, (n / max) * 100)}%" data-last="${i === rows.length - 1}"></i></div></li>`).join('')}</ol>
      <p class="muted small">${p.removerRepetidos ? 'Os repetidos saem na execução; o número final fica um pouco menor.' : 'Repetidos mantidos.'}
      Registros fora das áreas de estudo saem na Filtragem.</p>`;

    // registros por mês nas planilhas importadas (a base unificada guarda todos)
    const firstYear = view.years[0] ? `${view.years[0]}-01` : '';
    const have = Object.keys(view.byMonth).filter((m) => m >= firstYear).sort();
    const months = [];
    if (have.length) {
      for (let [y, m] = have[0].split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= have[have.length - 1]; m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${String(m).padStart(2, '0')}`);
    }
    if (months.length) {
      const vals = months.map((m) => view.byMonth[m] || 0);
      const vmax = Math.max(...vals);
      const w = 300, h = 64, bw = w / months.length;
      $('#months').innerHTML = `<div class="months">
        <div class="fl-top"><span>Período nas planilhas</span><span class="muted num">${ymLabel(months[0])} – ${ymLabel(months[months.length - 1])}</span></div>
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Registros por mês">
          ${vals.map((v, i) => `<rect x="${(i * bw).toFixed(2)}" y="${(h - (v / vmax) * h).toFixed(2)}" width="${Math.max(0.5, bw - 0.6).toFixed(2)}" height="${((v / vmax) * h).toFixed(2)}"><title>${ymLabel(months[i])}: ${nf(v)}</title></rect>`).join('')}
        </svg>
        <p class="muted small">A base unificada guarda todos os meses. O período que os modelos usam é escolhido em <a href="#" data-go="features">Features</a>.</p></div>`;
    } else $('#months').innerHTML = '';

    const hasRec = p.ocorrencias.includes('LOCALIZADO/ENTREGUE');
    const hasCrime = p.ocorrencias.some((x) => x === 'FURTADO' || x === 'ROUBADO');
    $('#oc-warn').innerHTML = !p.ocorrencias.length ? callout('err', 'Escolha ao menos um tipo de ocorrência.')
      : hasRec && hasCrime ? callout('warn', '<b>Recuperados misturados com furtos/roubos.</b> O mesmo veículo pode contar duas vezes, em lugares diferentes: onde foi levado e onde foi encontrado. Prefira analisar recuperados separadamente.')
      : hasRec ? callout('info', '<b>Só recuperados:</b> o local é onde o veículo foi <b>encontrado</b>, não onde foi levado. O mapa passa a mostrar onde veículos aparecem (áreas de desmanche e abandono), e não onde são furtados.')
      : '';
    if (Array.isArray(p.veiculos) && !p.veiculos.length) $('#funnel').insertAdjacentHTML('afterbegin', callout('err', 'Escolha ao menos um tipo de veículo ou marque "Todos os tipos".'));
    else if (s.coordenadas && s.coordenadas < 5000) $('#funnel').insertAdjacentHTML('beforeend', callout('warn', 'Poucos registros para treinar bem. Amplie os tipos de ocorrência ou de veículo.'));

    const dirty = !same(canon(form), canon(saved));
    $('#dirty').hidden = !dirty;
    el.querySelector('[data-act="save"]').disabled = !dirty || !p.ocorrencias.length || !(p.veiculos === null || p.veiculos.length);
    renderExec();
  }

  async function recompute() {
    form = readForm();
    markPresets();
    try { view = await call('clean:view', form); renderVehicles(); renderCities(); renderFunnel(); } catch (e) { toast(e.message, 'err'); }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(recompute, 120); };

  async function save() {
    form = readForm();
    if (!form.ocorrencias.length) { toast('Escolha ao menos um tipo de ocorrência.', 'err'); return false; }
    if (!form.municipios.length) { toast('Escolha ao menos uma cidade.', 'err'); return false; }
    if (Array.isArray(form.veiculos) && !form.veiculos.length) { toast('Escolha ao menos um tipo de veículo ou marque "Todos os tipos".', 'err'); return false; }
    try {
      view = await call('clean:save', form);
      saved = view.params; form = { ...saved };
      renderFunnel();
      await refreshWorkspace();
      toast('Parâmetros da Limpeza salvos.', 'ok');
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }

  // ── eventos ────────────────────────────────────────────────────────────────
  el.addEventListener('change', (e) => {
    if (!view) return;
    if (e.target.id === 've-all') {
      const all = e.target.checked;
      el.querySelectorAll('input[name="ve"]').forEach((i) => { i.disabled = all; if (all) i.checked = true; });
      $('#ve-list').classList.toggle('off', all);
    }
    if (e.target.name === 'cid' && e.target.value === 'escolher' && !(form.municipios || []).length) form.municipios = ['S.PAULO'];
    if (e.target.name === 'cid') { if (e.target.value === 'escolher' && (form.municipios || []).includes('*')) form.municipios = ['S.PAULO']; renderCities(); }
    if (e.target.closest('.clean-form') && e.target.id !== 'cid-busca') schedule();
  });
  el.addEventListener('input', (e) => {
    if (e.target.id !== 'cid-busca') return;
    cidFiltro = e.target.value;
    renderCities();
    const i = $('#cid-busca'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('a[data-go]')) e.preventDefault();
    const preset = e.target.closest('[data-preset]');
    if (preset) {
      const v = PRESETS[preset.dataset.preset][1];
      el.querySelectorAll('input[name="oc"]').forEach((i) => { i.checked = v.includes(i.value); });
      schedule();
    }
    const ve = e.target.closest('[data-ve]')?.dataset.ve;
    if (ve) {
      const set = ve === 'carros' ? CARROS : MOTOS;
      $('#ve-all').checked = false; $('#ve-list').classList.remove('off');
      el.querySelectorAll('input[name="ve"]').forEach((i) => { i.disabled = false; i.checked = set.includes(i.value); });
      schedule();
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') save();
    if (act === 'reset') {
      if (!(await confirmarRestaurar('Os parâmetros da Limpeza (capital, furto e roubo, todos os tipos de veículo, removendo repetidos)'))) return;
      try {
        view = await call('clean:reset'); saved = view.params; form = { ...saved };
        $('#ve-all').checked = true; renderVehicles(); fillForm(form); renderFunnel(); refreshWorkspace();
        toast('Limpeza de volta ao padrão da dissertação: capital, furto e roubo, todos os tipos de veículo, removendo repetidos.', 'ok', 6000);
      } catch (err) { toast(err.message, 'err'); }
    }
    const open = e.target.closest('[data-open]');
    if (open) call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err'));
    // Avançar com alterações pendentes: salva antes (a navegação segue normalmente)
    const go = e.target.closest('[data-go]');
    if (go && view?.files && form && saved && !same(canon(readForm()), canon(saved))) save();
  });

  // ── execução ───────────────────────────────────────────────────────────────
  function renderExec() {
    const box = $('#exec');
    if (!box || !view) return;
    const py = store.get().python;
    const running = panel.isRunning();
    const valid = form && form.ocorrencias.length && (form.veiculos === null || form.veiculos.length);
    const dirty = form && saved && !same(canon(form), canon(saved));
    if (!py) {
      box.innerHTML = `<button class="btn primary block" disabled>${icon('refresh')} Verificando o Python…</button>`;
    } else if (!py.jobs?.clean) {
      box.innerHTML = `<button class="btn primary block" data-go="env">${icon('env')} Preparar o ambiente</button>
        <p class="muted small">Para executar, o app precisa do Python e dos pacotes do pipeline. A tela <b>Ambiente</b> prepara tudo com um botão.</p>`;
    } else {
      box.innerHTML = `<button class="btn primary block" data-act="run" ${running || !valid ? 'disabled' : ''}>${icon('play')} ${running ? 'Executando…' : 'Executar Limpeza'}</button>
        <p class="muted small">${running ? 'Acompanhe o andamento logo abaixo.' : `${cleanLine(store.get().ws) || `Junta as ${view.files} planilha(s) com os parâmetros acima e grava a base unificada.`}${dirty ? ' As alterações dos parâmetros são salvas antes.' : ''}`}</p>`;
    }
  }
  async function startRun() {
    if (form && saved && !same(canon(readForm()), canon(saved)) && !(await save())) return;
    try {
      await panel.run();
      renderExec();
      scrollToEl($('#run-panel'));
    } catch (e) { toast(e.message, 'err', 8000); }
  }
  el.addEventListener('click', (e) => { if (e.target.closest('[data-act="run"]')) startRun(); });
  const panel = mountRunPanel($('#run-panel'), 'clean', {
    anim: el.querySelector('pc-phase-anim'),
    onState: () => renderExec(),
    onEnd: () => renderExec(),
  });

  const renderStatus = () => { $('#status-card').innerHTML = statusCardHtml('clean'); };
  const offWs = store.subscribe((_s, why) => { if (why === 'ws') { renderStatus(); renderExec(); renderNs(); } if (why === 'python') renderExec(); });
  // planilha nova: o que roda de novo (Limpeza com todas, Filtragem e Features, sem Treino)
  const renderNs = () => { const b = $('#ns-clean'); if (!b) return; const h = newSheetBox(store.get().ws, { cta: false }); b.hidden = !h; b.innerHTML = h; };
  renderStatus(); renderNs();

  call('clean:view').then((v) => {
    view = v; saved = v.params; form = { ...v.params };
    $('#reading').hidden = true;
    renderForm();
    if (v.files) renderFunnel();
    if (v.missing.length) toast(`Não consegui ler: ${v.missing.join(', ')}. Veja os Logs.`, 'err', 8000);
  }).catch((e) => { $('#body').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });

  const pLine = mountPadraoLine(el.querySelector('#padrao-line'), 'clean');
  return () => { offProf(); offWs(); clearTimeout(timer); panel.unmount(); pLine.unmount(); };
}
