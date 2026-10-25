/* Pre-Crime — mapa de risco (versão operacional).
 * Abas: Mapa (previsão + crimes reais + histórico do grid) e Desempenho (métricas do mês).
 */
'use strict';

const MODELS = ['Ensemble', 'RF', 'LSTM', 'Transformer'];
const MODEL_LABEL = { Ensemble: 'Ensemble', RF: 'Random Forest', LSTM: 'LSTM', Transformer: 'Transformer' };
const MODEL_VAR = { Ensemble: '--m-ens', RF: '--m-rf', LSTM: '--m-lstm', Transformer: '--m-tf' };

const S = { area: null, model: 'Ensemble', tag: null, tab: 'map', horizon: 4, lastArea: null, months: [] };

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const modelColor = (m) => css(MODEL_VAR[m] || '--muted');
const fmtN = (n) => Number(n || 0).toLocaleString('pt-BR');
const fmtPct = (v, d = 1) => (Number(v || 0) * 100).toFixed(d).replace('.', ',') + '%';
const fmtDec = (v, d = 2) => Number(v || 0).toFixed(d).replace('.', ',');
// nome dado pelo operador às áreas criadas por GeoJSON (cfg.area_names), ou "Área 01"
const AREA_NAMES = {};
const areaLabel = (a) => (a ? AREA_NAMES[a] || a.replace('area_', 'Área ') : '—');
const tagLabel = (t) => { if (!t) return '—'; const [y, m] = t.split('_'); return `${m}/${y}`; };
const tagQ = () => (S.tag ? `?tag=${S.tag}` : '');

// ── API com cache ────────────────────────────────────────────────────────────
const CACHE = new Map();
async function api(path) {
  if (CACHE.has(path)) return CACHE.get(path);
  const p = fetch('api/' + path).then(async (r) => (r.ok ? r.json() : null)).catch(() => null);
  CACHE.set(path, p);
  return p;
}
function clearCache() { CACHE.clear(); }

// ── Gráficos ─────────────────────────────────────────────────────────────────
const CHARTS = {};
function chart(id, cfg) {
  if (CHARTS[id]) CHARTS[id].destroy();
  Chart.defaults.color = css('--muted');
  Chart.defaults.borderColor = css('--line');
  Chart.defaults.font.family = css('--font');
  CHARTS[id] = new Chart($(id), cfg);
}

// ── Início ───────────────────────────────────────────────────────────────────
async function init() {
  const cfg = await api('config');
  Object.assign(AREA_NAMES, cfg?.area_names || {});
  if (!cfg || !cfg.areas || !cfg.areas.length) {
    $('page-title').textContent = 'Nenhuma previsão encontrada';
    $('content').innerHTML = '<div class="empty">Ainda não há previsões geradas. Rode a fase de previsão e recarregue esta página.</div>';
    return;
  }
  // textos do pacote publicado (título, apresentação, aviso de uso responsável)
  const site = await api('site');
  if (site?.titulo) { $('site-title').textContent = site.titulo; document.title = `${site.titulo} — Mapa de Risco`; }
  if (site?.apresentacao) { $('site-intro').textContent = site.apresentacao; $('site-intro').hidden = false; }
  if (site?.aviso) $('site-notice').textContent = site.aviso;
  // modelos publicados
  for (const o of [...$('sel-model').options]) if (cfg.models && !cfg.models.includes(o.value)) o.remove();
  if (!cfg.models?.includes(S.model) && cfg.models?.length) S.model = cfg.models[0];
  $('sel-model').value = S.model;

  S.horizon = cfg.forecast_horizon || 4;
  $('info-horizon').textContent = S.horizon;

  // ?area=area_01&tag=2026_03&tab=perf: o app desktop abre o mapa no mês e área escolhidos
  const q = new URLSearchParams(location.search);
  S.months = (await api('months')) || [];
  const selMonth = $('sel-month');
  for (const m of S.months.slice().reverse()) selMonth.add(new Option(m.label, m.tag));
  S.tag = S.months.some((m) => m.tag === q.get('tag')) ? q.get('tag') : cfg.default_tag || (S.months.length ? S.months[S.months.length - 1].tag : null);
  selMonth.value = S.tag || '';
  // áreas com previsão no mês escolhido (as criadas pelo operador podem ter só alguns meses)
  await fillAreas(q.get('area') || null, cfg.areas);

  bind();
  if (q.get('tab') === 'perf') {
    S.tab = 'perf';
    document.querySelectorAll('.tab').forEach((x) => { const on = x.dataset.tab === 'perf'; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); });
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-perf'));
  }
  refresh();
}

function bind() {
  $('sel-area').addEventListener('change', (e) => { S.area = e.target.value; closeSidebar(); refresh(); });
  $('sel-model').addEventListener('change', (e) => { S.model = e.target.value; closeSidebar(); refresh(); });
  $('sel-month').addEventListener('change', async (e) => { S.tag = e.target.value || null; closeSidebar(); await fillAreas(S.area); refresh(); });

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    S.tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); });
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + S.tab));
    loadTab();
  }));

  $('btn-png').addEventListener('click', exportPng);
  $('gp-close').addEventListener('click', () => $('grid-panel').classList.add('hidden'));
  // ☰: no celular abre a gaveta; na tela larga fecha/abre a barra lateral (fica lembrado)
  $('menu-toggle').addEventListener('click', () => {
    if (matchMedia('(max-width: 768px)').matches) { $('sidebar').classList.toggle('open'); $('overlay').classList.toggle('visible'); return; }
    setSideCollapsed(!document.body.classList.contains('side-collapsed'));
  });
  try { if (localStorage.getItem('precrime.side') === 'fechada') setSideCollapsed(true, false); } catch { /* sem armazenamento */ }
  $('overlay').addEventListener('click', closeSidebar);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => loadTab());
}
function setSideCollapsed(on, save = true) {
  document.body.classList.toggle('side-collapsed', on);
  const b = $('menu-toggle');
  b.setAttribute('aria-label', on ? 'Mostrar os filtros' : 'Esconder os filtros');
  b.title = on ? 'Mostrar os filtros (área, modelo, mês)' : 'Esconder os filtros e ampliar o mapa';
  b.setAttribute('aria-expanded', String(!on));
  if (save) { try { localStorage.setItem('precrime.side', on ? 'fechada' : 'aberta'); } catch { /* sem armazenamento */ } }
  if (map) setTimeout(() => map.invalidateSize(), 50);
}
/** Lista de áreas do mês S.tag; mantém `want` (ou a área atual) quando ela tem previsão no mês. */
async function fillAreas(want, fallback = []) {
  const lista = (await api(`areas?tag=${S.tag || ''}`)) || fallback.map((a) => ({ area: a, nome: null }));
  for (const x of lista) if (x.nome) AREA_NAMES[x.area] = x.nome;
  const ids = lista.map((x) => x.area);
  const sel = $('sel-area');
  sel.innerHTML = '';
  for (const a of ids) sel.add(new Option(areaLabel(a), a));
  S.area = ids.includes(want) ? want : ids.includes(S.area) ? S.area : ids[0];
  sel.value = S.area || '';
}
function closeSidebar() { $('sidebar').classList.remove('open'); $('overlay').classList.remove('visible'); }

async function refresh() {
  $('page-title').textContent = `${areaLabel(S.area)} · ${MODEL_LABEL[S.model]} · ${tagLabel(S.tag)}`;
  $('comp-area').textContent = areaLabel(S.area);
  $('cm-model').textContent = MODEL_LABEL[S.model];
  $('info-period').textContent = tagLabel(S.tag);
  $('grid-panel').classList.add('hidden');
  GRID_HISTORY = null;
  await loadKpis();
  loadTab();
}

function loadTab() { if (S.tab === 'map') loadMap(); else loadPerformance(); }

// ── KPIs do topo ─────────────────────────────────────────────────────────────
async function loadKpis() {
  const k = await api(`kpis/${S.area}/${S.model}${tagQ()}`);
  LAST.kpis = k;
  $('kpi-grids').textContent = k ? fmtN(k.total_grids) : '—';
  $('kpi-risk').textContent = k ? fmtN(k.risk_grids) : '—';
  $('kpi-risk-pct').textContent = k ? `${String(k.perc_risk).replace('.', ',')}% da área` : '';
  const validated = k && k.total_crimes > 0;
  $('kpi-crimes').textContent = validated ? fmtN(k.total_crimes) : '—';
  $('kpi-pai').textContent = k && k.pai > 0 ? fmtDec(k.pai) + '×' : '—';
  $('info-validated').textContent = validated ? 'com dados reais' : 'aguardando SSP';
}

// ── Mapa ─────────────────────────────────────────────────────────────────────
const LAST = { geo: null, crimes: null, audit: null, kpis: null };
let map = null, predLayer = null, crimeLayer = null, histLayer = null, layerCtl = null, GRID_HISTORY = null;

// Fundo do mapa: tiles da CARTO (basemaps.cartocdn.com) com a chave configurada no app; sem
// chave, sem internet (ou se os tiles falham), as ruas da área servidas pelo próprio servidor
// (/api/streets), desenhadas abaixo das células. A CARTO exige chave desde 25/09/2026.
const BASE = { tiles: null, streets: null, offline: false, ok: 0, err: 0, area: null };
async function initBase() {
  map.createPane('streets').style.zIndex = 250;
  BASE.renderer = L.canvas({ pane: 'streets' });
  const f = await api('basemap');
  if (f?.provedor !== 'carto' || !f.chave) { goOffline('Fundo com as ruas da área (sem chave da CARTO)'); return; }
  BASE.tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${f.estilo}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(f.chave)}`, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19,
  });
  BASE.tiles.on('tileload', () => { BASE.ok++; });
  BASE.tiles.on('tileerror', () => { if (++BASE.err >= 4 && !BASE.ok) goOffline(); });
  BASE.tiles.addTo(map);
  if (navigator.onLine === false) goOffline();
  // tiles que nem respondem (proxy bloqueando) também contam como sem internet
  setTimeout(() => { if (!BASE.ok) goOffline(); }, 8000);
}
function goOffline(msg) {
  if (BASE.offline) return;
  BASE.offline = true;
  if (BASE.tiles) map.removeLayer(BASE.tiles);
  const el = $('map-offline');
  el.textContent = msg || 'Sem acesso ao fundo da CARTO: fundo com as ruas da área';
  el.hidden = false;
  loadStreets();
}
async function loadStreets() {
  if (!BASE.offline || BASE.area === S.area) return;
  BASE.area = S.area;
  if (BASE.streets) { map.removeLayer(BASE.streets); BASE.streets = null; }
  const g = await api(`streets/${S.area}`);
  if (!g || BASE.area !== S.area) return;
  const c = css('--street') || '#94a3b8';
  const W = { 1: 2.4, 2: 1.8, 3: 1.3, 4: 1, 5: 0.5 };
  BASE.streets = L.geoJSON(g, {
    pane: 'streets', renderer: BASE.renderer, interactive: false,
    style: (f) => ({ color: c, weight: W[f.properties.h] || 0.5, opacity: f.properties.h <= 3 ? 0.9 : 0.6 }),
  }).addTo(map);
}

// ── Comparação com cortina: outro modelo ou outro mês do lado direito ─────────────
// A previsão atual fica no painel 'pmain' (lado esquerdo) e a comparada em 'pcmp' (direito);
// cada painel é recortado na posição da cortina, que se arrasta com o mouse ou o teclado.
const CMP = { value: '', layer: null, x: 0.5 };
function initCompare() {
  for (const [name, z] of [['pmain', 400], ['pcmp', 405], ['pcrimes', 430]]) map.createPane(name).style.zIndex = z;
  CMP.rMain = L.canvas({ pane: 'pmain' });
  CMP.rCmp = L.canvas({ pane: 'pcmp' });
  CMP.rCrimes = L.canvas({ pane: 'pcrimes' });
  const wrap = $('map');
  const div = document.createElement('div');
  div.className = 'cmp-divider'; div.hidden = true;
  div.innerHTML = '<span class="cmp-handle" role="slider" tabindex="0" aria-label="Cortina da comparação" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">⇔</span><span class="cmp-tag cmp-left"></span><span class="cmp-tag cmp-right"></span>';
  wrap.appendChild(div);
  CMP.div = div;
  L.DomEvent.disableClickPropagation(div);
  const handle = div.querySelector('.cmp-handle');
  const move = (clientX) => {
    const r = wrap.getBoundingClientRect();
    CMP.x = Math.min(0.98, Math.max(0.02, (clientX - r.left) / r.width));
    clipPanes();
  };
  const onMove = (e) => move((e.touches ? e.touches[0] : e).clientX);
  const stop = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', stop); map.dragging.enable(); };
  handle.addEventListener('pointerdown', (e) => { e.preventDefault(); map.dragging.disable(); document.addEventListener('pointermove', onMove); document.addEventListener('pointerup', stop); });
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); CMP.x = Math.min(0.98, Math.max(0.02, CMP.x + (e.key === 'ArrowLeft' ? -0.05 : 0.05))); clipPanes(); }
  });
  map.on('move zoom resize viewreset zoomend moveend', clipPanes);
  $('sel-cmp').addEventListener('change', (e) => { CMP.value = e.target.value; renderCompare(); });
}
function clipPanes() {
  const main = map.getPane('pmain'), cmp = map.getPane('pcmp');
  if (!CMP.layer) { main.style.clip = ''; cmp.style.clip = ''; if (CMP.div) CMP.div.hidden = true; return; }
  const size = map.getSize();
  const nw = map.containerPointToLayerPoint([0, 0]);
  const se = map.containerPointToLayerPoint(size);
  const x = map.containerPointToLayerPoint([size.x * CMP.x, 0]).x;
  main.style.clip = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
  cmp.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
  CMP.div.hidden = false;
  CMP.div.style.left = `${CMP.x * 100}%`;
  CMP.div.querySelector('.cmp-handle').setAttribute('aria-valuenow', String(Math.round(CMP.x * 100)));
}
function compareOptions() {
  const opts = [];
  for (const m of Object.keys(MODEL_LABEL)) if (m !== S.model && [...$('sel-model').options].some((o) => o.value === m)) opts.push([`${m}|${S.tag}`, `${MODEL_LABEL[m]} · ${tagLabel(S.tag)}`]);
  for (const mo of S.months) if (mo.tag !== S.tag) opts.push([`${S.model}|${mo.tag}`, `${MODEL_LABEL[S.model]} · ${mo.label}`]);
  return opts;
}
async function renderCompare() {
  const sel = $('sel-cmp');
  const opts = compareOptions();
  if (CMP.value && !opts.some(([v]) => v === CMP.value)) CMP.value = '';
  sel.innerHTML = `<option value="">— nada —</option>${opts.map(([v, l]) => `<option value="${v}" ${v === CMP.value ? 'selected' : ''}>${l}</option>`).join('')}`;
  if (CMP.layer) { map.removeLayer(CMP.layer); CMP.layer = null; }
  if (CMP.value) {
    const [m, t] = CMP.value.split('|');
    const geo = await api(`geojson/${m}/${S.area}?tag=${t}`);
    if (geo && CMP.value === `${m}|${t}`) {
      CMP.layer = L.geoJSON(geo, {
        pane: 'pcmp', renderer: CMP.rCmp,
        style: (f) => ({
          fillColor: f.properties.fill && f.properties.fill !== 'transparent' ? f.properties.fill : 'transparent',
          color: '#64748b', weight: 0.3, fillOpacity: Number(f.properties['fill-opacity'] || 0),
        }),
        onEachFeature: (f, layer) => {
          const p = f.properties || {};
          layer.bindTooltip(`${MODEL_LABEL[m]} · ${tagLabel(t)}<br>Grid ${p.GRID_ID}<br>Risco: ${p.Risco || '—'}<br>Score: ${fmtDec(p.Score, 3)}`, { sticky: true });
        },
      }).addTo(map);
      CMP.div.querySelector('.cmp-left').textContent = `${MODEL_LABEL[S.model]} · ${tagLabel(S.tag)}`;
      CMP.div.querySelector('.cmp-right').textContent = `${MODEL_LABEL[m]} · ${tagLabel(t)}`;
    }
  }
  clipPanes();
}

// ── Pontos de interesse: bares, polícia, bancos... por categoria (nenhuma ligada de início) ──
const POI_KEY = 'precrime.pois';
const POI = { el: null, area: null, data: null, layer: null, open: false, on: new Set() };
try { for (const c of JSON.parse(localStorage.getItem(POI_KEY)) || []) POI.on.add(c); } catch { /* sem armazenamento */ }
const savePois = () => { try { localStorage.setItem(POI_KEY, JSON.stringify([...POI.on])); } catch { /* sem armazenamento */ } };
const escH = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';

function initPois() {
  map.createPane('ppois').style.zIndex = 440;
  POI.renderer = L.canvas({ pane: 'ppois' });
  const ctl = L.control({ position: 'topright' });
  ctl.onAdd = () => {
    const d = L.DomUtil.create('div', 'poi-ctl');
    d.hidden = true;
    L.DomEvent.disableClickPropagation(d);
    L.DomEvent.disableScrollPropagation(d);
    d.addEventListener('click', (e) => {
      if (e.target.closest('.poi-toggle')) { POI.open = !POI.open; renderPoiCtl(); }
      if (e.target.closest('[data-poi-clear]')) { POI.on.clear(); savePois(); renderPoiCtl(); drawPois(); }
    });
    d.addEventListener('change', (e) => {
      const id = e.target.dataset.poi;
      if (!id) return;
      if (e.target.checked) POI.on.add(id); else POI.on.delete(id);
      savePois(); renderPoiCtl(); drawPois();
    });
    POI.el = d;
    return d;
  };
  ctl.addTo(map);
  map.on('zoomend', () => { if (POI.layer) { const r = poiRadius(); POI.layer.eachLayer((m) => m.setRadius(r)); } });
}

function renderPoiCtl() {
  const d = POI.el;
  if (!d) return;
  if (!POI.data?.categorias?.length) { d.hidden = true; return; }
  d.hidden = false;
  const cats = POI.data.categorias;
  const ligadas = cats.filter((c) => POI.on.has(c.id));
  d.innerHTML = `<button type="button" class="poi-toggle" aria-expanded="${POI.open}">${PIN}<span>Pontos de interesse${ligadas.length ? ` · ${ligadas.length}` : ''}</span><b aria-hidden="true">${POI.open ? '▴' : '▾'}</b></button>
    ${POI.open ? `<div class="poi-list">
      ${cats.map((c) => `<label><input type="checkbox" data-poi="${escH(c.id)}" ${POI.on.has(c.id) ? 'checked' : ''}><i style="background:${escH(c.cor)}"></i><span>${escH(c.rotulo)}</span><span class="poi-n">${fmtN(c.n)}</span></label>`).join('')}
      <div class="poi-foot"><span>OpenStreetMap · ligue uma categoria por vez</span>${ligadas.length ? '<button type="button" data-poi-clear>Desligar todas</button>' : ''}</div>
    </div>` : ''}`;
}

// pontos menores com o mapa afastado, para não cobrir as células
const poiRadius = () => { const z = map.getZoom(); return z <= 12 ? 2.6 : z <= 13 ? 3.4 : z <= 15 ? 4.5 : 6; };

function drawPois() {
  if (POI.layer) { map.removeLayer(POI.layer); POI.layer = null; }
  if (!POI.data) return;
  const g = L.layerGroup();
  for (const c of POI.data.categorias) {
    if (!POI.on.has(c.id)) continue;
    for (const [lon, lat, nome, tipo] of POI.data.pontos[c.id] || []) {
      L.circleMarker([lat, lon], { pane: 'ppois', renderer: POI.renderer, radius: poiRadius(), color: '#ffffff', weight: 0.8, fillColor: c.cor, fillOpacity: 0.95 })
        .bindTooltip(`<b>${escH(nome || tipo)}</b><br>${escH(nome ? `${tipo} · ` : '')}${escH(c.rotulo)}`)
        .addTo(g);
    }
  }
  POI.layer = g.addTo(map);
}

async function loadPois() {
  if (POI.area === S.area) return;
  POI.area = S.area;
  const area = S.area;
  const data = await api(`pois/${area}`);
  if (area !== S.area) return;
  POI.data = data;
  renderPoiCtl(); drawPois();
}

async function loadMap() {
  if (!map) {
    map = L.map('map', { preferCanvas: true }).setView([-23.55, -46.63], 12);
    initCompare();
    initPois();
    if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('map'));
    await initBase();
  }
  loadPois();
  loadStreets();
  for (const l of [predLayer, crimeLayer, histLayer]) if (l) map.removeLayer(l);
  if (layerCtl) layerCtl.remove();
  predLayer = crimeLayer = histLayer = layerCtl = null;

  const [geo, crimes, hist] = await Promise.all([
    api(`geojson/${S.model}/${S.area}${tagQ()}`),
    api(`crimes/${S.area}${tagQ()}`),
    api(`grid-history/${S.area}${tagQ()}`),
  ]);
  GRID_HISTORY = hist;
  LAST.geo = geo; LAST.crimes = crimes;

  if (geo) {
    predLayer = L.geoJSON(geo, {
      pane: 'pmain', renderer: CMP.rMain,
      style: (f) => ({
        fillColor: f.properties.fill && f.properties.fill !== 'transparent' ? f.properties.fill : 'transparent',
        color: '#64748b', weight: 0.3,
        fillOpacity: Number(f.properties['fill-opacity'] || 0),
      }),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        layer.bindTooltip(`Grid ${p.GRID_ID}<br>Risco: ${p.Risco || '—'}<br>Score: ${fmtDec(p.Score, 3)}`, { sticky: true });
        layer.on('click', () => showGrid(p.GRID_ID, p.Score));
      },
    }).addTo(map);
    if (S.area !== S.lastArea) { map.fitBounds(predLayer.getBounds(), { padding: [16, 16] }); S.lastArea = S.area; }

    if (hist && hist.grids) {
      const maxT = hist.max_total || 1;
      histLayer = L.geoJSON(geo, {
        style: (f) => {
          const w = hist.grids[String(f.properties.GRID_ID)] || [];
          const t = w.reduce((s, v) => s + v, 0) / maxT;
          return { fillColor: '#2563eb', fillOpacity: t > 0 ? 0.08 + t * 0.72 : 0, color: 'transparent', weight: 0 };
        },
        onEachFeature: (f, layer) => layer.on('click', () => showGrid(f.properties.GRID_ID, f.properties.Score)),
      });
    }
  }

  if (crimes && crimes.features && crimes.features.length) {
    const c = css('--crime');
    crimeLayer = L.geoJSON(crimes, {
      pane: 'pcrimes', renderer: CMP.rCrimes,
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 3, color: c, fillColor: c, fillOpacity: 0.85, weight: 0.5 }),
    }).addTo(map);
  }

  const layers = {};
  if (predLayer) layers['Risco previsto'] = predLayer;
  if (crimeLayer) layers['Crimes reais'] = crimeLayer;
  if (histLayer) layers['Histórico (24 semanas)'] = histLayer;
  if (Object.keys(layers).length) layerCtl = L.control.layers(null, layers, { collapsed: false }).addTo(map);
  setTimeout(() => map.invalidateSize(), 80);

  loadAudit();
  renderCompare();
}

async function loadAudit() {
  const a = await api(`audit/${S.model}/${S.area}${tagQ()}`);
  LAST.audit = a;
  $('audit-row').hidden = !a;
  $('audit-empty').hidden = !!a;
  if (!a) return;
  const p = (v) => (a.total_crimes ? fmtPct(v / a.total_crimes) : '—') + ' dos crimes';
  $('ak-captured').textContent = fmtN(a.crimes_captured); $('ak-captured-pct').textContent = p(a.crimes_captured);
  $('ak-missed').textContent = fmtN(a.crimes_missed); $('ak-missed-pct').textContent = p(a.crimes_missed);
  $('ak-red').textContent = fmtN(a.crimes_red); $('ak-red-pct').textContent = p(a.crimes_red);
  $('ak-yellow').textContent = fmtN(a.crimes_yellow); $('ak-yellow-pct').textContent = p(a.crimes_yellow);
  $('ak-precision').textContent = a.total_red_grids ? fmtPct(a.red_grids_hit / a.total_red_grids) : '—';
}

// Histórico do grid: últimas 24 semanas (s1 = mais recente)
function showGrid(gridId, score) {
  const panel = $('grid-panel'), box = $('gp-content');
  panel.classList.remove('hidden');
  const weeks = GRID_HISTORY && GRID_HISTORY.grids ? GRID_HISTORY.grids[String(gridId)] : null;
  if (!weeks) {
    box.innerHTML = `<div class="gp-head"><div class="gp-id">Grid ${Number(gridId)}</div></div><p class="gp-note">Sem histórico para este mês.</p>`;
    return;
  }
  const n = Math.min(weeks.length, 24), max = Math.max(1, ...weeks.slice(0, n));
  const segH = 14, w = 64, x0 = 18, y0 = 6, high = css('--risk-high');
  let svg = `<svg width="136" height="${y0 + n * segH + 8}" role="img" aria-label="Crimes por semana">`;
  for (let i = 0; i < n; i++) {
    const c = weeks[i], t = c / max, y = y0 + i * segH;
    const fill = c > 0 ? high : 'transparent';
    svg += `<rect x="${x0}" y="${y}" width="${w}" height="${segH - 1}" rx="2" fill="${fill}" fill-opacity="${c > 0 ? (0.15 + t * 0.75).toFixed(2) : 0}" stroke="${css('--line')}"/>`;
    svg += `<text x="${x0 + w / 2}" y="${y + segH - 3}" text-anchor="middle" font-size="10" fill="${t > 0.55 ? '#fff' : css('--text')}">${c}</text>`;
    if (i === 0 || (i + 1) % 4 === 0) svg += `<text x="${x0 + w + 6}" y="${y + segH - 3}" font-size="9" fill="${css('--muted')}">s${i + 1}</text>`;
  }
  svg += '</svg>';
  const total = weeks.slice(0, n).reduce((s, v) => s + v, 0);
  box.innerHTML = `<div class="gp-head"><div class="gp-id">Grid ${Number(gridId)}</div>
    <div class="gp-score">Score ${fmtDec(score, 3)}</div></div>
    <p class="gp-note">${total} crime(s) nas últimas ${n} semanas</p>${svg}
    <p class="gp-note">s1 = semana mais recente</p>`;
}

// ── Desempenho ───────────────────────────────────────────────────────────────
async function loadPerformance() {
  const [rows, zhang] = await Promise.all([api(`metrics/${S.area}${tagQ()}`), api(`zhang${tagQ()}`)]);
  const has = rows && rows.length;
  $('perf-empty').hidden = !!has;
  $('perf-body').hidden = !has;
  if (!has) return;

  const byModel = Object.fromEntries(rows.map((r) => [r.Modelo, r]));
  const models = MODELS.filter((m) => byModel[m]);

  // Matriz de confusão do modelo escolhido
  const r = byModel[S.model];
  if (r) {
    const tp = +r.TP || 0, tn = +r.TN || 0, fp = +r.FP || 0, fn = +r.FN || 0;
    $('cm-wrap').innerHTML = `
      <div class="cm">
        <div></div><div class="h">Previsto: sem crime</div><div class="h">Previsto: com crime</div>
        <div class="r">Real: sem crime</div>
        <div class="c good"><b>${fmtN(tn)}</b>acertou que não teria</div>
        <div class="c bad"><b>${fmtN(fp)}</b>alarme sem crime</div>
        <div class="r">Real: com crime</div>
        <div class="c bad"><b>${fmtN(fn)}</b>crime fora do alerta</div>
        <div class="c good"><b>${fmtN(tp)}</b>crime dentro do alerta</div>
      </div>
      <div class="cm-stats">
        <span>Precisão <b>${fmtPct(r.Precision)}</b></span>
        <span>Recall <b>${fmtPct(r.Recall)}</b></span>
        <span>F1 <b>${fmtDec(r['F1-Score'], 3)}</b></span>
      </div>`;
  } else {
    $('cm-wrap').innerHTML = '<div class="loading">Sem métricas deste modelo para o mês.</div>';
  }

  // Tabela comparativa
  const cols = [
    { k: 'Hit Rate (Foco)', label: 'Crimes na zona vermelha', f: (v) => fmtDec(v, 1) + '%', higher: true },
    { k: 'Hit Rate (Cobertura)', label: 'Vermelha + amarela', f: (v) => fmtDec(v, 1) + '%', higher: true },
    { k: 'PAI', label: 'PAI', f: (v) => fmtDec(v) + '×', higher: true },
    { k: 'Precision', label: 'Precisão', f: (v) => fmtPct(v), higher: true },
    { k: 'Recall', label: 'Recall', f: (v) => fmtPct(v), higher: true },
    { k: 'F1-Score', label: 'F1', f: (v) => fmtDec(v, 3), higher: true },
    { k: 'TP', label: 'TP', f: fmtN }, { k: 'FP', label: 'FP', f: fmtN }, { k: 'FN', label: 'FN', f: fmtN },
  ];
  const best = {};
  for (const c of cols) if (c.higher) best[c.k] = Math.max(...models.map((m) => +byModel[m][c.k] || 0));
  let html = `<table class="data"><thead><tr><th>Modelo</th>${cols.map((c) => `<th>${c.label}</th>`).join('')}</tr></thead><tbody>`;
  for (const m of models) {
    html += `<tr><td><span class="dot" style="background:${modelColor(m)}"></span>${MODEL_LABEL[m]}</td>`;
    for (const c of cols) {
      const v = +byModel[m][c.k] || 0;
      html += `<td class="${c.higher && v === best[c.k] && v > 0 ? 'best' : ''}">${c.f(v)}</td>`;
    }
    html += '</tr>';
  }
  $('comp-table').innerHTML = html + '</tbody></table>';

  const bar = (id, key, scale) => chart(id, {
    type: 'bar',
    data: { labels: models.map((m) => MODEL_LABEL[m]), datasets: [{ data: models.map((m) => (+byModel[m][key] || 0) * scale), backgroundColor: models.map(modelColor), borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true }, x: { grid: { display: false } } } },
  });
  bar('chart-hitrate', 'Hit Rate (Foco)', 1);
  bar('chart-f1', 'F1-Score', 1);

  // Cobertura × captura (por quantil), área selecionada
  const z = (zhang || []).filter((x) => x.Area === S.area);
  const datasets = MODELS.filter((m) => z.some((x) => x.Model === m)).map((m) => ({
    label: MODEL_LABEL[m],
    data: z.filter((x) => x.Model === m).map((x) => ({ x: +x.Area_Ratio * 100, y: +x.HitRn * 100 })).sort((a, b) => a.x - b.x),
    borderColor: modelColor(m), backgroundColor: modelColor(m), tension: 0.25, pointRadius: 4,
  }));
  if (datasets.length) {
    const maxX = Math.max(...datasets.flatMap((d) => d.data.map((p) => p.x)), 25);
    datasets.push({ label: 'Ao acaso', data: [{ x: 0, y: 0 }, { x: maxX, y: maxX }], borderColor: css('--muted'), borderDash: [5, 5], pointRadius: 0 });
  }
  chart('chart-coverage', {
    type: 'line',
    data: { datasets },
    options: {
      parsing: false,
      scales: {
        x: { type: 'linear', min: 0, title: { display: true, text: '% da área coberta' } },
        y: { min: 0, title: { display: true, text: '% dos crimes capturados' } },
      },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.x.toFixed(0)}% da área → ${c.parsed.y.toFixed(1)}% dos crimes` } } },
    },
  });
}


// ── Imagem PNG da previsão ───────────────────────────────────────────────────
// Desenha a área a partir do GeoJSON (sem depender dos blocos do mapa de fundo), com título,
// legenda e números do mês. Sempre em fundo claro, para relatório e impressão.
function exportPng() {
  const geo = LAST.geo;
  if (!geo || !geo.features || !geo.features.length) { alert('Sem previsão carregada para esta área.'); return; }
  const btn = $('btn-png'); btn.disabled = true;
  try {
    const W = 1600, H = 1200, M = 40, HEAD = 120, FOOT = 120;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);

    // limites e projeção (equiretangular corrigida pela latitude)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const each = (geom, fn) => {
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
      for (const poly of polys) fn(poly);
    };
    for (const f of geo.features) each(f.geometry, (poly) => { for (const [x, y] of poly[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } });
    const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
    const bw = W - 2 * M, bh = H - HEAD - FOOT - M;
    const sc = Math.min(bw / ((x1 - x0) * k), bh / (y1 - y0));
    const ox = M + (bw - (x1 - x0) * k * sc) / 2, oy = HEAD + (bh - (y1 - y0) * sc) / 2;
    const P = (x, y) => [ox + (x - x0) * k * sc, oy + (y1 - y) * sc];

    const path = (poly) => { g.beginPath(); for (const ring of poly) ring.forEach(([x, y], i) => { const [px, py] = P(x, y); i ? g.lineTo(px, py) : g.moveTo(px, py); }); g.closePath(); };
    // células
    for (const f of geo.features) {
      const p = f.properties || {};
      const fill = p.fill && p.fill !== 'transparent' ? p.fill : null;
      each(f.geometry, (poly) => {
        path(poly);
        g.fillStyle = fill ? fill : '#f1f5f9'; g.globalAlpha = fill ? Math.max(0.35, Number(p['fill-opacity'] || 0.5)) : 1; g.fill('evenodd'); g.globalAlpha = 1;
        g.strokeStyle = fill === '#ff0000' ? '#7f1d1d' : fill ? '#a16207' : '#cbd5e1'; g.lineWidth = fill ? 0.8 : 0.4; g.stroke();
      });
    }
    // crimes reais
    const crimes = LAST.crimes && LAST.crimes.features ? LAST.crimes.features : [];
    g.fillStyle = '#111827';
    for (const f of crimes) { if (!f.geometry) continue; const [px, py] = P(f.geometry.coordinates[0], f.geometry.coordinates[1]); g.beginPath(); g.arc(px, py, 3, 0, Math.PI * 2); g.fill(); }

    // título
    const font = (w, s) => `${w} ${s}px "Segoe UI", system-ui, sans-serif`;
    g.fillStyle = '#0f172a'; g.font = font(700, 34); g.textBaseline = 'top';
    g.fillText(`Previsão de furtos e roubos de veículos · ${areaLabel(S.area)}`, M, 30);
    g.fillStyle = '#475569'; g.font = font(400, 20);
    let per = '';
    if (S.tag) { const [yy, mm] = S.tag.split('_').map(Number); const d0 = new Date(Date.UTC(yy, mm - 1, 1)), d1 = new Date(d0.getTime() + 28 * 864e5); const f = (d) => d.toISOString().slice(0, 10).split('-').reverse().join('/'); per = `${f(d0)} a ${f(d1)}`; }
    g.fillText(`Mês previsto ${tagLabel(S.tag)} (${per}) · modelo ${MODEL_LABEL[S.model]}`, M, 74);

    // legenda e números
    const ly = H - FOOT + 20;
    const sw = (x, color, txt, round) => { g.fillStyle = color; if (round) { g.beginPath(); g.arc(x + 9, ly + 10, 6, 0, Math.PI * 2); g.fill(); } else { g.fillRect(x, ly, 20, 20); g.strokeStyle = '#64748b'; g.strokeRect(x, ly, 20, 20); } g.fillStyle = '#0f172a'; g.font = font(500, 18); g.fillText(txt, x + 30, ly); };
    sw(M, '#ff0000', 'Alto risco (10% das células)');
    sw(M + 330, '#ffff00', 'Médio risco (10% seguintes)');
    if (crimes.length) sw(M + 660, '#111827', `Crime real (${crimes.length})`, true);
    const a = LAST.audit, kp = LAST.kpis;
    g.font = font(600, 18); g.fillStyle = '#0f172a'; g.textAlign = 'right';
    if (a && a.total_crimes) g.fillText(`${fmtPct(a.crimes_captured / a.total_crimes)} dos crimes nas zonas de alerta · ${fmtPct(a.crimes_red / a.total_crimes)} na vermelha`, W - M, ly);
    else if (kp) g.fillText(`${fmtN(kp.risk_grids)} de ${fmtN(kp.total_grids)} células em alerta`, W - M, ly);
    g.textAlign = 'left'; g.font = font(400, 14); g.fillStyle = '#64748b';
    g.fillText(`Pre-Crime · dados SSP-SP · gerado em ${new Date().toLocaleString('pt-BR')}. Previsão estatística por área; não aponta pessoas.`, M, H - 40);

    c.toBlob((blob) => {
      const a2 = document.createElement('a');
      a2.href = URL.createObjectURL(blob);
      a2.download = `precrime_${S.area}_${S.model}_${(S.tag || '').replace('_', '-')}.png`;
      document.body.append(a2); a2.click(); a2.remove();
      setTimeout(() => URL.revokeObjectURL(a2.href), 4000);
      btn.disabled = false;
    }, 'image/png');
  } catch (e) { btn.disabled = false; alert('Não foi possível gerar a imagem: ' + e.message); }
}

document.addEventListener('DOMContentLoaded', init);
