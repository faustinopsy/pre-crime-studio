// Previsão: gera o mapa de risco de um mês com os modelos treinados (RF, LSTM, Transformer
// e o Ensemble que junta os três). Separada da Validação: prever não exige os crimes reais.
import { store, call } from '../lib/store.js';
import { confirmar } from '../lib/dialog.js';
import { icon } from '../lib/icons.js';
import { esc, toast, scrollToEl, fmtDate } from '../lib/dom.js';
import { phaseHead, animCard, statusCardHtml } from './phase.js';
import { mountRunPanel, execControls, areaLabel, monthLabel, modoPill, MODO } from '../components/run-panel.js';

const dmy = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '—');
const callout = (tone, html) => `<div class="callout" data-tone="${tone}">${icon(tone === 'info' ? 'info' : 'warn')}<div>${html}</div></div>`;
/** Segunda-feira da 1ª semana do mês 'AAAA-MM' (as semanas do dataset começam na segunda). */
function firstMonday(mes) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const weeksBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / (7 * 86400000));

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('predict', '')}
    <div class="card" id="opts"><div class="empty">Carregando…</div></div>
    <div id="run-panel"></div>
    <div class="card" id="done"></div>
    <div class="card" id="basemap"></div>
    <div id="status-card"></div>
    ${animCard('predict')}`;
  const $ = (s) => el.querySelector(s);
  let fi = null;
  let mes = null;
  let area = '';

  /** Tipo de previsão de cada área para o mês escolhido. */
  function modoDe(a) {
    if (fi?.dataEnd) return 'replay';
    const last = a.weeks?.last;
    if (!last) return 'desconhecido';
    return firstMonday(mes) <= last ? 'retroativa' : 'cega';
  }

  function renderOpts() {
    const { python } = store.get();
    if (!fi) return;
    const comModelo = fi.areas.filter((a) => a.models.length);
    if (!mes) mes = fi.suggested || new Date().toISOString().slice(0, 7);
    if (area && !comModelo.some((a) => a.area === area)) area = '';
    const torch = python?.packages?.torch?.ok;
    const precisaTorch = comModelo.some((a) => a.models.some((m) => m !== 'RF'));
    const blocker = !comModelo.length ? { text: 'A Previsão usa os modelos do Treino. Treine ao menos uma área antes.', go: 'train', goLabel: 'Ir para Treino' }
      : python && precisaTorch && !torch ? { text: 'Falta o PyTorch para usar LSTM e Transformer. Prepare o ambiente.', go: 'env', goLabel: 'Ir para Ambiente' } : null;

    const alvo = comModelo.filter((a) => !area || a.area === area);
    const modos = [...new Set(alvo.map(modoDe))];
    const ini = firstMonday(mes);
    const gap = alvo.map((a) => a.weeks?.last).filter(Boolean).sort()[0];
    const longe = gap && modos.includes('cega') && weeksBetween(gap, ini) > 8;
    const staleModels = alvo.filter((a) => a.modelTime && a.datasetTime && a.datasetTime > a.modelTime);
    const jaFeita = alvo.filter((a) => a.predictions[mes.replace('-', '_')]);

    $('#opts').innerHTML = `
      <h2>Mês da previsão</h2>
      <div class="pred-row">
        <label class="field">Mês<input type="month" id="mes" value="${esc(mes)}"></label>
        <div class="pred-explain">
          <p>São previstas <b>4 semanas</b> a partir de <b>${esc(dmy(ini))}</b>.
            ${fi.suggested ? `O mês seguinte ao último dado é <a href="#" data-mes="${esc(fi.suggested)}">${esc(monthLabel(fi.suggested))}</a>.` : ''}</p>
          <p class="muted" style="margin-top:4px">${modos.map((m) => `${modoPill(m)} ${esc(MODO[m][2])}`).join('<br>')}</p>
        </div>
      </div>
      ${modos.includes('retroativa') ? callout('warn', `<b>${esc(monthLabel(mes))} já está nos dados de treino.</b> Serve para conferir o pipeline, mas o acerto medido na Validação fica otimista.
          Para um teste honesto, escolha um mês depois de ${esc(dmy(gap))} ou defina a data final do período em <a href="#" data-go="features">Features</a> e treine de novo.`) : ''}
      ${longe ? callout('warn', `O último dado é de ${esc(dmy(gap))}, ${weeksBetween(gap, ini)} semanas antes do mês. Quanto mais longe, menos a previsão reflete a situação atual. Importe as planilhas mais recentes.`) : ''}
      ${staleModels.length ? callout('warn', `O dataset de ${staleModels.map((a) => esc(areaLabel(a.area))).join(', ')} é mais novo que os modelos. A previsão usa os modelos como estão; para usar os dados novos no aprendizado, treine de novo.`) : ''}
      ${jaFeita.length ? callout('info', `Já existe previsão de ${esc(monthLabel(mes))} para ${jaFeita.map((a) => esc(areaLabel(a.area))).join(', ')}. Executar de novo substitui.`) : ''}
      <div class="tbl-wrap"><table class="tbl pred-areas"><thead><tr><th>Área</th><th>Modelos</th><th>Dados até</th><th>Tipo</th><th>Previsões feitas</th></tr></thead>
        <tbody>${fi.areas.map((a) => `<tr class="${a.models.length ? '' : 'off'}"><td><b>${esc(areaLabel(a.area))}</b></td>
          <td>${a.models.length ? a.models.map((m) => `<span class="tag-chip">${esc(m)}</span>`).join('') : '<span class="muted">sem modelo</span>'}</td>
          <td class="num">${esc(dmy(a.weeks?.last))}</td>
          <td>${a.models.length ? modoPill(modoDe(a)) : ''}</td>
          <td>${Object.keys(a.predictions).sort().map((t) => `<span class="tag-chip ${t === mes.replace('-', '_') ? 'on' : ''}">${esc(monthLabel(t))}</span>`).join('') || '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>
      ${execControls({ job: 'predict', label: 'Previsão', python, running: panel.isRunning(), areas: comModelo.map((a) => a.area), area, blocker,
        note: 'Leva de 1 a 3 minutos por área. Não usa internet.' })}`;
  }

  function renderDone() {
    if (!fi) return;
    const months = [...fi.months].reverse();
    if (!months.length) { $('#done').innerHTML = '<h2>Previsões geradas</h2><div class="empty">Nenhuma previsão nesta pasta de trabalho.</div>'; return; }
    $('#done').innerHTML = `<h2>Previsões geradas</h2>
      <table class="tbl"><thead><tr><th>Mês</th><th>Áreas</th><th>Tipo</th><th>Validação</th><th></th></tr></thead>
      <tbody>${months.map((m) => {
        const val = m.validated.length ? `<span class="pill" data-status="done">${icon('check')}${m.validated.length} área(s)</span>`
          : m.readyToValidate.length ? `<span class="pill" data-status="partial">pronta para validar</span>`
          : `<span class="muted">aguarda os crimes reais</span>`;
        return `<tr><td><b>${esc(monthLabel(m.tag))}</b></td><td>${m.areas.map((a) => esc(areaLabel(a).replace('Área ', ''))).join(', ')}</td>
          <td>${m.modos.map(modoPill).join(' ')}</td><td>${val}</td>
          <td class="r nowrap"><button class="btn sm" data-map="${esc(m.tag)}" data-area="${esc(m.areas[0])}">${icon('map')} Ver no mapa</button>
            ${m.readyToValidate.length ? `<button class="btn sm" data-val="${esc(m.tag)}">${icon('validate')} Validar</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="note">As previsões ficam em <span class="mono">processed/results</span> (tabelas) e <span class="mono">processed/results_geojson</span> (mapas), uma por mês.</p>`;
  }

  // ── Fundo do mapa: chave da CARTO ───────────────────────────────────────────
  let bm = null;
  let bmBusy = false;
  function renderBasemap() {
    if (!bm) { $('#basemap').innerHTML = '<h2>Fundo do mapa</h2><div class="empty">Carregando…</div>'; return; }
    const t = bm.teste;
    const tone = !bm.temChave ? 'warn' : t?.ok === true ? 'ok' : t?.ok === false ? 'err' : t ? 'warn' : 'info';
    const stIcon = { ok: 'check', err: 'x', warn: 'warn', info: 'info' }[tone];
    const estado = !bm.temChave ? 'Nenhuma chave salva: o mapa usa as ruas da área, desenhadas pelo próprio app (funciona sem internet, mas sem nomes de ruas, bairros e rios).'
      : `Chave salva (termina em <b class="mono">${esc(bm.final)}</b>)${bm.cifrada ? ', guardada com o cofre do sistema' : ''}. ${t ? esc(t.msg) : 'Ainda não testada.'}`;
    $('#basemap').innerHTML = `
      <h2>Fundo do mapa <span class="spacer"></span>
        <span class="pill" data-status="${bm.temChave && t?.ok !== false ? 'done' : 'pending'}">${bm.temChave ? 'CARTO' : 'Ruas da área'}</span></h2>
      <div class="bm-grid">
        <div class="bm-explain">
          <p>O mapa desenha as células de risco por cima de um fundo com as ruas. Esse fundo vem de
            <span class="mono">basemaps.cartocdn.com</span>, o serviço de mapas base da <b>CARTO</b>: ela usa os dados abertos do
            <b>OpenStreetMap</b> (que não tem chave) e entrega as imagens prontas, em quadradinhos.</p>
          <p>Desde 25/09/2026 a CARTO exige uma <b>chave gratuita</b>. Sem ela, cada quadradinho vem com o aviso
            “API KEY REQUIRED”. Por isso, sem chave, o app usa as ruas da área desenhadas por ele mesmo.</p>
          <p><b>Como obter (grátis, cerca de 1 minuto):</b></p>
          <ol>
            <li>Clique em <b>Obter a chave na CARTO</b>: a página abre no navegador.</li>
            <li>Preencha nome e e-mail e aceite os termos. Não precisa criar conta.</li>
            <li>A chave chega por e-mail. Copie, cole ao lado e clique em <b>Salvar</b>: o app testa na hora.</li>
          </ol>
          <p class="muted">Grátis até 5 milhões de quadradinhos por mês para pesquisa, ensino e uso sem fins comerciais
            (1 milhão para uso comercial); cada tela do mapa usa algumas dezenas. Os créditos “© OpenStreetMap © CARTO” ficam no canto do mapa,
            como pedem os <button class="link-btn" data-bm="termos">termos de uso</button>.</p>
        </div>
        <div class="bm-form">
          <div class="bm-state" data-tone="${tone}" role="status">${icon(stIcon)}<span>${estado}</span></div>
          <label class="field" for="bm-key">${bm.temChave ? 'Trocar a chave' : 'Chave da CARTO'}</label>
          <div class="bm-key">
            <input id="bm-key" type="password" autocomplete="off" spellcheck="false" placeholder="cole aqui a chave recebida por e-mail" ${bmBusy ? 'disabled' : ''}>
            <button class="btn" data-bm="show" title="Mostrar ou esconder o que foi digitado" ${bmBusy ? 'disabled' : ''}>Mostrar</button>
            <button class="btn primary" data-bm="save" ${bmBusy ? 'disabled' : ''}>${icon('save')} Salvar</button>
          </div>
          <div class="btn-row">
            <button class="btn" data-bm="key">${icon('external')} Obter a chave na CARTO</button>
            ${bm.temChave ? `<button class="btn" data-bm="test" ${bmBusy ? 'disabled' : ''}>${bmBusy ? '<i class="spin"></i> Testando…' : `${icon('refresh')} Testar a chave`}</button>
              <button class="btn" data-bm="remove" ${bmBusy ? 'disabled' : ''}>${icon('x')} Remover a chave</button>` : ''}
          </div>
          <label class="field">Estilo do mapa
            <select id="bm-estilo" ${bmBusy ? 'disabled' : ''}>${Object.entries(bm.estilos).map(([k, l]) => `<option value="${esc(k)}" ${k === bm.estilo ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <p class="muted small">A chave fica só neste computador e vale para o mapa do app. Para usá-la num site publicado, marque a opção na tela Publicação
            (lá a chave fica visível para quem abrir o site; no painel da CARTO dá para restringi-la ao seu domínio).</p>
        </div>
      </div>`;
  }
  async function loadBasemap() {
    try { bm = await call('basemap:get'); } catch (e) { $('#basemap').innerHTML = `<h2>Fundo do mapa</h2><div class="empty">${esc(e.message)}</div>`; return; }
    renderBasemap();
  }
  async function bmAction(fn, okMsg) {
    bmBusy = true; renderBasemap();
    try { bm = await fn(); if (okMsg) toast(okMsg(bm), bm.teste?.ok === false ? 'err' : bm.teste?.ok === null ? 'warn' : 'ok', 6000); } catch (err) { toast(err.message, 'err', 8000); }
    bmBusy = false; renderBasemap();
  }

  async function load() {
    try { fi = await call('forecast:info'); } catch (e) { $('#opts').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    renderOpts(); renderDone();
  }

  el.addEventListener('change', (e) => {
    if (e.target.id === 'bm-estilo') bmAction(() => call('basemap:set', { estilo: e.target.value }), (v) => `Estilo do mapa: ${v.estilos[v.estilo]}.`);
    if (e.target.id === 'mes' && e.target.value) { mes = e.target.value; renderOpts(); }
    if (e.target.matches('[data-exec-area]')) { area = e.target.value; renderOpts(); }
  });
  el.addEventListener('keydown', (e) => { if (e.target.id === 'bm-key' && e.key === 'Enter') el.querySelector('[data-bm="save"]')?.click(); });
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-bm]')?.dataset.bm;
    if (b === 'key' || b === 'termos') call('basemap:openKeyPage', b === 'termos' ? 'termos' : 'chave').catch((err) => toast(err.message, 'err'));
    if (b === 'show') { const i = $('#bm-key'); i.type = i.type === 'password' ? 'text' : 'password'; i.focus(); }
    if (b === 'save') {
      const chave = $('#bm-key').value.trim();
      if (!chave) { toast('Cole a chave recebida por e-mail no campo.', 'err'); $('#bm-key').focus(); return; }
      bmAction(async () => { await call('basemap:set', { chave }); return call('basemap:test'); }, (v) => v.teste?.msg || 'Chave salva.');
    }
    if (b === 'test') bmAction(() => call('basemap:test'), (v) => v.teste?.msg);
    if (b === 'remove' && await confirmar('Remover a chave da CARTO?', { detalhe: 'O mapa volta a usar as ruas da área.', ok: 'Remover a chave', perigo: true })) bmAction(() => call('basemap:set', { chave: '' }), () => 'Chave removida: o mapa usa as ruas da área.');
    const sug = e.target.closest('[data-mes]');
    if (sug) { e.preventDefault(); mes = sug.dataset.mes; renderOpts(); }
    if (e.target.closest('[data-act="run"]')) {
      try { await panel.run({ area: area || null, mes }); renderOpts(); scrollToEl($('#run-panel')); } catch (err) { toast(err.message, 'err', 8000); }
    }
    const mp = e.target.closest('[data-map]');
    if (mp) { store.set({ mapFocus: { tag: mp.dataset.map, area: mp.dataset.area, tab: 'map' } }); store.set({ screen: 'map' }); }
    const v = e.target.closest('[data-val]');
    if (v) { store.set({ validateMonth: v.dataset.val }); store.set({ screen: 'validate' }); }
    const open = e.target.closest('[data-open]');
    if (open) call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err'));
  });

  const panel = mountRunPanel($('#run-panel'), 'predict', {
    anim: el.querySelector('pc-phase-anim'),
    onState: renderOpts,
    onEnd: () => load(),
    endAction: () => ({ label: 'Ver no mapa', fn: () => { store.set({ mapFocus: { tag: mes.replace('-', '_'), area: area || fi?.areas.find((a) => a.models.length)?.area, tab: 'map' } }); store.set({ screen: 'map' }); } }),
  });
  const renderStatus = () => { $('#status-card').innerHTML = statusCardHtml('predict'); };
  const off = store.subscribe((_s, why) => {
    if (why === 'ws') { renderStatus(); load(); }
    if (why === 'python') renderOpts();
  });
  renderStatus(); load(); loadBasemap();
  return () => { off(); panel.unmount(); };
}
