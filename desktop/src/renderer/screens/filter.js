// Filtragem: recorta a malha de cada área pelas ruas e coloca cada crime da base
// unificada na célula onde aconteceu. Mapeia todos os meses; o período dos modelos é
// escolhido em Features.
// Também é aqui que o operador escolhe ONDE analisar: além das 8 áreas da dissertação, ele
// cria áreas a partir de um GeoJSON (bairro, distrito, outra cidade) — ver services/areas.js.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { mountPadraoLine } from '../components/padrao-line.js';
import { botaoRestaurar, confirmarRestaurar, seloCampo } from '../lib/padrao.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { confirmar } from '../lib/dialog.js';
import { phaseHead, animCard, statusCardHtml } from './phase.js';
import { mountRunPanel, execControls, areaLabel } from '../components/run-panel.js';
import { openGeojsonHelp } from '../components/geojson-help.js';

const nf = (n, d = 0) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: d });
const CELULAS = [100, 150, 200, 250, 300, 400, 500, 750, 1000];
const callout = (tone, html) => `<div class="callout" data-tone="${tone}">${icon(tone === 'info' ? 'info' : 'warn')}<div>${html}</div></div>`;

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('filter', '')}
    <div id="padrao-line"></div>
    <div class="card" id="areas-card"></div>
    <div class="card" id="area-new" hidden></div>
    <div id="area-run"></div>
    <div class="card">
      <h2>O que esta fase faz</h2>
      <div class="what-grid">
        <div><span class="n">1</span><div><b>Recorta a malha pelas ruas</b><span class="muted">Cada área é uma grade de células (200 m nas áreas da dissertação). Células sem nenhuma rua (represa, mata, parque) saem, porque não têm onde ocorrer furto de veículo.</span></div></div>
        <div><span class="n">2</span><div><b>Coloca cada crime na sua célula</b><span class="muted">Cada registro da base unificada vai para a célula onde aconteceu, e o app conta quantos houve por célula e por dia. O que cai fora das áreas fica de fora.</span></div></div>
        <div><span class="n">3</span><div><b>Todos os meses</b><span class="muted">Aqui entram todos os meses da base. O período usado pelos modelos é escolhido no passo seguinte, em Features.</span></div></div>
      </div>
    </div>
    <div class="card" id="opts"></div>
    <div id="run-panel"></div>
    <div id="status-card"></div>
    ${animCard('filter')}`;

  const $ = (s) => el.querySelector(s);
  let opts = null;
  let area = '';
  let lista = [];      // areas:list
  let novo = null;     // inspeção do arquivo escolhido
  let sel = new Set(); // índices dos polígonos escolhidos
  let cfg = { campo: null, modo: 'cada', nome: '', celula: 200, osm: true, busca: '' };
  let lendo = false;
  let panel = null, areaPanel = null;
  const busy = () => !!(panel?.isRunning() || areaPanel?.isRunning());

  // ── Áreas de estudo ─────────────────────────────────────────────────────────
  const cidadesIncluem = () => {
    const m = store.get().ws?.municipios || ['S.PAULO'];
    return m.includes('*') || m.some((x) => x !== 'S.PAULO');
  };
  function renderAreas() {
    const running = busy();
    const criadas = lista.filter((a) => a.criada).length;
    const semDissertacao = !lista.some((a) => !a.criada);
    $('#areas-card').innerHTML = `
      <h2>${icon('map')} Áreas de estudo <span class="spacer"></span>
        <button class="btn sm" data-act="help" type="button">${icon('info')} O que é GeoJSON?</button>
        <button class="btn sm" data-act="import-base" type="button" ${running || lendo ? 'disabled' : ''} title="Malhas de células, ruas e pontos de interesse (GeoJSON) de uma pasta, de uma vez">${icon('folder')} Importar malhas (pasta)</button>
        <button class="btn sm" data-act="import-files" type="button" ${running || lendo ? 'disabled' : ''} title="Escolha vários arquivos GeoJSON de uma vez">${icon('folder')} Importar malhas (arquivos)</button>
        <button class="btn sm primary" data-act="add" type="button" ${running || lendo ? 'disabled' : ''}>${lendo ? '<i class="spin"></i> Lendo o arquivo…' : `${icon('folder')} Adicionar área (GeoJSON)`}</button></h2>
      <p class="muted" style="margin-bottom:10px">Onde o app analisa. As 8 áreas da dissertação vêm prontas. Para analisar um bairro, um distrito ou outra cidade do estado,
        adicione o contorno dela (GeoJSON, KML, Shapefile .zip ou GeoPackage): o app gera a grade de células e a área segue Filtragem, Features, Treino, Previsão e Mapa
        com o nome que você der. Também dá para arrastar o arquivo para este quadro.</p>
      ${semDissertacao ? callout('warn', `<b>Não há malha das áreas da dissertação na pasta de trabalho.</b> Ela fica na pasta <span class="mono">base</span> do Pre-Crime,
        que não vai para o git: um instalador gerado de um clone do GitHub sai sem ela. Importe as malhas de uma pasta ou de vários arquivos de uma vez, ou arraste para este quadro.
        <b>O nome do arquivo não importa</b>: o app olha o conteúdo. Muitos polígonos pequenos são uma malha de células; linhas são ruas; pontos são pontos de interesse.
        O número no nome (<span class="mono">area_11</span>, <span class="mono">grids_area_11</span>) só diz de qual área é; sem número, a malha vira uma área nova.
        <div class="btn-row" style="margin-top:8px"><button class="btn primary" data-act="import-base" type="button" ${running || lendo ? 'disabled' : ''}>${icon('folder')} Escolher a pasta</button>
          <button class="btn" data-act="import-files" type="button" ${running || lendo ? 'disabled' : ''}>${icon('folder')} Escolher os arquivos</button></div>`) : ''}
      ${resultadoImport()}
      ${lista.length ? `<div class="tbl-wrap"><table class="tbl areas-tbl"><thead><tr><th>Área</th><th>Origem</th><th class="r">Células</th><th class="r">km²</th><th>Ruas</th><th>Pontos de interesse</th><th>Filtragem</th><th></th></tr></thead>
        <tbody>${lista.map((a) => `<tr>
          <td><b>${esc(a.nome || areaLabel(a.area))}</b>${a.nome ? ` <span class="muted mono small-id">${esc(a.area)}</span>` : ''}</td>
          <td>${a.criada ? `<span class="tag-chip" title="${esc(a.arquivo || '')}">${a.importada ? 'Malha importada' : 'GeoJSON'} · ${nf(a.celula)} m</span>` : '<span class="muted">Dissertação · 200 m</span>'}</td>
          <td class="r num">${a.celulas != null ? nf(a.celulas) : '—'}</td>
          <td class="r num">${a.km2 != null ? nf(a.km2, 1) : '—'}</td>
          <td>${a.ruas ? icon('check') : '<span class="muted">—</span>'}</td>
          <td>${a.pois ? icon('check') : '<span class="muted">—</span>'}</td>
          <td>${a.filtrada ? `<span class="pill" data-status="done">${icon('check')}feita</span>` : '<span class="pill" data-status="pending">falta</span>'}
            ${a.foraDaCapital && !cidadesIncluem() ? '<span class="pill" data-status="partial" title="A Limpeza está só com a capital">fora da capital</span>' : ''}</td>
          <td class="r nowrap">${!a.ruas || !a.pois ? `<button class="btn sm" data-osm="${esc(a.area)}" ${running ? 'disabled' : ''} title="${a.criada ? 'Baixar do OpenStreetMap' : 'Baixa do OpenStreetMap só o que falta. São as ruas e os pontos de hoje, não os da dissertação: para repetir a dissertação, importe os arquivos dela.'}">${icon('refresh')} Ruas e POIs</button>` : ''}${a.criada ? `
            <button class="btn sm" data-rm="${esc(a.area)}" ${running ? 'disabled' : ''} title="Remover esta área" aria-label="Remover ${esc(a.nome || a.area)}">${icon('x')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">Nenhuma malha na pasta de trabalho. Importe as malhas da dissertação ou adicione uma área.</div>'}
      ${criadas && lista.some((a) => a.criada && a.foraDaCapital) && !cidadesIncluem()
        ? callout('warn', `Há área fora da capital, mas a <b>Limpeza</b> está só com São Paulo (capital): os crimes dessas áreas não entram na base.
          <a href="#" data-go="clean">Escolha as cidades na Limpeza</a> e rode Limpeza e Filtragem de novo.`) : ''}`;
  }

  async function loadAreas() {
    try { lista = await call('areas:list'); } catch (e) { lista = []; toast(e.message, 'err'); }
    renderAreas();
  }

  // ── Nova área: conferência do arquivo ─────────────────────────────────────────
  const nomeDe = (f) => (cfg.campo && f.props[cfg.campo] ? f.props[cfg.campo] : `Polígono ${f.i + 1}`);
  function preview() {
    const [x0, y0, x1, y1] = novo.bbox;
    const kx = Math.cos((((y0 + y1) / 2) * Math.PI) / 180);
    const W = 560, H = 360, pad = 10;
    const s = Math.min((W - 2 * pad) / Math.max(1e-9, (x1 - x0) * kx), (H - 2 * pad) / Math.max(1e-9, y1 - y0));
    const ox = (W - (x1 - x0) * kx * s) / 2, oy = (H - (y1 - y0) * s) / 2;
    const P = ([x, y]) => `${((x - x0) * kx * s + ox).toFixed(1)},${((y1 - y) * s + oy).toFixed(1)}`;
    return `<svg class="area-prev" viewBox="0 0 ${W} ${H}" role="img" aria-label="Contorno dos polígonos do arquivo">
      ${novo.feicoes.slice(0, 3000).map((f) => `<g data-poly="${f.i}" class="${sel.has(f.i) ? 'on' : ''}"><title>${esc(nomeDe(f))} · ${nf(f.km2, 2)} km²</title>
        ${f.aneis.map((r) => `<polygon points="${r.map(P).join(' ')}"/>`).join('')}</g>`).join('')}
    </svg>`;
  }
  const estimativa = () => {
    const km2 = novo.feicoes.filter((f) => sel.has(f.i)).reduce((s, f) => s + f.km2, 0);
    return { km2, celulas: Math.round((km2 * 1e6) / (cfg.celula * cfg.celula)) };
  };

  function renderNovo() {
    const box = $('#area-new');
    if (!novo) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const e = estimativa();
    const n = sel.size;
    const busca = cfg.busca.trim().toLowerCase();
    const vis = novo.feicoes.filter((f) => !busca || nomeDe(f).toLowerCase().includes(busca));
    const fora = novo.feicoes.some((f) => sel.has(f.i) && f.foraDaCapital);
    const nAreas = cfg.modo === 'juntar' ? (n ? 1 : 0) : n;
    const porArea = nAreas ? e.celulas / nAreas : 0;
    const pequenas = cfg.modo === 'cada' ? novo.feicoes.filter((f) => sel.has(f.i) && (f.km2 * 1e6) / (cfg.celula * cfg.celula) < 30).length : 0;
    // o arquivo já é uma malha de células (muitos polígonos pequenos)? então não é um contorno: importa como malha
    const ehMalha = novo.n >= 20 && novo.feicoes.filter((f) => f.km2 <= 4).length >= 0.8 * novo.feicoes.length;
    box.innerHTML = `
      <h2>${icon('map')} Nova área: <span class="mono" style="text-transform:none;letter-spacing:0">${esc(novo.original)}</span> <span class="spacer"></span>
        <button class="btn sm" data-act="cancel-new" type="button">${icon('x')} Descartar</button></h2>
      <p class="muted">${nf(novo.n)} polígono(s) · ${nf(novo.km2Total, 1)} km² · projeção do arquivo ${esc(novo.crs)}${novo.ignoradas ? ` · ${nf(novo.ignoradas)} feição(ões) sem polígono (pontos ou linhas) ignorada(s)` : ''}</p>
      ${ehMalha ? callout('warn', `<b>Este arquivo já é uma malha de células</b> (${nf(novo.n)} polígonos pequenos), não o contorno de uma área. Criar uma área por polígono faria ${nf(novo.n)} áreas.
        Importe como malha: as células ficam como estão, e o número no nome (por exemplo <span class="mono">area_11</span>) diz de qual área ela é.
        <div class="btn-row" style="margin-top:8px"><button class="btn primary" data-act="import-fonte" type="button">${icon('folder')} Importar como malha</button></div>`) : ''}
      <div class="area-grid">
        <div>${preview()}<p class="muted small">Clique num polígono para escolher ou tirar. Em destaque, os escolhidos.</p></div>
        <div class="area-form">
          <label class="field">Campo com o nome
            <select id="an-campo">${novo.campos.length ? novo.campos.map((c) => `<option value="${esc(c.nome)}" ${c.nome === cfg.campo ? 'selected' : ''}>${esc(c.nome)}${c.exemplos.length ? ` — ex.: ${esc(c.exemplos.slice(0, 2).join(', '))}` : ''}</option>`).join('') : '<option value="">(o arquivo não tem propriedades)</option>'}</select></label>
          <div class="field"><span>Como criar</span>
            <label class="opt"><input type="radio" name="an-modo" value="cada" ${cfg.modo === 'cada' ? 'checked' : ''}><span><b>Cada polígono vira uma área</b><span class="muted">Um modelo por bairro. Bom quando cada um tem bastante registro.</span></span></label>
            <label class="opt"><input type="radio" name="an-modo" value="juntar" ${cfg.modo === 'juntar' ? 'checked' : ''}><span><b>Juntar os escolhidos numa área só</b><span class="muted">Um modelo para a região toda: mais dados para aprender.</span></span></label>
            ${cfg.modo === 'juntar' ? `<input id="an-nome" class="an-nome" maxlength="60" placeholder="Nome da área (ex.: Zona Oeste)" value="${esc(cfg.nome)}">` : ''}
          </div>
          <label class="field">Tamanho da célula
            <select id="an-celula">${CELULAS.map((c) => `<option value="${c}" ${c === cfg.celula ? 'selected' : ''}>${c} m${c === 200 ? ' (como na dissertação)' : ''}</option>`).join('')}</select></label>
          <label class="chk"><input type="checkbox" id="an-osm" ${cfg.osm ? 'checked' : ''}> Baixar ruas e pontos de interesse do OpenStreetMap <span class="muted">(precisa de internet)</span></label>
          <div class="an-est"><b class="num">${nf(nAreas)}</b> área(s) · <b class="num">${nf(e.celulas)}</b> células de ${cfg.celula} m (estimativa) · ${nf(e.km2, 1)} km²</div>
          ${fora && !cidadesIncluem() ? callout('warn', 'Há polígono <b>fora da capital</b>. A Limpeza está só com São Paulo (capital): depois de criar, <a href="#" data-go="clean">inclua a cidade na Limpeza</a> e rode a Limpeza de novo.') : ''}
          ${pequenas ? callout('info', `${nf(pequenas)} polígono(s) com menos de 30 células de ${cfg.celula} m. Área pequena tem poucos crimes por célula: considere células maiores ou juntar os polígonos.`) : ''}
          ${porArea > 40000 ? callout('warn', 'Área grande para este tamanho de célula: o treino fica pesado. Considere células maiores.') : ''}
          <div class="btn-row"><button class="btn primary" data-act="create" ${!n || busy() || (cfg.modo === 'juntar' && !cfg.nome.trim()) ? 'disabled' : ''}>${icon('play')} Criar ${nAreas > 1 ? `${nf(nAreas)} áreas` : 'a área'}</button></div>
        </div>
      </div>
      <div class="an-list-head"><b>Polígonos</b> <span class="muted">${nf(n)} de ${nf(novo.n)} escolhido(s)</span><span class="spacer"></span>
        ${novo.n > 8 ? `<input id="an-busca" type="search" placeholder="Buscar pelo nome" value="${esc(cfg.busca)}" aria-label="Buscar polígono">` : ''}
        <button class="link-btn" data-act="sel-all" type="button">todos</button> · <button class="link-btn" data-act="sel-none" type="button">nenhum</button></div>
      <div class="chips an-list">${vis.slice(0, 300).map((f) => `<label class="chip"><input type="checkbox" data-pi="${f.i}" ${sel.has(f.i) ? 'checked' : ''}><span>${esc(nomeDe(f))} <i class="num">${nf(f.km2, 1)} km²</i></span></label>`).join('')}
        ${vis.length > 300 ? `<span class="muted small">+${nf(vis.length - 300)} (use a busca)</span>` : ''}</div>`;
  }

  function abrirNovo(r) {
    novo = r;
    sel = new Set(r.feicoes.map((f) => f.i));
    cfg = { campo: r.campoSugerido || r.campos[0]?.nome || null, modo: 'cada', nome: '', celula: 200, osm: true, busca: '' };
    renderNovo();
    scrollToEl($('#area-new'));
  }

  async function pick(fn) {
    if (lendo) return;
    lendo = true; renderAreas();
    try {
      const r = await fn();
      if (r) abrirNovo(r);
    } catch (e) { toast(e.message, 'err', 10000); }
    lendo = false; renderAreas();
  }

  // malhas, ruas e pontos de interesse importados de uma vez (pelo conteúdo dos arquivos)
  let importRes = null;
  function resultadoImport() {
    const r = importRes;
    if (!r) return '';
    const n = r.resumo.malhas + r.resumo.ruas + r.resumo.pois;
    const lst = (titulo, itens, tom = 'muted') => (itens.length ? `<p class="small ${tom}"><b>${titulo}</b> ${itens.map(esc).join(' · ')}</p>` : '');
    return `<div class="card-sub imp-res"><h3 class="pgroup">Importação <span class="muted">— ${n ? `${r.resumo.malhas} malha(s), ${r.resumo.ruas} arquivo(s) de ruas e ${r.resumo.pois} de pontos de interesse copiados` : 'nada novo copiado'}</span>
        <button class="link-btn" data-act="imp-close" type="button">fechar</button></h3>
      ${r.areas.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Área</th><th>Malha</th><th>Ruas</th><th>Pontos de interesse</th></tr></thead>
        <tbody>${r.areas.map((a) => `<tr><td><b>${esc(a.nome || areaLabel(a.area))}</b> <span class="muted mono small-id">${esc(a.area)}</span>${a.nova ? ' <span class="pill" data-status="partial">área nova</span>' : ''}</td>
          <td>${esc(a.malha || '—')}</td><td>${a.ruas ? esc(a.ruas) : '<span class="muted">—</span>'}</td><td>${a.pontos ? esc(a.pontos) : '<span class="muted">—</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${r.avisos.map((t) => callout('warn', esc(t))).join('')}
      ${r.contornos.length ? callout('info', `${r.contornos.length} arquivo(s) com contorno (poucos polígonos grandes), não malha: ${esc(r.contornos.join(', '))}. Para esses, use <b>Adicionar área</b>: o app gera a malha de células a partir do contorno.`) : ''}
      ${lst('Já existiam (mantidos):', r.existiam)}
      ${lst('Ignorados:', [...r.invalidos, ...r.ignorados])}</div>`;
  }
  async function mostraBase(r) {
    importRes = r;
    lista = r.lista;
    const n = r.resumo.malhas + r.resumo.ruas + r.resumo.pois;
    toast(n ? `Importados: ${r.resumo.malhas} malha(s), ${r.resumo.ruas} de ruas e ${r.resumo.pois} de pontos de interesse.` : 'Nada novo para importar. Veja o resumo no quadro Áreas de estudo.', n ? 'ok' : 'info', 8000);
    await refreshWorkspace();
  }
  async function importarBase(canal, ...args) {
    if (lendo) return;
    lendo = true; renderAreas();
    try { const r = await call(canal, ...args); if (r) { novo = null; renderNovo(); await mostraBase(r); } } catch (e) { toast(e.message, 'err', 12000); }
    lendo = false; renderAreas(); renderOpts();
  }
  // arrastar: vários arquivos, uma pasta ou os arquivos das malhas → malhas da dissertação; um arquivo só → área nova
  async function soltar(ps) {
    if (lendo) return;
    lendo = true; renderAreas();
    try {
      const r = await call('areas:drop', ps);
      if (r?.tipo === 'base') await mostraBase(r);
      else if (r) abrirNovo(r);
    } catch (e) { toast(e.message, 'err', 12000); }
    lendo = false; renderAreas(); renderOpts();
  }

  async function create() {
    if (!novo) return;
    const indices = novo.feicoes.filter((f) => sel.has(f.i)).map((f) => f.i);
    try {
      await areaPanel.run({ fonte: novo.fonte, indices: indices.length === novo.n ? null : indices, campoNome: cfg.campo, modo: cfg.modo, nome: cfg.nome, celula: cfg.celula, osm: cfg.osm });
      novo = null; renderNovo(); renderAreas();
      scrollToEl($('#area-run'));
    } catch (e) { toast(e.message, 'err', 8000); }
  }

  // ── Malha e execução da Filtragem ────────────────────────────────────────────
  function renderOpts() {
    const { ws, python } = store.get();
    if (!opts || !ws) return;
    const clean = ws.phases?.find((p) => p.id === 'clean');
    const blocker = clean?.status === 'pending'
      ? { text: 'A Filtragem usa a base unificada. Rode a Limpeza antes.', go: 'clean', goLabel: 'Ir para a Limpeza' }
      : !ws.base?.streets?.ok ? { text: 'Faltam as malhas das áreas na pasta de trabalho. Use "Importar malhas da dissertação" no quadro Áreas de estudo, acima.' } : null;
    $('#opts').innerHTML = `
      <h2>Malha e execução</h2>
      <label class="opt"><input type="checkbox" id="dedup" ${opts.removerCelulasRepetidas ? 'checked' : ''}>
        <span><b>Juntar as células repetidas da malha</b> ${seloCampo(!opts.removerCelulasRepetidas, 'desmarcada (manter como na dissertação)')}
        <span class="muted">As malhas que vêm com o app trazem a mesma célula em mais de uma linha (inteira e recortada pelos limites de batalhão e distrito):
        na área 01 são 2.764 linhas para 1.206 células. Sem esta opção, cada crime nessas células é contado duas vezes ou mais.
        Desmarcada, a Filtragem fica igual à usada na dissertação; marcada, é o recomendado para análises novas. As áreas criadas por GeoJSON não têm células repetidas.
        Os resultados com e sem células repetidas não são comparáveis entre si.</span></span></label>
      ${opts.removerCelulasRepetidas ? `<div class="btn-row" style="margin-top:6px">${botaoRestaurar('data-act="filter-reset"')}</div>` : ''}
      ${execControls({ job: 'filter', label: 'Filtragem', python, running: busy(), areas: ws.areas || [], area, blocker,
        note: 'Leva de alguns segundos a poucos minutos por área.' })}`;
  }

  el.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.id === 'dedup') {
      try {
        opts = await call('filter:set', { removerCelulasRepetidas: t.checked });
        await refreshWorkspace();
        toast(opts.removerCelulasRepetidas ? 'A Filtragem vai juntar as células repetidas. Rode de novo para valer.' : 'A Filtragem vai manter as células como na dissertação.', 'ok', 6000);
      } catch (err) { toast(err.message, 'err'); }
    }
    if (t.matches('[data-exec-area]')) area = t.value;
    if (t.id === 'an-campo') { cfg.campo = t.value || null; renderNovo(); }
    if (t.name === 'an-modo') { cfg.modo = t.value; renderNovo(); }
    if (t.id === 'an-celula') { cfg.celula = Number(t.value); renderNovo(); }
    if (t.id === 'an-osm') cfg.osm = t.checked;
    if (t.matches('[data-pi]')) { const i = Number(t.dataset.pi); if (t.checked) sel.add(i); else sel.delete(i); renderNovo(); }
  });
  el.addEventListener('input', (e) => {
    if (e.target.id === 'an-nome') {
      cfg.nome = e.target.value;
      const b = el.querySelector('[data-act="create"]');
      if (b) b.disabled = !sel.size || busy() || !cfg.nome.trim();
    }
    if (e.target.id === 'an-busca') {
      cfg.busca = e.target.value;
      renderNovo();
      const i = $('#an-busca'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
    }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="filter-reset"]')) {
      if (!(await confirmarRestaurar('A malha', 'A Filtragem volta a manter as células repetidas, como na dissertação. Rode de novo para valer.'))) return;
      try { opts = await call('filter:set', { removerCelulasRepetidas: false }); await refreshWorkspace(); renderOpts(); toast('Filtragem de volta ao padrão da dissertação.', 'ok'); } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (e.target.closest('a[data-go]')) e.preventDefault();
    if (e.target.closest('[data-act="run"]')) {
      try { await panel.run({ area: area || null }); renderOpts(); scrollToEl($('#run-panel')); } catch (err) { toast(err.message, 'err', 8000); }
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'help') openGeojsonHelp();
    if (act === 'add') pick(() => call('areas:pick'));
    if (act === 'import-base') importarBase('areas:importBase');
    if (act === 'import-files') importarBase('areas:importFiles');
    if (act === 'imp-close') { importRes = null; renderAreas(); }
    if (act === 'import-fonte' && novo) importarBase('areas:importFonte', novo.fonte);
    if (act === 'cancel-new') { novo = null; renderNovo(); }
    if (act === 'create') create();
    const visiveis = () => { const b = cfg.busca.trim().toLowerCase(); return novo.feicoes.filter((f) => !b || nomeDe(f).toLowerCase().includes(b)); };
    if (act === 'sel-all' && novo) { visiveis().forEach((f) => sel.add(f.i)); renderNovo(); }
    if (act === 'sel-none' && novo) { visiveis().forEach((f) => sel.delete(f.i)); renderNovo(); }
    const poly = e.target.closest('[data-poly]');
    if (poly && novo) { const i = Number(poly.dataset.poly); if (sel.has(i)) sel.delete(i); else sel.add(i); renderNovo(); }
    const osm = e.target.closest('[data-osm]')?.dataset.osm;
    if (osm) {
      try { await areaPanel.run({ osmPara: osm }); renderAreas(); scrollToEl($('#area-run')); } catch (err) { toast(err.message, 'err', 8000); }
    }
    const rm = e.target.closest('[data-rm]')?.dataset.rm;
    if (rm && await confirmar(`Remover a área ${areaLabel(rm)}?`, {
      detalhe: 'A grade, as ruas, os pontos de interesse e o que já foi feito para ela (crimes, dataset, modelos e previsões) vão para areas/_removidas na pasta de trabalho. Dá para recuperar de lá.',
      ok: 'Remover a área', perigo: true,
    })) {
      try { lista = await call('areas:remove', rm); await refreshWorkspace(); renderAreas(); toast(`${areaLabel(rm)} removida.`, 'ok'); } catch (err) { toast(err.message, 'err'); }
    }
    const open = e.target.closest('[data-open]');
    if (open) call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err'));
  });

  // arrastar o arquivo para o quadro das áreas
  const card = $('#areas-card');
  for (const ev of ['dragenter', 'dragover']) card.addEventListener(ev, (e) => { e.preventDefault(); card.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) card.addEventListener(ev, () => card.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const ps = [...(e.dataTransfer?.files || [])].map((f) => window.pc.pathForFile(f)).filter(Boolean);
    if (ps.length) soltar(ps);
  });

  areaPanel = mountRunPanel($('#area-run'), 'areas', {
    onState: () => { renderAreas(); renderOpts(); },
    onEnd: async (status) => {
      await refreshWorkspace();
      await loadAreas();
      renderOpts();
      if (status === 'ok') toast('Pronto. Agora rode a Filtragem da área nova (escolha-a na lista de áreas da execução).', 'ok', 8000);
    },
  });
  panel = mountRunPanel($('#run-panel'), 'filter', {
    anim: el.querySelector('pc-phase-anim'), onState: () => { renderOpts(); renderAreas(); }, onEnd: () => { renderOpts(); loadAreas(); },
  });
  const renderStatus = () => { $('#status-card').innerHTML = statusCardHtml('filter'); };
  const off = store.subscribe((_s, why) => { if (why === 'ws') { renderStatus(); renderOpts(); renderAreas(); } if (why === 'python') renderOpts(); });
  renderStatus();
  renderAreas();
  loadAreas();
  call('filter:get').then((o) => { opts = o; renderOpts(); }).catch((e) => toast(e.message, 'err'));
  const pLine = mountPadraoLine(el.querySelector('#padrao-line'), 'filter');
  return () => { off(); panel.unmount(); areaPanel.unmount(); pLine.unmount(); };
}
