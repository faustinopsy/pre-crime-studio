// Pontos de interesse: de onde vêm os pontos usados no ajuste do Ensemble (POI Boost).
// Conjuntos versionados em <pasta>/pois/conjuntos/<id>/ (arquivos + manifesto.json). O da dissertação
// (base/pois) é o padrão e não pode ser removido. Conjuntos novos: download do OpenStreetMap com as
// categorias escolhidas ou um arquivo próprio (GeoJSON, KML, Shapefile .zip, GeoPackage, CSV). Todo
// conjunto novo nasce como rascunho: o operador confere as contagens e o mapa e só então salva.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { confirmar } from '../lib/dialog.js';
import { seloPadrao, botaoRestaurar, confirmarRestaurar } from '../lib/padrao.js';
import { mountRunPanel, areaLabel } from '../components/run-panel.js';

const DISS = 'dissertacao';
const SEM = '(sem categoria)';
const IGN = '__ignorar__';
const CAT_RE = /^[^\s:]{1,40}:[^\s]{1,60}$/;
const nf = (n) => Number(n || 0).toLocaleString('pt-BR');
const dataBr = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ORIGEM = { dissertacao: 'Dissertação', osm: 'OpenStreetMap', arquivo: 'Arquivo próprio' };
const somaDict = (d) => Object.values(d || {}).reduce((s, v) => s + (Number(v) || 0), 0);
const slug = (v) => String(v).toLowerCase().trim().replace(/\s+/g, '_').replace(/:/g, '_').slice(0, 50);
const CORES = ['#d92d20', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];

export function mount(el) {
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('map')} Pontos de interesse</h1>
      <p>Os pontos (bares, delegacias, lojas…) que o Ensemble usa para ajustar o risco de cada célula. Abre com o conjunto da dissertação. Você pode baixar um conjunto novo do OpenStreetMap com as categorias que escolher ou importar um arquivo seu. Os pesos de cada categoria ficam na tela <button class="link-btn" data-go="risk">Mapa de risco</button>, aba Pontos de interesse.</p></div></div>
    <section class="card" id="p-sets"><h2>Conjuntos</h2><div class="empty">Carregando…</div></section>
    <section class="card" id="p-draft" hidden></section>
    <section class="card" id="p-map"></section>
    <section class="card" id="p-osm"></section>
    <section class="card" id="p-imp"></section>
    <div id="p-run"></div>`;
  const $ = (s) => el.querySelector(s);
  let L = null;            // pois:list
  let cat = [];            // catálogo do OpenStreetMap
  let areas = [];          // áreas da pasta de trabalho
  let mudanca = null;      // categorias que apareceram e sumiram na última troca
  let mapa = { id: null, area: null, res: null };
  let detalhe = null;      // manifesto aberto
  const osm = { marcados: new Set(), livre: '', areas: new Set(), dedup: 25, juntar: '', nome: '' };
  let imp = null;          // { insp, campoCategoria, campoNome, campoAbertura, campoFechamento, mapa, dedup, juntar, nome, areas }
  let draftId = null;

  const running = () => panel?.isRunning();
  const prontos = () => (L?.conjuntos || []).filter((c) => c.status === 'pronto');
  const conj = (id) => (L?.conjuntos || []).find((c) => c.id === id);
  const catalogoChaves = () => Object.fromEntries(cat.flatMap((g) => g.itens).filter((i) => i.valor !== '*').map((i) => [i.valor.toLowerCase(), `${i.chave}:${i.valor}`]));

  // ── conjuntos ────────────────────────────────────────────────────────────────────────────
  function renderSets() {
    const box = $('#p-sets');
    if (!L) return;
    const ativo = conj(L.ativo) || conj(DISS);
    const lista = L.conjuntos.filter((c) => c.status === 'pronto');
    box.innerHTML = `<h2>Conjuntos <span class="spacer"></span>
        ${L.ativo === DISS ? seloPadrao() : '<span class="pill sel-pers" data-status="partial">diferente da dissertação</span>'}</h2>
      <p class="muted">Ativo: <b>${esc(ativo?.nome || 'Dissertação')}</b>. Ele vale para as próximas Previsões e para a pré-visualização do Mapa de risco. O Modo científico escolhe o conjunto no próprio formulário (padrão: dissertação).</p>
      ${mudanca && (mudanca.apareceram.length || mudanca.sumiram.length) ? `<div class="callout" data-tone="warn">${icon('info')}<div>
        Os pesos das categorias em comum foram mantidos.
        ${mudanca.apareceram.length ? `<br><b>Apareceram</b> (usam o peso dos não listados até você mudar): ${esc(mudanca.apareceram.slice(0, 25).join(', '))}${mudanca.apareceram.length > 25 ? ` e mais ${mudanca.apareceram.length - 25}` : ''}.` : ''}
        ${mudanca.sumiram.length ? `<br><b>Sumiram</b> (o peso fica guardado, mas não tem efeito): ${esc(mudanca.sumiram.slice(0, 25).join(', '))}${mudanca.sumiram.length > 25 ? ` e mais ${mudanca.sumiram.length - 25}` : ''}.` : ''}
        <br><button class="link-btn" data-go="risk">Conferir os pesos no Mapa de risco</button></div></div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Conjunto</th><th>Origem</th><th>Criado em</th><th class="r">Pontos</th><th class="r">Categorias</th><th class="r">Áreas</th><th></th></tr></thead>
      <tbody>${lista.map((c) => `<tr class="${c.ativo ? 'sel' : ''}">
        <td><b>${esc(c.nome || c.id)}</b> ${c.ativo ? '<span class="pill" data-status="done">ativo</span>' : ''}<br><span class="muted small mono">${esc(c.id)}${c.hash ? ` · ${esc(c.hash.slice(0, 12))}` : ''}</span>
          ${c.comDatas ? '<br><span class="muted small">com datas de abertura e fechamento</span>' : ''}</td>
        <td>${esc(ORIGEM[c.origem] || c.origem)}${c.origem === 'osm' && c.baixado_em ? `<br><span class="muted small">baixado em ${esc(dataBr(c.baixado_em))}</span>` : ''}${c.arquivo ? `<br><span class="muted small">${esc(c.arquivo)}</span>` : ''}</td>
        <td>${esc(dataBr(c.criado_em))}</td>
        <td class="r num">${nf(c.total)}</td><td class="r num">${nf(c.nCategorias)}</td><td class="r num">${nf(c.areas.length)}</td>
        <td class="r nowrap">
          ${c.ativo ? '' : `<button class="btn sm primary" data-p="ativar" data-id="${esc(c.id)}" ${running() ? 'disabled' : ''}>${icon('check')} Ativar</button>`}
          <button class="btn sm" data-p="ver" data-id="${esc(c.id)}">${icon('map')} Mapa</button>
          <button class="btn sm" data-p="detalhe" data-id="${esc(c.id)}">${icon('info')} Detalhes</button>
          ${c.protegido ? '' : `<button class="btn sm" data-p="remover" data-id="${esc(c.id)}" title="Move a pasta do conjunto para pois/conjuntos/_removidos" ${running() ? 'disabled' : ''}>${icon('x')}</button>`}
        </td></tr>`).join('')}</tbody></table></div>
      ${detalhe ? detalheHtml(detalhe) : ''}
      <div class="btn-row" style="margin-top:12px">${botaoRestaurar('data-p="restaurar"', { disabled: L.ativo === DISS || running() })}</div>`;
  }

  function detalheHtml(m) {
    const cats = {};
    for (const c of Object.values(m.contagem || {})) for (const [k, n] of Object.entries(c)) cats[k] = (cats[k] || 0) + n;
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const consulta = m.consulta?.itens ? m.consulta.itens.map((i) => `${i.chave}=${i.valor}`).join(', ') : null;
    return `<div class="card-sub"><h3 class="pgroup">${esc(m.nome || m.id)} <span class="muted">— manifesto</span> <button class="link-btn" data-p="fechar">fechar</button></h3>
      <ul class="kv">
        <li><b>Origem</b> ${esc(ORIGEM[m.origem] || m.origem)}${consulta ? ` · consulta: <span class="mono">${esc(consulta)}</span>` : ''}</li>
        ${m.arquivo ? `<li><b>Arquivo</b> ${esc(m.arquivo.nome)} · sha256 <span class="mono">${esc(String(m.arquivo.sha256 || '').slice(0, 16))}…</span> · ${esc(m.arquivo.crs || '')}</li>` : ''}
        ${m.mapeamento ? `<li><b>Mapeamento</b> categoria: ${esc(m.mapeamento.campoCategoria || '—')} · nome: ${esc(m.mapeamento.campoNome || '—')} · abertura: ${esc(m.mapeamento.campoAbertura || '—')} · fechamento: ${esc(m.mapeamento.campoFechamento || '—')}</li>` : ''}
        <li><b>Hash do conjunto</b> <span class="mono">${esc(m.hash || '—')}</span></li>
        ${m.dedup_m != null ? `<li><b>Duplicados</b> ${nf(somaDict(m.duplicados_removidos))} removido(s) (mesma categoria e mesmo nome a menos de ${nf(m.dedup_m)} m)${m.fora_do_contorno ? ` · ${nf(somaDict(m.fora_do_contorno))} ponto(s) fora do contorno das áreas` : ''}</li>` : ''}
        ${m.juntado_com ? `<li><b>Juntado com</b> ${esc(m.juntado_com)}</li>` : ''}
      </ul>
      ${m.aviso ? `<div class="callout" data-tone="warn">${icon('warn')}<div>${esc(m.aviso)}</div></div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Categoria</th><th class="r">Pontos (todas as áreas)</th></tr></thead>
        <tbody>${top.slice(0, 40).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="r num">${nf(n)}</td></tr>`).join('')}</tbody></table></div>
      ${top.length > 40 ? `<p class="note">E mais ${top.length - 40} categoria(s).</p>` : ''}</div>`;
  }

  // ── rascunho (conferir e salvar) ─────────────────────────────────────────────────────────
  function renderDraft() {
    const box = $('#p-draft');
    const rascunhos = (L?.conjuntos || []).filter((c) => c.status !== 'pronto');
    const d = conj(draftId) && conj(draftId).status !== 'pronto' ? conj(draftId) : rascunhos[0];
    if (!d) { box.hidden = true; return; }
    draftId = d.id;
    box.hidden = false;
    box.innerHTML = `<h2>Conferir o conjunto novo <span class="pill" data-status="partial">rascunho</span></h2>
      <p class="muted">${esc(ORIGEM[d.origem] || d.origem)} · ${nf(d.total)} pontos em ${d.areas.length} área(s), ${d.nCategorias} categoria(s)${d.duplicados ? ` · ${nf(somaDict(d.duplicados))} duplicado(s) removido(s)` : ''}. Confira as contagens e o mapa abaixo antes de salvar.</p>
      ${d.aviso ? `<div class="callout" data-tone="warn">${icon('warn')}<div>${esc(d.aviso)}</div></div>` : ''}
      <div id="p-draft-tbl" class="empty">Carregando as contagens…</div>
      <div class="sci-grid" style="margin-top:10px">
        <label class="field">Nome do conjunto<input type="text" id="d-nome" maxlength="80" value="${esc(d.nome || '')}"></label>
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary" data-p="salvar" data-id="${esc(d.id)}">${icon('save')} Salvar como conjunto</button>
        <button class="btn" data-p="salvar-ativar" data-id="${esc(d.id)}">${icon('check')} Salvar e ativar</button>
        <button class="btn" data-p="descartar" data-id="${esc(d.id)}">${icon('x')} Descartar</button>
      </div>`;
    call('pois:detail', d.id).then((m) => {
      const t = $('#p-draft-tbl');
      if (!t) return;
      const as = Object.keys(m.contagem || {}).sort();
      const cats = {};
      for (const a of as) for (const [k, n] of Object.entries(m.contagem[a])) cats[k] = (cats[k] || 0) + n;
      const ks = Object.keys(cats).sort((a, b) => cats[b] - cats[a]);
      const mostrar = ks.slice(0, 30);
      t.className = '';
      t.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Categoria</th>${as.map((a) => `<th class="r">${esc(areaLabel(a))}</th>`).join('')}<th class="r">Total</th></tr></thead>
        <tbody>${mostrar.map((k) => `<tr><td>${esc(k)}</td>${as.map((a) => `<td class="r num">${m.contagem[a][k] ? nf(m.contagem[a][k]) : '<span class="muted">0</span>'}</td>`).join('')}<td class="r num"><b>${nf(cats[k])}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>${as.map((a) => `<td class="r num">${nf(somaDict(m.contagem[a]))}</td>`).join('')}<td class="r num">${nf(m.total)}</td></tr></tfoot></table></div>
        ${ks.length > 30 ? `<p class="note">Mostrando as 30 categorias com mais pontos de ${ks.length}.</p>` : ''}
        ${(m.avisos || []).length ? `<p class="note">${icon('info')} ${esc(m.avisos.join(' '))}</p>` : ''}`;
      if (mapa.id !== d.id) { mapa = { id: d.id, area: as[0] || null, res: null }; loadMapa(); }
    }).catch((err) => { const t = $('#p-draft-tbl'); if (t) t.textContent = err.message; });
  }

  // ── mapa de pré-visualização ─────────────────────────────────────────────────────────────
  function svgPontos(res) {
    const ps = res.pontos;
    if (!ps.length) return '<p class="muted">Nenhum ponto nesta área.</p>';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ps) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pad = 0.002; x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
    const W = 560, k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
    const sx = W / ((x1 - x0) * k || 1), H = Math.max(180, Math.min(560, (y1 - y0) * sx));
    const cont = {};
    for (const p of ps) cont[p[2]] = (cont[p[2]] || 0) + 1;
    const top = Object.keys(cont).sort((a, b) => cont[b] - cont[a]).slice(0, CORES.length);
    const cor = (c) => { const i = top.indexOf(c); return i >= 0 ? CORES[i] : '#9ca3af'; };
    const ord = [...ps].sort((a, b) => (top.indexOf(b[2]) === -1) - (top.indexOf(a[2]) === -1));
    return `<svg class="prev-map" viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Pontos de interesse da área">
      <rect width="${W}" height="${H.toFixed(0)}" fill="var(--surface)"/>
      ${ord.map(([x, y, c]) => `<circle cx="${((x - x0) * k * sx).toFixed(1)}" cy="${((y1 - y) * sx).toFixed(1)}" r="2.2" fill="${cor(c)}" fill-opacity="0.8"><title>${esc(c)}</title></circle>`).join('')}
    </svg>
    <div class="prev-leg">${top.map((c) => `<span><i style="background:${cor(c)}"></i>${esc(c)} (${nf(cont[c])})</span>`).join('')}${Object.keys(cont).length > top.length ? '<span><i style="background:#9ca3af"></i>outras</span>' : ''}</div>
    ${res.total > ps.length ? `<p class="note">Mostrando ${nf(ps.length)} de ${nf(res.total)} pontos.</p>` : ''}`;
  }

  function renderMapa() {
    const box = $('#p-map');
    const lista = L?.conjuntos || [];
    if (!mapa.id || !conj(mapa.id)) mapa = { id: L?.ativo || DISS, area: null, res: null };
    const c = conj(mapa.id);
    const as = c?.areas || [];
    if (!mapa.area || !as.includes(mapa.area)) mapa.area = as[0] || null;
    box.innerHTML = `<h2>Mapa</h2>
      <div class="sci-grid">
        <label class="field">Conjunto<select id="m-id">${lista.map((x) => `<option value="${esc(x.id)}" ${x.id === mapa.id ? 'selected' : ''}>${esc(x.nome || x.id)}${x.status !== 'pronto' ? ' (rascunho)' : ''}</option>`).join('')}</select></label>
        <label class="field">Área<select id="m-area">${as.map((a) => `<option value="${a}" ${a === mapa.area ? 'selected' : ''}>${esc(areaLabel(a))}</option>`).join('')}</select></label>
      </div>
      <div id="m-svg">${mapa.res ? svgPontos(mapa.res) : as.length ? '<div class="empty">Carregando…</div>' : '<p class="muted">Este conjunto não tem pontos.</p>'}</div>`;
  }

  async function loadMapa() {
    renderMapa();
    if (!mapa.id || !mapa.area) return;
    const pedido = `${mapa.id}|${mapa.area}`;
    try {
      const r = await call('pois:preview', mapa.id, mapa.area);
      if (`${mapa.id}|${mapa.area}` === pedido) { mapa.res = r; renderMapa(); }
    } catch (err) { toast(err.message, 'err'); }
  }

  // ── download do OpenStreetMap ────────────────────────────────────────────────────────────
  function areasHtml(sel, attr) {
    return `<div class="chk-grid">${areas.map((a) => `<label class="chk"><input type="checkbox" ${attr}="${a.area}" ${sel.has(a.area) ? 'checked' : ''}> ${esc(a.nome || areaLabel(a.area))}</label>`).join('')}</div>`;
  }
  const juntarHtml = (id, v) => `<label class="field">Juntar com<select id="${id}"><option value="">Não: criar um conjunto separado</option>${prontos().map((c) => `<option value="${esc(c.id)}" ${c.id === v ? 'selected' : ''}>${esc(c.nome || c.id)}</option>`).join('')}</select></label>`;
  const dedupHtml = (id, v) => `<label class="field">Duplicados (metros)<input type="number" id="${id}" min="0" max="500" step="5" value="${esc(v)}">
    <span class="muted small">Pontos da mesma categoria e com o mesmo nome a menos dessa distância contam uma vez. 0 desliga.</span></label>`;

  function renderOsm() {
    const box = $('#p-osm');
    const dis = running() ? 'disabled' : '';
    box.innerHTML = `<h2>Baixar do OpenStreetMap</h2>
      <div class="callout" data-tone="warn">${icon('warn')}<div>O OpenStreetMap é um retrato de hoje; usado em meses passados, pode conter estabelecimentos que ainda não existiam. A data do download fica registrada no manifesto do conjunto.</div></div>
      <div class="osm-grupos">${cat.map((g) => `<fieldset class="osm-g"><legend>${esc(g.nome)}</legend>
        ${g.itens.map((i) => { const k = `${i.chave}=${i.valor}`; return `<label class="chk"><input type="checkbox" data-osm="${esc(k)}" ${osm.marcados.has(k) ? 'checked' : ''} ${dis}> ${esc(i.nome)} <span class="muted small mono">${esc(k)}</span></label>`; }).join('')}
      </fieldset>`).join('')}</div>
      <div class="sci-grid">
        <label class="field">Outras etiquetas (chave=valor, separadas por vírgula)<input type="text" id="o-livre" placeholder="ex.: amenity=atm, leisure=park" value="${esc(osm.livre)}" ${dis}></label>
        ${dedupHtml('o-dedup', osm.dedup)}
        ${juntarHtml('o-juntar', osm.juntar)}
        <label class="field">Nome do conjunto (opcional)<input type="text" id="o-nome" maxlength="80" value="${esc(osm.nome)}" ${dis}></label>
      </div>
      <h3 class="pgroup">Áreas</h3>${areasHtml(osm.areas, 'data-oarea')}
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-p="baixar" ${dis}>${icon('external')} Baixar</button>
        <span class="muted">Precisa de internet. Cada área leva de alguns segundos a poucos minutos; o que já foi baixado fica em cache.</span></div>`;
  }

  function itensOsm() {
    const itens = [...osm.marcados].map((k) => k.split('='));
    for (const t of osm.livre.split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = /^([a-z_:]{1,40})=([\w*.:-]{1,60})$/.exec(t);
      if (!m) throw new Error(`Etiqueta inválida: "${t}". Use chave=valor, por exemplo amenity=atm.`);
      itens.push([m[1], m[2]]);
    }
    return [...new Map(itens.map(([chave, valor]) => [`${chave}=${valor}`, { chave, valor }])).values()];
  }

  // ── importar arquivo ─────────────────────────────────────────────────────────────────────
  function sugerida(v) {
    if (v === '') return SEM;
    const c = catalogoChaves()[String(v).toLowerCase()];
    return c || `arquivo:${slug(v)}`;
  }

  function renderImp() {
    const box = $('#p-imp');
    const dis = running() ? 'disabled' : '';
    if (!imp) {
      box.innerHTML = `<h2>Importar arquivo próprio</h2>
        <div class="dropzone" data-p="escolher" id="imp-drop">${icon('folder')}<div><b>Escolher ou arrastar o arquivo</b><br>
          <span class="muted">GeoJSON, KML, Shapefile compactado (.zip), GeoPackage (.gpkg) ou CSV com colunas de latitude e longitude (ex.: lat e lon, em graus).</span></div></div>`;
      return;
    }
    const I = imp.insp;
    const campos = I.campos.map((c) => c.nome);
    const opt = (sel) => `<option value="">— nenhum —</option>${campos.map((c) => `<option value="${esc(c)}" ${c === sel ? 'selected' : ''}>${esc(c)}</option>`).join('')}`;
    const cc = I.campos.find((c) => c.nome === imp.campoCategoria);
    let tabela = '';
    if (cc && cc.valores) {
      const vals = cc.vazios ? [...cc.valores, ['', cc.vazios]] : cc.valores;
      tabela = `<h3 class="pgroup">Valores de "${esc(cc.nome)}" <span class="muted">— cada valor vira uma categoria (do OpenStreetMap, como amenity:bar, ou nova, como arquivo:${esc(slug(vals[0]?.[0] || 'x'))})</span></h3>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Valor no arquivo</th><th class="r">Pontos</th><th>Categoria</th><th>Ignorar</th></tr></thead><tbody>
        ${vals.map(([v, n]) => { const m = imp.mapa[v] ?? sugerida(v); const ig = m === IGN; return `<tr class="${ig ? 'off' : ''}"><td>${v === '' ? '<span class="muted">(vazio)</span>' : esc(v)}</td><td class="r num">${nf(n)}</td>
          <td><input type="text" list="cat-list" data-map="${esc(v)}" value="${ig ? '' : esc(m)}" ${ig || dis ? 'disabled' : ''} ${!ig && m !== SEM && !CAT_RE.test(m) ? 'aria-invalid="true"' : ''}></td>
          <td><input type="checkbox" data-ign="${esc(v)}" ${ig ? 'checked' : ''} ${dis}></td></tr>`; }).join('')}</tbody></table></div>
        <datalist id="cat-list">${[...new Set([...cat.flatMap((g) => g.itens).filter((i) => i.valor !== '*').map((i) => `${i.chave}:${i.valor}`), SEM])].map((k) => `<option value="${esc(k)}">`).join('')}</datalist>`;
    } else if (cc) {
      tabela = `<p class="note">${icon('info')} "${esc(cc.nome)}" tem ${nf(cc.unicos)} valores diferentes: cada um vira a categoria <span class="mono">arquivo:&lt;valor&gt;</span>.</p>`;
    } else {
      tabela = `<p class="note">${icon('info')} Sem campo de categoria: todos os pontos ficam na categoria <span class="mono">${esc(SEM)}</span> e usam o peso dos não listados.</p>`;
    }
    box.innerHTML = `<h2>Importar arquivo próprio <span class="spacer"></span><button class="btn sm" data-p="trocar" ${dis}>${icon('folder')} Outro arquivo</button></h2>
      <p class="muted"><b>${esc(I.original)}</b> · ${nf(I.n)} ponto(s) · ${esc(I.crs || '')}${I.ignoradas ? ` · ${nf(I.ignoradas)} linha(s) sem localização ignorada(s)` : ''}</p>
      <div class="sci-grid">
        <label class="field">Campo com a categoria<select id="i-cat" ${dis}>${opt(imp.campoCategoria)}</select></label>
        <label class="field">Campo com o nome<select id="i-nome" ${dis}>${opt(imp.campoNome)}</select></label>
        <label class="field">Data de abertura<select id="i-abre" ${dis}>${opt(imp.campoAbertura)}</select></label>
        <label class="field">Data de fechamento<select id="i-fecha" ${dis}>${opt(imp.campoFechamento)}</select></label>
      </div>
      ${imp.campoAbertura || imp.campoFechamento ? `<p class="note">${icon('info')} Com datas, a previsão de cada mês usa só os pontos abertos até a data final dos dados daquele passo (um bar aberto em 15/01 não entra na previsão de janeiro). Pontos sem data contam sempre.</p>` : ''}
      ${tabela}
      <div class="sci-grid">
        ${dedupHtml('i-dedup', imp.dedup)}
        ${juntarHtml('i-juntar', imp.juntar)}
        <label class="field">Nome do conjunto (opcional)<input type="text" id="i-nomecj" maxlength="80" value="${esc(imp.nome)}" ${dis}></label>
      </div>
      <h3 class="pgroup">Áreas</h3>${areasHtml(imp.areas, 'data-iarea')}
      <div class="btn-row" style="margin-top:12px"><button class="btn primary" data-p="importar" ${dis}>${icon('play')} Importar</button>
        <span class="muted">Os pontos são recortados pelo contorno de cada área. O conjunto fica como rascunho até você conferir e salvar.</span></div>`;
  }

  function novoImp(insp) {
    const s = insp.sugestao || {};
    imp = { insp, campoCategoria: s.categoria || '', campoNome: s.nome || '', campoAbertura: s.abertura || '', campoFechamento: s.fechamento || '',
      mapa: {}, dedup: 25, juntar: '', nome: '', areas: new Set(areas.map((a) => a.area)) };
    renderImp();
    scrollToEl($('#p-imp'));
  }

  async function escolher(fn) {
    try {
      const r = await fn();
      if (r) { toast(`${r.original}: ${nf(r.n)} ponto(s).`, 'ok'); novoImp(r); }
    } catch (err) { toast(err.message, 'err', 9000); }
  }

  function specImp() {
    const cc = imp.insp.campos.find((c) => c.nome === imp.campoCategoria);
    const mapa = {};
    if (cc?.valores) {
      for (const [v] of cc.vazios ? [...cc.valores, ['', 0]] : cc.valores) {
        const m = imp.mapa[v] ?? sugerida(v);
        if (m !== IGN && m !== SEM && !CAT_RE.test(m)) throw new Error(`Categoria inválida para "${v || '(vazio)'}": use grupo:nome, sem espaços (ex.: amenity:bar ou arquivo:padaria).`);
        mapa[v] = m;
      }
      if (Object.values(mapa).every((m) => m === IGN)) throw new Error('Todos os valores estão marcados para ignorar.');
    }
    if (!imp.areas.size) throw new Error('Escolha ao menos uma área.');
    return { acao: 'importar', fonte: imp.insp.fonte, original: imp.insp.original, campoCategoria: imp.campoCategoria || null, mapa,
      campoNome: imp.campoNome || null, campoAbertura: imp.campoAbertura || null, campoFechamento: imp.campoFechamento || null,
      dedup_m: imp.dedup, juntarCom: imp.juntar || null, nome: imp.nome, areas: [...imp.areas] };
  }

  // ── carregar ─────────────────────────────────────────────────────────────────────────────
  async function load() {
    try { L = await call('pois:list'); } catch (err) { toast(err.message, 'err'); return; }
    renderSets(); renderDraft(); renderMapa();
    if (!mapa.res) loadMapa();
  }

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'm-id') { mapa = { id: t.value, area: null, res: null }; loadMapa(); return; }
    if (t.id === 'm-area') { mapa.area = t.value; mapa.res = null; loadMapa(); return; }
    if (t.dataset.osm) { if (t.checked) osm.marcados.add(t.dataset.osm); else osm.marcados.delete(t.dataset.osm); return; }
    if (t.dataset.oarea) { if (t.checked) osm.areas.add(t.dataset.oarea); else osm.areas.delete(t.dataset.oarea); return; }
    if (t.id === 'o-livre') osm.livre = t.value;
    if (t.id === 'o-dedup') osm.dedup = Math.max(0, Math.min(500, Number(t.value) || 0));
    if (t.id === 'o-juntar') osm.juntar = t.value;
    if (t.id === 'o-nome') osm.nome = t.value;
    if (!imp) return;
    if (t.dataset.iarea) { if (t.checked) imp.areas.add(t.dataset.iarea); else imp.areas.delete(t.dataset.iarea); return; }
    if (t.id === 'i-cat') { imp.campoCategoria = t.value; imp.mapa = {}; renderImp(); return; }
    if (t.id === 'i-nome') imp.campoNome = t.value;
    if (t.id === 'i-abre') { imp.campoAbertura = t.value; renderImp(); return; }
    if (t.id === 'i-fecha') { imp.campoFechamento = t.value; renderImp(); return; }
    if (t.id === 'i-dedup') imp.dedup = Math.max(0, Math.min(500, Number(t.value) || 0));
    if (t.id === 'i-juntar') imp.juntar = t.value;
    if (t.id === 'i-nomecj') imp.nome = t.value;
    if (t.dataset.map !== undefined) { imp.mapa[t.dataset.map] = t.value.trim(); renderImp(); return; }
    if (t.dataset.ign !== undefined) { const v = t.dataset.ign; if (t.checked) imp.mapa[v] = IGN; else delete imp.mapa[v]; renderImp(); }
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const act = b.dataset.p, id = b.dataset.id;
    try {
      if (act === 'ativar') {
        const r = await call('pois:activate', id);
        mudanca = { apareceram: r.apareceram, sumiram: r.sumiram };
        L = r; renderSets(); renderDraft(); mapa = { id, area: null, res: null }; loadMapa(); refreshWorkspace();
        toast(id === DISS ? 'Conjunto da dissertação ativo.' : `Conjunto ativo: ${conj(id)?.nome || id}. Vale a partir da próxima Previsão.`, 'ok');
      }
      if (act === 'restaurar') {
        if (!(await confirmarRestaurar('O conjunto de pontos de interesse', 'Os outros conjuntos continuam salvos; os pesos das categorias ficam como estão no Mapa de risco.'))) return;
        const r = await call('pois:activate', DISS);
        mudanca = { apareceram: r.apareceram, sumiram: r.sumiram };
        L = r; renderSets(); mapa = { id: DISS, area: null, res: null }; loadMapa();
        toast('Conjunto da dissertação ativo.', 'ok');
      }
      if (act === 'ver') { mapa = { id, area: null, res: null }; loadMapa(); scrollToEl($('#p-map')); }
      if (act === 'detalhe') { detalhe = await call('pois:detail', id); renderSets(); }
      if (act === 'fechar') { detalhe = null; renderSets(); }
      if (act === 'remover') {
        const c = conj(id);
        if (!(await confirmar(`Remover o conjunto "${c?.nome || id}"?`, { detalhe: 'A pasta dele vai para pois/conjuntos/_removidos (nada é apagado). Replays que usaram este conjunto continuam com o manifesto no registro.', ok: 'Remover', perigo: true }))) return;
        L = await call('pois:remove', id);
        if (detalhe?.id === id) detalhe = null;
        if (mapa.id === id) mapa = { id: L.ativo, area: null, res: null };
        renderSets(); renderDraft(); loadMapa();
        toast('Conjunto removido.', 'ok');
      }
      if (act === 'salvar' || act === 'salvar-ativar') {
        const nome = $('#d-nome')?.value || '';
        L = await call('pois:save', id, nome);
        if (act === 'salvar-ativar') { const r = await call('pois:activate', id); mudanca = { apareceram: r.apareceram, sumiram: r.sumiram }; L = r; }
        draftId = null; renderSets(); renderDraft(); renderMapa(); renderOsm(); renderImp();
        toast(act === 'salvar-ativar' ? 'Conjunto salvo e ativo.' : 'Conjunto salvo. Ative-o quando quiser usar nas Previsões.', 'ok');
      }
      if (act === 'descartar') {
        if (!(await confirmar('Descartar o conjunto novo?', { detalhe: 'A pasta dele vai para pois/conjuntos/_removidos.', ok: 'Descartar', perigo: true }))) return;
        L = await call('pois:remove', id);
        draftId = null; mapa = { id: L.ativo, area: null, res: null };
        renderSets(); renderDraft(); loadMapa();
      }
      if (act === 'baixar') {
        const itens = itensOsm();
        if (!itens.length) { toast('Escolha ao menos uma categoria.', 'err'); return; }
        if (!osm.areas.size) { toast('Escolha ao menos uma área.', 'err'); return; }
        await panel.run({ acao: 'osm', itens, areas: [...osm.areas], dedup_m: osm.dedup, juntarCom: osm.juntar || null, nome: osm.nome });
        scrollToEl($('#p-run'));
      }
      if (act === 'escolher' || act === 'trocar') escolher(() => call('pois:pick'));
      if (act === 'importar') {
        await panel.run(specImp());
        scrollToEl($('#p-run'));
      }
    } catch (err) { toast(err.message, 'err', 9000); }
  });

  // arrastar o arquivo para o quadro de importação
  const card = $('#p-imp');
  for (const ev of ['dragenter', 'dragover']) card.addEventListener(ev, (e) => { e.preventDefault(); card.querySelector('#imp-drop')?.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) card.addEventListener(ev, () => card.querySelector('#imp-drop')?.classList.remove('over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    const p = f && window.pc.pathForFile(f);
    if (p) escolher(() => call('pois:inspectPath', p));
  });

  const panel = mountRunPanel($('#p-run'), 'pois', {
    onState: () => { renderSets(); renderOsm(); renderImp(); },
    onEnd: async (st) => {
      if (st === 'ok') {
        try {
          const runs = await call('run:list', 'pois', 1);
          draftId = runs?.[0]?.metrics?.conjunto?.id || null;
        } catch { draftId = null; }
      }
      await load(); renderOsm(); renderImp();
      if (st === 'ok') scrollToEl($('#p-draft'));
    },
  });

  Promise.all([
    call('pois:catalog').then((c) => { cat = c || []; for (const g of cat) for (const i of g.itens) if (i.marcado) osm.marcados.add(`${i.chave}=${i.valor}`); }).catch(() => {}),
    call('areas:list').then((a) => { areas = a || []; for (const x of areas) osm.areas.add(x.area); }).catch(() => {}),
  ]).then(() => { renderOsm(); renderImp(); });
  load();
  return () => panel.unmount();
}
