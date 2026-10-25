// Pre-Crime Studio — interface. Desenha topo, menu, barra de status e troca de tela.
import { store, call, refreshWorkspace, envStatus } from './lib/store.js';
import { icon } from './lib/icons.js';
import { esc, toast } from './lib/dom.js';
import { PHASE_INFO, PIPELINE_ORDER } from './lib/phases.js';
import './components/pc-stepper.js';
import { initLog } from './components/pc-log-drawer.js';
import { mountPhase } from './screens/phase.js';

const SCREENS = {
  welcome: () => import('./screens/welcome.js').then((m) => m.mount),
  home: () => import('./screens/home.js').then((m) => m.mount),
  env: () => import('./screens/env.js').then((m) => m.mount),
  map: () => import('./screens/map.js').then((m) => m.mount),
  logs: () => import('./screens/logs.js').then((m) => m.mount),
  settings: () => import('./screens/settings.js').then((m) => m.mount),
};
for (const id of PIPELINE_ORDER) SCREENS[id] = async () => mountPhase(id);
SCREENS.ssp = () => import('./screens/ssp.js').then((m) => m.mount);
SCREENS.publish = () => import('./screens/publish.js').then((m) => m.mount);
SCREENS.clean = () => import('./screens/clean.js').then((m) => m.mount);
SCREENS.features = () => import('./screens/features.js').then((m) => m.mount);
SCREENS.filter = () => import('./screens/filter.js').then((m) => m.mount);
SCREENS.train = () => import('./screens/train.js').then((m) => m.mount);
SCREENS.predict = () => import('./screens/predict.js').then((m) => m.mount);
SCREENS.validate = () => import('./screens/validate.js').then((m) => m.mount);
SCREENS.cycle = () => import('./screens/cycle.js').then((m) => m.mount);
SCREENS.science = () => import('./screens/science.js').then((m) => m.mount);
SCREENS.risk = () => import('./screens/risk.js').then((m) => m.mount);
SCREENS.pois = () => import('./screens/pois.js').then((m) => m.mount);
SCREENS.runs = () => import('./screens/runs.js').then((m) => m.mount);

const NAV = [
  { group: null, items: [['home', 'Início', 'home'], ['cycle', 'Ciclo mensal', 'cycle'], ['env', 'Ambiente', 'env']] },
  // "Mapa de risco" (Ensemble, pontos de interesse e cobertura) e "Pontos de interesse" (conjuntos) entre o Treino e a Previsão
  { group: 'Pipeline', items: PIPELINE_ORDER.filter((id) => id !== 'publish').flatMap((id) => [[id, PHASE_INFO[id].title, PHASE_INFO[id].icon], ...(id === 'train' ? [['risk', 'Mapa de risco', 'map'], ['pois', 'Pontos de interesse', 'map']] : [])]) },
  { group: 'Resultados', items: [['map', 'Mapa', 'map'], ['publish', 'Publicação', 'publish']] },
  { group: 'Pesquisa', items: [['science', 'Modo científico', 'flask'], ['runs', 'Execuções', 'runs']] },
];

let unmount = null;
let current = null;

export async function applySettings(s) {
  const prev = store.get().settings;
  store.set({ settings: s }, 'settings');
  document.documentElement.dataset.theme = s.themeResolved;
  document.body.classList.toggle('nav-collapsed', !!s.sidebarCollapsed);
  drawTopbar();
  if (prev && prev.themeResolved !== s.themeResolved && current === 'map') { current = null; await route(); }
}

function drawTopbar() {
  const s = store.get().settings || {};
  document.getElementById('topbar').innerHTML = `
    <button class="icon-btn" data-act="nav" title="Recolher ou expandir o menu" aria-label="Recolher menu">${icon('sidebar')}</button>
    <span class="brand"><img class="brand-mark" src="assets/logo.svg" alt="">Pre-Crime Studio</span>
    ${s.dataDir ? `<button class="ws-chip" data-act="ws" title="Pasta de trabalho: ${esc(s.dataDir)}">${icon('folder')}<span>${esc(s.dataDir)}</span></button>` : ''}
    <span class="spacer"></span>
    <button class="icon-btn" data-act="theme" title="Alternar tema">${icon(s.themeResolved === 'dark' ? 'sun' : 'moon')}</button>
    <button class="icon-btn" data-act="settings" title="Configurações">${icon('settings')}</button>`;
}

function drawSidebar() {
  const { screen, ws } = store.get();
  const st = Object.fromEntries((ws?.phases || []).map((p) => [p.id, p.status]));
  st.env = envStatus();
  const run = store.get().run;
  if (run) st[run.job] = 'running';
  document.getElementById('sidebar').innerHTML = NAV.map(({ group, items }) =>
    `${group ? `<div class="nav-group">${group}</div>` : ''}${items.map(([id, label, ic]) =>
      `<button class="nav-item ${screen === id ? 'active' : ''}" data-screen="${id}" title="${esc(label)}">${icon(ic)}<span>${esc(label)}</span>${st[id] ? `<i class="dot" data-status="${st[id]}"></i>` : ''}</button>`).join('')}`).join('')
    + `<div class="nav-bottom"><button class="nav-item ${screen === 'logs' ? 'active' : ''}" data-screen="logs">${icon('logs')}<span>Logs</span></button>
       <button class="nav-item ${screen === 'settings' ? 'active' : ''}" data-screen="settings">${icon('settings')}<span>Configurações</span></button></div>`;
}

function runStatusHtml() {
  const r = store.get().run;
  if (!r) return '<span class="sb muted">Nenhuma execução em andamento</span>';
  const s = Math.round((Date.now() - r.startedAt) / 1000);
  const t = s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
  return `<button class="sb sb-run" data-screen-go="${esc(r.job)}" title="Ir para a fase em execução"><i class="spin"></i>Executando: <b>${esc(r.label)}</b> · <span class="num">${t}</span></button>`;
}

function drawStatus() {
  const { metrics: m, ws } = store.get();
  const pct = m ? Math.round((m.ramUsedGb / m.ramTotalGb) * 100) : 0;
  const nDone = ws?.phases ? ws.phases.filter((p) => p.status === 'done').length : 0;
  document.getElementById('statusbar').innerHTML = `
    <span class="sb">${ws?.configured === false ? 'Escolha a pasta de trabalho' : ws?.phases ? `${nDone}/${ws.phases.length} fases concluídas` : 'Lendo a pasta de trabalho…'}</span>
    ${runStatusHtml()}
    <span class="spacer"></span>
    <span class="sb">CPU <span class="meter"><i style="width:${m?.cpuPct ?? 0}%"></i></span><span class="num">${m?.cpuPct ?? '—'}%</span></span>
    <span class="sb">RAM <span class="meter"><i style="width:${pct}%"></i></span><span class="num">${m ? `${m.ramUsedGb}/${m.ramTotalGb} GB` : '—'}</span></span>`;
}

const onboarding = () => !store.get().settings?.dataDir;

async function route() {
  document.body.classList.toggle('onboarding', onboarding());
  const screen = onboarding() ? 'welcome' : (store.get().screen === 'welcome' ? 'home' : store.get().screen);
  if (screen === current) return;
  current = screen;
  unmount?.(); unmount = null;
  const old = document.getElementById('screen');
  const el = document.createElement('main');
  el.id = 'screen'; el.className = 'screen'; el.tabIndex = -1;
  old.replaceWith(el); // elemento novo: ouvintes da tela anterior somem junto
  try {
    const mount = await (SCREENS[screen] || SCREENS.home)();
    if (current !== screen) return;
    unmount = mount(el) || null;
  } catch (e) {
    el.innerHTML = `<div class="empty">Falha ao abrir a tela.<br>${esc(e.message)}</div>`;
    call('logs:fromRenderer', 'error', 'tela:' + screen, e.stack || e.message).catch(() => {});
  }
}

function bind() {
  document.body.addEventListener('click', async (e) => {
    const nav = e.target.closest('.sidebar [data-screen]');
    if (nav) store.set({ screen: nav.dataset.screen });
    const go = e.target.closest('[data-go]');
    if (go && !go.disabled) { store.set({ screen: go.dataset.go }); document.getElementById('screen')?.scrollTo(0, 0); }
    const act = e.target.closest('.topbar [data-act]')?.dataset.act;
    if (!act) return;
    const s = store.get().settings;
    if (act === 'nav') applySettings(await call('settings:set', { sidebarCollapsed: !s.sidebarCollapsed }));
    if (act === 'theme') applySettings(await call('settings:set', { theme: s.themeResolved === 'dark' ? 'light' : 'dark' }));
    if (act === 'settings' || act === 'ws') store.set({ screen: 'settings' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
      e.preventDefault();
      const z = store.get().settings?.zoom || 1;
      const next = e.key === '0' ? 1 : Math.min(1.5, Math.max(0.8, +(z + (e.key === '-' ? -0.05 : 0.05)).toFixed(2)));
      call('settings:set', { zoom: next }).then(applySettings);
    }
    if (e.key === 'F5') { e.preventDefault(); refreshWorkspace(); }
  });
  window.addEventListener('focus', () => refreshWorkspace());
  window.addEventListener('error', (e) => call('logs:fromRenderer', 'error', 'janela', `${e.message} (${e.filename}:${e.lineno})`).catch(() => {}));
  window.addEventListener('unhandledrejection', (e) => call('logs:fromRenderer', 'error', 'promessa', String(e.reason?.stack || e.reason)).catch(() => {}));
  window.pc.on('sys:metrics', (m) => { store.set({ metrics: m }, 'metrics'); });
  // Imagens do mapa (PNG) são gravadas pelo app em publish/imagens
  window.pc.on('env:python', (py) => store.set({ python: py }, 'python'));
  window.pc.on('run:event', (p) => {
    if (p.t === 'start') store.set({ run: { runId: p.runId, job: p.job, label: p.label, startedAt: p.startedAt } }, 'run');
    if (p.t === 'end') store.set({ run: null }, 'run');
  });
  document.getElementById('statusbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-screen-go]');
    if (b) store.set({ screen: b.dataset.screenGo });
  });
  window.pc.on('download:done', (d) => {
    toast(`Imagem salva: ${d.name}`, 'ok', 8000, { label: 'Mostrar na pasta', fn: () => call('workspace:reveal', d.path).catch((e) => toast(e.message, 'err')) });
    refreshWorkspace();
  });
  window.pc.on('theme:changed', async () => applySettings(await call('settings:get')));
}

async function start() {
  try {
    const [s, info] = await Promise.all([call('settings:get'), call('app:info')]);
    store.set({ info });
    await applySettings(s);
  } catch (e) { toast('Falha ao iniciar: ' + e.message, 'err', 10000); }
  drawSidebar(); drawStatus();
  store.subscribe((_s, why) => {
    if (why === 'metrics') return drawStatus();
    if (why === 'python' || why === 'run') { drawSidebar(); drawStatus(); return; }
    if (why === 'ui' || why === 'ws' || why === 'settings') { drawSidebar(); drawStatus(); route(); }
  });
  bind();
  await initLog();
  route();
  await refreshWorkspace();
  call('env:python').then((py) => store.set({ python: py }, 'python')).catch(() => {});
  call('run:status').then((r) => { if (r) store.set({ run: r }, 'run'); }).catch(() => {});
}

start();
