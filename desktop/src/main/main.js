// Pre-Crime Studio — processo principal (Electron).
const { app, BrowserWindow, dialog, shell, nativeTheme, nativeImage, Menu, powerSaveBlocker, Notification, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');

const paths = require('./paths');

// datas e campos de mês em português (o Chromium usaria o idioma do sistema)
app.commandLine.appendSwitch('lang', 'pt-BR');
const { Logger } = require('./services/logger');
const { Settings } = require('./services/settings');
const workspace = require('./services/workspace');
const ssp = require('./services/ssp');
const sspProfile = require('./services/sspProfile');
const hardware = require('./services/hardware');
const geojsonExport = require('./services/geojsonExport');
const { MapServer } = require('./services/mapServer');
const { PythonEnv } = require('./services/pythonEnv');
const { RunManager } = require('./services/runManager');
const sysMetrics = require('./services/sysMetrics');
const forecast = require('./services/forecast');
const { Publisher } = require('./services/publisher');
const { SequenceRunner } = require('./services/sequence');
const cycle = require('./services/cycle');
const modelParams = require('./services/modelParams');
const areasSvc = require('./services/areas');
const { Basemap } = require('./services/basemap');
const riskParams = require('./services/riskParams');
const poiSets = require('./services/poiSets');
const importMalhasSvc = require('./services/importMalhas');
const padroes = require('./services/padroes');
const replayExport = require('./services/replayExport');

/** O que está diferente do padrão da dissertação, por tela (Configurações → Restaurar tudo). */
function defaultsSummary(ws) {
  const P = padroes.padroes();
  const itens = [];
  const lp = sspProfile.readParams(ws), D = sspProfile.DEFAULTS;
  const difL = [];
  if (JSON.stringify(lp.municipios) !== JSON.stringify(D.municipios)) difL.push('cidades');
  if (JSON.stringify([...lp.ocorrencias].sort()) !== JSON.stringify([...D.ocorrencias].sort())) difL.push('ocorrências');
  if (lp.veiculos !== null) difL.push('tipos de veículo');
  if (lp.removerRepetidos !== D.removerRepetidos) difL.push('registros repetidos');
  if (difL.length) itens.push({ tela: 'Limpeza', screen: 'clean', o: difL });
  if (sspProfile.readFilter(ws).removerCelulasRepetidas !== P.FILTER_PARAMS.REMOVER_CELULAS_REPETIDAS) itens.push({ tela: 'Filtragem', screen: 'filter', o: ['células repetidas da malha'] });
  const ds = sspProfile.readDataset(ws);
  if (ds.inicio !== sspProfile.DATASET_DEFAULTS.inicio || ds.fim) itens.push({ tela: 'Features', screen: 'features', o: [ds.inicio !== sspProfile.DATASET_DEFAULTS.inicio ? 'início do período' : null, ds.fim ? 'data final do período' : null].filter(Boolean) });
  const mud = modelParams.changed(ws);
  const tr = [...Object.keys(mud).map((m) => `parâmetros do ${m}`), ...(modelParams.seed(ws) !== modelParams.SEED_PADRAO ? ['semente'] : [])];
  if (tr.length) itens.push({ tela: 'Treino', screen: 'train', o: tr });
  const rv = riskParams.view(ws);
  if (rv.nMudados) {
    const abas = [...new Set(Object.keys(rv.mudados.valores).map((k) => riskParams.SCHEMA.find((p) => p.k === k)?.aba).concat(Object.keys(rv.mudados.poi).length ? ['poi'] : []))];
    itens.push({ tela: 'Mapa de risco', screen: 'risk', o: abas.map((a) => riskParams.ABAS.find(([k]) => k === a)?.[1] || a) });
  }
  return { itens, padrao: !itens.length };
}
const { makeHandle } = require('./ipc/handle');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Ícone da janela e da barra de tarefas. No app instalado o .ico fica fora do app.asar
// (resources/icon.ico): o Windows lê o ícone de um arquivo de verdade, e de dentro do asar ele
// cai no ícone do Electron.
const APP_ICON = (() => {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon-256.png';
  const packed = app.isPackaged ? path.join(process.resourcesPath, file) : null;
  return packed && fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'renderer', 'assets', file);
})();
// Windows: o identificador do app (o mesmo do atalho criado pelo instalador) agrupa a janela e as
// notificações com o ícone do Pre-Crime Studio. Em desenvolvimento (npm start) não há atalho com
// esse identificador, e o Windows mostraria o ícone do electron.exe; lá vale o ícone da janela.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('br.com.faustinopsy.precrime-studio');

const log = new Logger(paths.logsDir()).captureProcess();
const settings = new Settings(paths.userData());
const basemap = new Basemap({ dir: paths.userData(), safeStorage, net, log });
const mapServer = new MapServer({ serverJs: paths.SERVER_JS, log, env: () => ({ PRECRIME_BASEMAP: JSON.stringify(basemap.forServer()) }) });
const publisher = new Publisher({ serverDir: path.dirname(paths.SERVER_JS), log, appVersion: app.getVersion() });
const pythonEnv = new PythonEnv({ repoRoot: paths.REPO_ROOT, userData: paths.userData(), settings, log, hardware });
let win = null;
let blocker = null;
const runs = new RunManager({
  log, repoRoot: paths.REPO_ROOT,
  appInfo: { name: 'Pre-Crime Studio', version: app.getVersion(), electron: process.versions.electron, platform: process.platform },
  send: (ch, p) => {
    send(ch, p);
    if (p.t === 'end') {
      if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
      if (win && !win.isFocused() && Notification.isSupported()) {
        const txt = { ok: 'concluída', error: 'falhou', cancelled: 'cancelada' }[p.status] || p.status;
        new Notification({ title: 'Pre-Crime Studio', icon: APP_ICON, body: `${p.manifest?.label || 'Execução'} ${txt}` }).show();
      }
    }
  },
});
let metricsTimer = null;
let lastHardware = null;
let seq = null; // SequenceRunner (criado em registerIpc, usa startRun)

// Pasta de trabalho escolhida pelo usuário (null até a primeira configuração).
const dataDir = () => settings.get().dataDir || null;
function requireWs() {
  const d = dataDir();
  if (!d) throw new Error('Escolha a pasta de trabalho primeiro.');
  return d;
}
const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

function uniquePath(dir, name) {
  const ext = path.extname(name), stem = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

/** Caminho dentro da pasta de trabalho (recusa qualquer coisa fora dela). */
function insideWs(p) {
  const root = path.resolve(requireWs());
  const abs = path.resolve(String(p || ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Caminho fora da pasta de trabalho.');
  return abs;
}

/** Pastas das etapas: criadas pelo app depois que entram as planilhas. */
async function ensureStages(ws) {
  const r = await workspace.ensure(ws, { baseDir: paths.BASE_DIR, full: true, onProgress: (p) => send('workspace:progress', p) });
  if (r.created.length || r.seeded.length) {
    log.ok('workspace', 'pastas das etapas criadas' + (r.created.length ? `: ${r.created.join(', ')}` : '') + (r.seeded.length ? ` · copiados da base: ${r.seeded.join(', ')}` : ''));
  }
  return r;
}

/** Só os parâmetros que a fase usa (ficam registrados no manifesto da execução). */
function overridesFor(job, all) {
  if (job === 'clean') return { CLEAN_PARAMS: all.CLEAN_PARAMS };
  // a Filtragem mapeia todos os meses; o período do dataset é aplicado em Features
  if (job === 'filter') return { DATE_START_DATA: '2000-01-01', FILTER_PARAMS: all.FILTER_PARAMS };
  if (job === 'features' || job === 'train') {
    const o = { DATE_START_DATA: all.DATE_START_DATA };
    if (all.DATA_END) o.DATA_END = all.DATA_END;
    return o;
  }
  // com data final no dataset, a previsão usa a última semana conhecida (replay sem vazamento)
  if (job === 'predict' || job === 'ensemble') return all.DATA_END ? { DATA_END: all.DATA_END } : {};
  // o gabarito da validação e os rótulos do Modo científico usam o início do período e a malha
  if (job === 'validate') return { DATE_START_DATA: all.DATE_START_DATA };
  if (job === 'science') return { DATE_START_DATA: all.DATE_START_DATA, FILTER_PARAMS: all.FILTER_PARAMS };
  if (job === 'areas') return {};
  return all;
}

/** Arquivos de entrada de cada fase (vão para o manifesto com sha256). */
function inputsFor(job, ws, area, opts) {
  const ls = (dir, re) => { try { return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f)); } catch { return []; } };
  const only = (files) => (area ? files.filter((f) => path.basename(f).includes(area)) : files);
  if (job === 'clean') return ssp.list(ws).map((f) => ({ path: path.join(ws, 'dados_ssp', f.name), sha256: f.sha256 }));
  if (job === 'areas') {
    const f = opts?.fonte ? path.join(ws, 'areas', 'fontes', opts.fonte) : null;
    return f && fs.existsSync(f) ? [{ path: f }] : [];
  }
  if (job === 'filter') return [path.join(ws, 'raw', 'dados_unificados.csv'), ...only(ls(path.join(ws, 'streets'), /^(grids|ruas)_area_\d+\.geojson$/))].map((p) => ({ path: p }));
  if (job === 'features') return only(ls(path.join(ws, 'processed', 'crimes'), /^crimes_area_\d+\.csv$/)).map((p) => ({ path: p }));
  // datasets de centenas de MB: registra tamanho e data, sem sha256 (o sha256 fica no manifesto das Features)
  if (job === 'train') return only(ls(path.join(ws, 'processed', 'datasets'), /^dataset_full_area_\d+\.csv$/)).map((p) => ({ path: p, skipHash: true }));
  // modelos e datasets são grandes: tamanho e data (o sha256 fica nos manifestos do Treino e das Features)
  if (job === 'predict') return [
    ...only(ls(path.join(ws, 'processed', 'models'), /^(rf|lstm|transformer|scaler_lstm|scaler_transformer)_area_\d+\.(pkl|pth)$/)),
    ...only(ls(path.join(ws, 'processed', 'datasets'), /^dataset_full_area_\d+\.csv$/)),
  ].map((p) => ({ path: p, skipHash: true }));
  if (job === 'validate') {
    const tag = (opts?.mes || '').replace('-', '_');
    return [
      ...only(ls(path.join(ws, 'processed', 'results'), new RegExp(`^(results_\\w+_area_\\d+|previsao_area_\\d+)_${tag}\\.(csv|json)$`))).map((p) => ({ path: p })),
      ...only(ls(path.join(ws, 'processed', 'datasets'), /^dataset_full_area_\d+\.csv$/)).map((p) => ({ path: p, skipHash: true })),
      { path: path.join(ws, 'raw', 'dados_unificados.csv') },
    ];
  }
  return [];
}

/** Lê (uma vez) as planilhas que ainda não têm perfil, avisando a interface. */
function profileAll(ws) {
  return sspProfile.ensureProfiles(ws, (p) => send('ssp:profile', p), log);
}

function resolvedTheme() {
  const t = settings.get().theme;
  return t === 'dark' || t === 'light' ? t : (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1180, minHeight: 700,
    title: 'Pre-Crime Studio',
    icon: APP_ICON,
    backgroundColor: resolvedTheme() === 'dark' ? '#0a0f1c' : '#f5f7fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  log.captureWebContents(win.webContents);
  try { win.setIcon(nativeImage.createFromPath(APP_ICON)); } catch { /* fica o ícone da opção acima */ }
  // Windows: o botão da barra de tarefas usa o ícone e o nome do app (também rodando pelo código,
  // em que o processo é o electron.exe; ver tools/dev-icon.cjs)
  if (process.platform === 'win32') {
    try {
      win.setAppDetails({ appId: app.isPackaged ? 'br.com.faustinopsy.precrime-studio' : 'br.com.faustinopsy.precrime-studio.dev', appIconPath: APP_ICON, appIconIndex: 0, relaunchDisplayName: 'Pre-Crime Studio' });
    } catch { /* versões antigas do Windows */ }
  }
  // Imagens baixadas pelo mapa (PNG) vão direto para <pasta>/publish/imagens, sem perguntar.
  win.webContents.session.on('will-download', (_e, item) => {
    const ws = dataDir();
    if (ws) {
      const dir = path.join(ws, 'publish', 'imagens');
      fs.mkdirSync(dir, { recursive: true });
      item.setSavePath(uniquePath(dir, item.getFilename().replace(/[^\w.\-]+/g, '_')));
    }
    item.once('done', (_ev, state) => {
      if (state === 'completed') {
        log.ok('publicação', `imagem salva: ${item.getSavePath()}`);
        send('download:done', { path: item.getSavePath(), name: path.basename(item.getSavePath()) });
      } else if (state !== 'cancelled') log.warn('download', `${item.getFilename()}: ${state}`);
    });
  });

  // Links externos abrem no navegador; navegação da janela principal fica travada no app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });

  win.once('ready-to-show', () => {
    win.webContents.setZoomFactor(settings.get().zoom || 1);
    win.show();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('close', (e) => {
    const r = runs.status();
    const sq = seq?.status();
    if (!r && !sq) return;
    const c = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Continuar executando', 'Cancelar e sair'], defaultId: 0, cancelId: 0,
      title: 'Execução em andamento', message: sq ? `${sq.title} ainda está rodando.` : `${r.label} ainda está rodando.`,
      detail: 'Se sair agora, a execução é cancelada e precisa ser feita de novo.',
    });
    if (c === 0) e.preventDefault(); else { seq?.cancel(); runs.cancel(); }
  });
  win.on('closed', () => { win = null; });
}

// ── IPC ──────────────────────────────────────────────────────────────────────
function registerIpc() {
  const h = makeHandle(log);

  h('app:info', () => ({
    version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
    chrome: process.versions.chrome, platform: process.platform, repoRoot: paths.REPO_ROOT,
    logsDir: paths.logsDir(), dev: process.argv.includes('--dev'),
  }));

  h('settings:get', () => ({ ...settings.get(), dataDirResolved: dataDir(), themeResolved: resolvedTheme() }));
  h('settings:set', (partial) => {
    const { dataDir: _ignored, ...rest } = partial || {};  // a pasta só muda via workspace:setup
    const next = settings.set(rest);
    if ('zoom' in (partial || {}) && win) win.webContents.setZoomFactor(next.zoom || 1);
    if ('theme' in (partial || {})) nativeTheme.themeSource = next.theme;
    return { ...next, dataDirResolved: dataDir(), themeResolved: resolvedTheme() };
  });

  h('workspace:status', () => {
    const d = dataDir();
    if (!d) return { configured: false, suggested: paths.suggestedWorkspace() };
    return { configured: true, ...workspace.inspect(d), areaNames: areasSvc.names(d) };
  });
  h('workspace:suggest', () => workspace.describe(paths.suggestedWorkspace()));
  h('workspace:browse', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pasta de trabalho do Pre-Crime',
      message: 'Onde o app vai guardar planilhas importadas, modelos, previsões e logs de execução',
      defaultPath: dataDir() || path.dirname(paths.suggestedWorkspace()),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return workspace.describe(r.filePaths[0]);
  });
  h('workspace:setup', async (dir) => {
    if (!dir || !path.isAbsolute(dir)) throw new Error('Caminho inválido.');
    // Só a pasta principal (e dados_ssp). As pastas das etapas vêm depois da importação.
    const res = await workspace.ensure(dir, { baseDir: paths.BASE_DIR });
    settings.set({ dataDir: dir });
    await mapServer.stop();
    if (workspace.stagesReady(dir) || workspace.hasSpreadsheets(dir)) {
      const st = await ensureStages(dir);
      res.created.push(...st.created); res.seeded.push(...st.seeded);
      profileAll(dir).catch((e) => log.error('ssp', e));
    }
    log.ok('workspace', `pasta de trabalho: ${dir}` + (res.created.length ? ` · criadas: ${res.created.join(', ')}` : '') + (res.seeded.length ? ` · copiados da base: ${res.seeded.join(', ')}` : ''));
    return { ...res, status: { configured: true, ...workspace.inspect(dir) } };
  });
  h('workspace:reveal', (file) => { shell.showItemInFolder(insideWs(file)); return true; });
  h('workspace:open', async (sub) => {
    const root = requireWs();
    const target = path.join(root, ...String(sub || '').split(/[\\/]/).filter((x) => /^[\w\-]+$/.test(x)));
    await fs.promises.mkdir(target, { recursive: true });
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });

  // Planilhas da SSP: importar arquivos, uma pasta inteira ou o que foi arrastado
  const importAndLog = async (files) => {
    const ws = requireWs();
    if (!files.length) throw new Error('Nenhuma planilha .xlsx encontrada.');
    log.info('ssp', `importando ${files.length} arquivo(s)`);
    const results = await ssp.importFiles(ws, files, (p) => send('ssp:progress', p));
    for (const r of results) log[r.status === 'erro' ? 'error' : r.status === 'igual' ? 'info' : 'ok']('ssp', `${r.name}: ${r.message}`);
    const list = ssp.list(ws);
    let stages = null;
    if (list.length) stages = await ensureStages(ws);
    profileAll(ws).catch((e) => log.error('ssp', e));   // em segundo plano: alimenta a Limpeza
    return { results, files: list, stagesCreated: stages?.created || [] };
  };
  h('ssp:list', () => ssp.list(requireWs()));
  h('ssp:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Importar planilhas da SSP', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Planilhas Excel', extensions: ['xlsx'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return importAndLog(r.filePaths);
  });
  h('ssp:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Pasta com as planilhas da SSP', message: 'Todas as planilhas .xlsx desta pasta serão importadas',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return importAndLog(ssp.scanFolder(r.filePaths[0]));
  });
  h('ssp:importPaths', async (list) => {
    const files = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) continue;
      if (fs.statSync(p).isDirectory()) files.push(...ssp.scanFolder(p)); else files.push(p);
    }
    return importAndLog(files);
  });
  h('ssp:remove', async (name) => {
    await ssp.remove(requireWs(), name);
    log.warn('ssp', `${name} retirada do processamento (movida para dados_ssp/_removidas)`);
    return ssp.list(requireWs());
  });

  h('ssp:profile', async () => { await profileAll(requireWs()); return true; });

  // Limpeza: parâmetros escolhidos pelo operador (pasta de trabalho/parametros.json)
  h('clean:view', async (params) => {
    const ws = requireWs();
    await profileAll(ws);
    return sspProfile.cleanView(ws, params || null);
  });
  h('clean:save', (params) => {
    const ws = requireWs();
    const saved = sspProfile.writeParams(ws, params || {});
    log.ok('limpeza', `parâmetros salvos · cidades: ${saved.municipios.includes('*') ? 'todas' : saved.municipios.join(', ')} · ocorrências: ${saved.ocorrencias.join(', ')} · veículos: ${saved.veiculos ? saved.veiculos.join(', ') : 'todos os reconhecidos'} · repetidos: ${saved.removerRepetidos ? 'remover' : 'manter'}`);
    return sspProfile.cleanView(ws, saved);
  });
  h('clean:reset', () => {
    const ws = requireWs();
    const saved = sspProfile.writeParams(ws, sspProfile.DEFAULTS);
    log.info('limpeza', 'parâmetros voltaram ao padrão');
    return sspProfile.cleanView(ws, saved);
  });

  // Filtragem: opção de juntar as células repetidas da malha
  h('filter:get', () => sspProfile.readFilter(requireWs()));
  h('filter:set', (f) => {
    const saved = sspProfile.writeFilter(requireWs(), f || {});
    log.ok('filtragem', `células repetidas da malha: ${saved.removerCelulasRepetidas ? 'juntar' : 'manter como na dissertação'}`);
    return saved;
  });

  // Features: período do dataset (de quando a quando os modelos usam os dados)
  h('dataset:view', async (d) => {
    const ws = requireWs();
    await profileAll(ws);
    return sspProfile.datasetView(ws, d || null);
  });
  h('dataset:save', (d) => {
    const ws = requireWs();
    const saved = sspProfile.writeDataset(ws, d || {});
    log.ok('features', `período do dataset: ${saved.inicio} até ${saved.fim || 'o último mês com dados'}`);
    return sspProfile.datasetView(ws, saved);
  });
  h('dataset:reset', () => {
    const ws = requireWs();
    const saved = sspProfile.writeDataset(ws, sspProfile.DATASET_DEFAULTS);
    log.info('features', 'período do dataset voltou ao padrão');
    return sspProfile.datasetView(ws, saved);
  });

  // Python do pipeline: verificar, preparar (uv + venv + pacotes + PyTorch) ou escolher um existente
  h('env:python', async (force) => {
    if (pythonEnv.status && !force) return pythonEnv.status;
    const st = await pythonEnv.check();
    send('env:python', st);
    return st;
  });
  h('env:install', async (opts) => {
    const o = { torch: ['auto', 'cuda', 'cpu', 'skip'].includes(opts?.torch) ? opts.torch : 'auto', reinstall: !!opts?.reinstall, onlyTorch: !!opts?.onlyTorch };
    log.info('ambiente', `preparando o ambiente (PyTorch: ${o.torch}${o.reinstall ? ', refazendo do zero' : ''}${o.onlyTorch ? ', só o PyTorch' : ''}) em ${pythonEnv.root}`);
    const ps = powerSaveBlocker.start('prevent-app-suspension');
    try {
      const st = await pythonEnv.install(o, (ev) => send('env:install', ev));
      send('env:python', st);
      return st;
    } finally { powerSaveBlocker.stop(ps); }
  });
  h('env:installCancel', () => pythonEnv.cancelInstall());
  h('env:pickPython', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Escolha o python.exe', message: 'Um Python 3.10 a 3.13 com os pacotes do pipeline',
      properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Python', extensions: ['exe'] }] : [],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = await pythonEnv.useExisting(r.filePaths[0]);
    log.info('ambiente', `Python escolhido: ${r.filePaths[0]} (${st.python?.version || '?'})`);
    send('env:python', st);
    return st;
  });
  h('env:openRoot', async () => { fs.mkdirSync(pythonEnv.root, { recursive: true }); await shell.openPath(pythonEnv.root); return true; });

  // Execuções do pipeline
  // Começa uma execução. extra (usado pelas sequências: ciclo mensal e modo científico):
  //   overrides: { DATA_END: 'AAAA-MM-DD' | null, GLOBAL_SEED: n } por cima dos parâmetros das telas
  //   sequencia: { id, passo } registrado no manifesto
  async function startRun(job, opts = {}, extra = {}) {
    const ws = requireWs();
    if (!['clean', 'filter', 'features', 'train', 'predict', 'validate', 'areas', 'ensemble', 'science', 'pois'].includes(job)) throw new Error('Esta fase ainda não pode ser executada pelo app.');
    const area = opts?.area && /^area_\d{2}$/.test(opts.area) ? opts.area : null;
    const st = pythonEnv.status || await pythonEnv.check();
    if (!st.jobs?.[job]) throw new Error(`O Python do app ainda não tem os pacotes desta fase. Abra a tela Ambiente e use "Preparar ambiente".`);
    await ensureStages(ws);
    if (job === 'clean' && !ssp.list(ws).length) throw new Error('Nenhuma planilha importada. Importe as planilhas em Dados SSP.');
    if (job === 'filter' && !fs.existsSync(path.join(ws, 'raw', 'dados_unificados.csv'))) throw new Error('Rode a Limpeza antes da Filtragem.');
    let extraArgs = [], options = {};
    if (job === 'train') {
      const modelos = (Array.isArray(opts.modelos) ? opts.modelos : ['rf', 'lstm', 'transformer']).filter((m) => ['rf', 'lstm', 'transformer'].includes(m));
      if (!modelos.length) throw new Error('Escolha ao menos um modelo.');
      if (modelos.some((m) => m !== 'rf') && !st.packages?.torch?.ok) throw new Error('O PyTorch não está instalado. Abra a tela Ambiente e use "Preparar ambiente".');
      options = { completo: !!opts.completo, modo: opts.modo === 'sequencial' ? 'sequencial' : 'paralelo', modelos };
      extraArgs = [...(options.completo ? ['--completo'] : []), '--modo', options.modo, '--modelos', modelos.join(',')];
    }
    if (job === 'pois') {
      // conjunto novo de pontos de interesse: download do OpenStreetMap ou arquivo próprio
      const { path: spec, spec: sp } = poiSets.writeSpec(ws, opts);
      options = sp.acao === 'osm'
        ? { acao: 'osm', itens: sp.itens.map((i) => `${i.chave}=${i.valor}`), areas: sp.areas || 'todas', dedup_m: sp.dedup_m, juntarCom: sp.juntarCom }
        : { acao: 'importar', arquivo: sp.original, campoCategoria: sp.campoCategoria, datas: !!(sp.campoAbertura || sp.campoFechamento), dedup_m: sp.dedup_m, juntarCom: sp.juntarCom, areas: sp.areas || 'todas' };
      extraArgs = ['--spec', spec];
    }
    if (job === 'areas') {
      // criar áreas a partir do arquivo do operador, ou baixar ruas/POIs de uma área já criada
      const { path: spec, spec: sp } = opts.osmPara ? areasSvc.writeOsmSpec(ws, String(opts.osmPara)) : areasSvc.writeSpec(ws, opts);
      options = sp.acao === 'osm' ? { acao: 'osm', areas: sp.areas } : { acao: 'criar', fonte: path.basename(sp.arquivo), modo: sp.modo, nome: sp.nome, celula: sp.celula, osm: sp.osm, poligonos: sp.indices ? sp.indices.length : 'todos' };
      extraArgs = ['--spec', spec];
    }
    if (job === 'predict' || job === 'validate') {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.mes || '')) throw new Error('Escolha o mês.');
      const fi = forecast.info(ws);
      if (job === 'predict') {
        const alvo = fi.areas.filter((a) => a.models.length && (!area || a.area === area));
        if (!alvo.length) throw new Error('Nenhum modelo treinado' + (area ? ' nesta área' : '') + '. Rode o Treino antes.');
        if (alvo.some((a) => a.models.some((m) => m !== 'RF')) && !st.packages?.torch?.ok) throw new Error('O PyTorch não está instalado. Abra a tela Ambiente e use "Preparar ambiente".');
      }
      options = { mes: opts.mes };
      extraArgs = ['--mes', opts.mes];
      if (job === 'predict' && Array.isArray(opts.modelos) && opts.modelos.length) {
        options.modelos = opts.modelos.filter((m) => ['rf', 'lstm', 'transformer'].includes(m));
        extraArgs.push('--modelos', options.modelos.join(','));
      }
    }
    if (job === 'ensemble') {
      // variantes do Ensemble (Modo científico) ou pré-visualização da tela Mapa de risco
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.mes || '')) throw new Error('Escolha o mês.');
      options = { mes: opts.mes };
      extraArgs = ['--mes', opts.mes];
      if (opts.previa) { options.previa = true; extraArgs.push('--previa'); }
      else if (Array.isArray(opts.variantes) && opts.variantes.length) {
        options.variantes = opts.variantes.filter((v) => /^([a-z]{2,12}|poiset:[a-z0-9][a-z0-9-]{0,47})$/.test(v));
        extraArgs.push('--variantes', options.variantes.join(','));
      }
    }
    if (job === 'science') {
      const meses = (opts.meses || []).filter((m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m));
      if (!meses.length) throw new Error('Informe os meses do replay.');
      const acao = ['metricas', 'agregar', 'vazamento'].includes(opts.acao) ? opts.acao : 'metricas';
      options = { meses, acao };
      extraArgs = ['--meses', meses.join(','), '--acao', acao];
      if (acao === 'agregar') { options.seeds = (opts.seeds || []).filter(Number.isInteger); extraArgs.push('--seeds', options.seeds.join(',')); }
      else { if (!Number.isInteger(opts.seed)) throw new Error('Informe a semente.'); options.seed = opts.seed; extraArgs.push('--seed', String(opts.seed)); }
    }
    const overrides = overridesFor(job, sspProfile.pipelineOverrides(ws));
    // extra.padrao: o Modo científico roda com os valores da dissertação (modelos, Ensemble e cobertura),
    // a não ser que o operador peça a configuração personalizada
    const usarPersonalizado = !extra.padrao;
    if (job === 'train' && usarPersonalizado) {
      // hiperparâmetros e semente da tela Treino: só entram os diferentes do padrão
      Object.assign(overrides, modelParams.overrides(ws));
      const mud = modelParams.changed(ws);
      if (Object.keys(mud).length) options.parametros = mud;
    }
    // conjunto de pontos de interesse: o escolhido no Modo científico (extra.poiSet), o ativo na tela
    // Pontos de interesse (uso normal) ou a dissertação (replay com os valores da dissertação)
    let poiSet = null;
    if (['predict', 'ensemble', 'science'].includes(job)) {
      poiSet = extra.poiSet || (usarPersonalizado ? poiSets.ativo(ws) : poiSets.ID_DISS);
      if (poiSet !== poiSets.ID_DISS) { Object.assign(overrides, poiSets.overrides(ws, poiSet)); options.conjuntoPoi = poiSet; }
    }
    if (['predict', 'ensemble', 'validate'].includes(job) && usarPersonalizado) {
      // tela Mapa de risco (Ensemble, pontos de interesse, cobertura); a pré-visualização usa os valores ainda não salvos
      const rascunho = job === 'ensemble' && opts.previa && opts.rascunho ? riskParams.draft(ws, opts.rascunho) : null;
      Object.assign(overrides, riskParams.overrides(ws, job, rascunho));
    }
    if (extra.padrao) options.padraoDissertacao = true;
    for (const [k, v] of Object.entries(extra.overrides || {})) {
      if (k === 'DATA_END' && !['features', 'train', 'predict', 'ensemble'].includes(job)) continue;
      if (v === null || v === undefined) delete overrides[k]; else overrides[k] = v;
    }
    if (extra.sequencia) options.sequencia = extra.sequencia;
    if (overrides.GLOBAL_SEED != null) options.seed = overrides.GLOBAL_SEED;
    if (overrides.DATA_END) options.dataEnd = overrides.DATA_END;
    // o que está diferente do padrão da dissertação (vai para o manifesto)
    const personalizado = padroes.diferencas(overrides, { todosTipos: Object.keys(sspProfile.VEICULOS) });
    if (poiSet && poiSet !== poiSets.ID_DISS) personalizado.POI_SET = [poiSet, poiSets.ID_DISS];
    if (Object.keys(personalizado).length) options.personalizado = padroes.resumo(personalizado);
    const r = await runs.start(job, {
      ws, area, options, extraArgs, python: pythonEnv.pythonPath(), pythonStatus: st,
      overrides, personalizado,
      inputs: inputsFor(job, ws, area, options),
    });
    if (blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    return r;
  }
  h('run:start', (job, opts = {}) => {
    if (seq?.status()) throw new Error('Há uma sequência em andamento. Espere terminar ou cancele.');
    return startRun(job, opts);
  });

  // Sequências: ciclo mensal ("Fazer tudo") e modo científico (replay sem vazamento, multi-seed)
  let seqBlocker = null;
  seq = new SequenceRunner({
    log, send, runs, startRun,
    resolvers: cycle.makeResolvers({ forecast }),
    internals: cycle.makeInternals({ publisher, forecast, send, log }),
    onBusy: (busy) => {
      if (busy && seqBlocker === null) seqBlocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!busy && seqBlocker !== null) { powerSaveBlocker.stop(seqBlocker); seqBlocker = null; }
      if (!busy && win && !win.isFocused() && Notification.isSupported()) new Notification({ title: 'Pre-Crime Studio', icon: APP_ICON, body: 'Sequência terminada. Abra o app para ver o resultado.' }).show();
    },
  });
  const planDeps = () => ({ runs, workspace, forecast, sspProfile, hardware: lastHardware });
  h('cycle:plan', async () => { const ws = requireWs(); await profileAll(ws).catch(() => {}); return cycle.cyclePlan(ws, planDeps()); });
  h('replay:plan', async (params) => { const ws = requireWs(); await profileAll(ws).catch(() => {}); return cycle.replayPlan(ws, params || {}, planDeps()); });
  h('replay:summary', () => cycle.replaySummary(requireWs()));
  h('seq:start', async (plan) => {
    const ws = requireWs();
    const st = pythonEnv.status || await pythonEnv.check();
    const JOBS = ['clean', 'filter', 'features', 'train', 'predict', 'validate', 'ensemble', 'science'];
    const okPoi = (id) => !id || (/^[a-z0-9][a-z0-9-]{0,47}$/.test(id) && (id === poiSets.ID_DISS || poiSets.manifesto(ws, id)?.status === 'pronto'));
    const INTERNALS = ['snapshotSeed', 'restoreSeed', 'collectSeed', 'aggregateSeeds', 'publishCycle', 'snapshotLeak'];
    const RESOLVE = ['validateReady', 'validateIfReady', 'predictNext'];
    const steps = (plan?.steps || []).map((s) => {
      if (s.kind === 'job' && !JOBS.includes(s.job)) throw new Error('Passo inválido.');
      if (s.kind === 'internal' && !INTERNALS.includes(s.internal)) throw new Error('Passo inválido.');
      if (s.resolve && !RESOLVE.includes(s.resolve)) throw new Error('Passo inválido.');
      const ov = {};
      if (s.overrides && 'DATA_END' in s.overrides) ov.DATA_END = s.overrides.DATA_END === null ? null : (/^\d{4}-\d{2}-\d{2}$/.test(s.overrides.DATA_END) ? s.overrides.DATA_END : (() => { throw new Error('Data final inválida.'); })());
      if (s.overrides?.GLOBAL_SEED != null) ov.GLOBAL_SEED = Number(s.overrides.GLOBAL_SEED);
      if (!okPoi(s.poiSet)) throw new Error(`O conjunto de pontos de interesse "${s.poiSet}" não existe ou não foi salvo.`);
      return { id: s.id, kind: s.kind, job: s.job, internal: s.internal, resolve: s.resolve, opts: s.opts, args: s.args, overrides: ov, padrao: !!s.padrao, poiSet: s.poiSet || null, label: String(s.label || ''), skip: !!s.skip, secs: s.secs ?? null };
    });
    const jobsUsed = [...new Set(steps.filter((s) => s.kind === 'job' && !s.skip).map((s) => s.job))];
    const missing = jobsUsed.filter((j) => !st.jobs?.[j]);
    if (missing.length) throw new Error('O Python do app ainda não tem os pacotes para: ' + missing.join(', ') + '. Abra a tela Ambiente.');
    await ensureStages(ws);
    return seq.start(ws, { kind: plan.kind === 'replay' ? 'replay' : 'ciclo', title: String(plan.title || 'Sequência'), params: plan.params || {}, steps });
  });
  h('seq:cancel', () => seq.cancel());
  h('seq:status', () => seq.status());
  h('seq:list', (limit) => seq.list(requireWs(), limit || 20));
  h('run:cancel', () => runs.cancel());
  h('forecast:info', () => forecast.info(requireWs()));

  // Áreas de estudo do operador (GeoJSON, KML, Shapefile .zip, GeoPackage)
  h('areas:list', () => areasSvc.list(requireWs()));
  const inspectArea = async (p) => {
    const st = pythonEnv.status || await pythonEnv.check();
    if (!st.jobs?.filter) throw new Error('O Python do app ainda não tem os pacotes de mapa. Abra a tela Ambiente e use "Preparar ambiente".');
    const r = await areasSvc.inspect(requireWs(), p, { python: pythonEnv.pythonPath(), repoRoot: paths.REPO_ROOT });
    log.info('áreas', `${r.original}: ${r.n} polígono(s), ${r.km2Total.toLocaleString('pt-BR')} km²${r.ignoradas ? ` (${r.ignoradas} feição(ões) sem polígono ignorada(s))` : ''}`);
    return r;
  };
  h('areas:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Arquivo com o contorno das áreas', properties: ['openFile'],
      filters: [{ name: 'Mapas (GeoJSON, KML, Shapefile .zip, GeoPackage)', extensions: areasSvc.EXTS }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return inspectArea(r.filePaths[0]);
  });
  h('areas:inspectPath', (p) => inspectArea(String(p || '')));
  // malhas, ruas e pontos de interesse de pastas ou de vários arquivos de uma vez (pelo conteúdo, não pelo nome)
  const importMalhas = async (lista) => {
    const ws = requireWs();
    const r = importMalhasSvc.importar(ws, lista);
    const { malhas, ruas, pois } = r.resumo;
    log[malhas + ruas + pois ? 'ok' : 'info']('áreas', `importação: ${malhas} malha(s), ${ruas} arquivo(s) de ruas e ${pois} de pontos de interesse`
      + `${r.existiam.length ? ` · ${r.existiam.length} já existiam e foram mantidos` : ''}${r.contornos.length ? ` · ${r.contornos.length} contorno(s) (use Adicionar área)` : ''}${r.invalidos.length ? ` · ${r.invalidos.length} inválido(s)` : ''}`);
    for (const a of r.avisos) log.warn('áreas', a);
    if (pois) { try { poiSets.ensureDissertacao(ws); } catch { /* refeito na próxima leitura */ } }
    return { tipo: 'base', ...r, lista: areasSvc.list(ws) };
  };
  h('areas:importBase', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Pasta com as malhas (GeoJSON)', properties: ['openDirectory', 'multiSelections'] });
    if (r.canceled || !r.filePaths.length) return null;
    return importMalhas(r.filePaths);
  });
  h('areas:importFiles', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Arquivos das malhas, ruas e pontos de interesse (GeoJSON)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    return importMalhas(r.filePaths);
  });
  // arrastar: pasta ou vários arquivos → importa; um arquivo só → pelo conteúdo (malha, ruas ou pontos importa; contorno vira área nova)
  h('areas:drop', async (lista) => {
    const ps = (Array.isArray(lista) ? lista : []).map(String).filter(Boolean);
    if (!ps.length) return null;
    const pasta = ps.some((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    if (ps.length > 1 || pasta || ['malha', 'ruas', 'pontos'].includes(importMalhasSvc.tipoDoArquivo(ps[0]))) return importMalhas(ps);
    return { tipo: 'area', ...(await inspectArea(ps[0])) };
  });
  // "Adicionar área" com um arquivo que já é uma malha de células: importa como malha
  h('areas:importFonte', (fonte) => {
    const f = path.join(requireWs(), 'areas', 'fontes', path.basename(String(fonte || '')));
    if (!fs.existsSync(f)) throw new Error('Escolha o arquivo de novo.');
    return importMalhas([f]);
  });
  h('areas:remove', (area) => {
    const r = areasSvc.remove(requireWs(), String(area || ''));
    log.warn('áreas', `${area} removida: ${r.arquivos} arquivo(s) em ${path.relative(requireWs(), r.pasta)}`);
    return areasSvc.list(requireWs());
  });

  // Treino: hiperparâmetros dos modelos (recomendados = dissertação; o operador pode mudar)
  h('train:params', () => modelParams.view(requireWs()));
  h('train:paramsSet', (modelo, valores) => {
    const v = modelParams.set(requireWs(), String(modelo || ''), valores || {});
    const d = v.mudados[modelo];
    log.info('treino', `parâmetros do ${modelo}: ${d ? Object.entries(d).map(([k, x]) => `${k}=${x}`).join(', ') : 'recomendados'}`);
    return v;
  });
  h('train:paramsReset', (modelo) => {
    const v = modelParams.reset(requireWs(), modelo ? String(modelo) : null);
    log.info('treino', `parâmetros ${modelo ? `do ${modelo} ` : ''}voltaram aos recomendados`);
    return v;
  });

  h('train:seedSet', (n) => {
    const v = modelParams.setSeed(requireWs(), n);
    log.info('treino', `semente do treino: ${v.semente.valor}${v.semente.valor === v.semente.padrao ? ' (padrão da dissertação)' : ''}`);
    return v;
  });

  // Mapa de risco: Ensemble, pontos de interesse e área de cobertura
  h('risk:view', (area) => riskParams.view(requireWs(), area || null));
  h('risk:set', (d) => {
    const ws = requireWs();
    riskParams.set(ws, d || {});
    const v = riskParams.view(ws, d?.area || null);
    log.info('mapa de risco', v.nMudados ? `diferente da dissertação: ${padroes.resumo(padroes.diferencas({ ...riskParams.overrides(ws, 'predict'), ...riskParams.overrides(ws, 'validate') })).join(', ')}` : 'padrão da dissertação');
    return v;
  });
  h('risk:reset', (aba, area) => {
    const ws = requireWs();
    riskParams.reset(ws, aba || null);
    log.info('mapa de risco', `${aba ? `aba ${aba}` : 'tudo'} de volta ao padrão da dissertação`);
    return riskParams.view(ws, area || null);
  });
  h('risk:previa', (area, tag) => riskParams.previa(requireWs(), area, tag));

  // Pontos de interesse: conjuntos (dissertação, OpenStreetMap, arquivo próprio)
  h('pois:list', () => poiSets.list(requireWs()));
  h('pois:catalog', () => poiSets.catalogo());
  h('pois:detail', (id) => poiSets.detail(requireWs(), String(id || '')));
  h('pois:preview', (id, area) => poiSets.preview(requireWs(), String(id || ''), String(area || '')));
  h('pois:activate', (id) => {
    const r = poiSets.activate(requireWs(), String(id || ''));
    log.info('pontos de interesse', `conjunto ativo: ${r.ativo}${r.apareceram.length ? ` · categorias novas: ${r.apareceram.length}` : ''}${r.sumiram.length ? ` · categorias que sumiram: ${r.sumiram.length}` : ''}`);
    return r;
  });
  h('pois:save', (id, nome) => { const r = poiSets.save(requireWs(), String(id || ''), nome); log.ok('pontos de interesse', `conjunto ${id} salvo`); return r; });
  h('pois:remove', (id) => { const r = poiSets.remove(requireWs(), String(id || '')); log.warn('pontos de interesse', `conjunto ${id} movido para ${path.relative(requireWs(), r.pasta)}`); return r; });
  const inspectPoi = async (p) => {
    const st = pythonEnv.status || await pythonEnv.check();
    if (!st.jobs?.pois) throw new Error('O Python do app ainda não tem os pacotes de mapa. Abra a tela Ambiente e use "Preparar ambiente".');
    const r = await poiSets.inspect(requireWs(), p, { python: pythonEnv.pythonPath(), repoRoot: paths.REPO_ROOT });
    log.info('pontos de interesse', `${r.original}: ${r.n} ponto(s), ${r.campos.length} campo(s)`);
    return r;
  };
  h('pois:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Arquivo com pontos de interesse', properties: ['openFile'],
      filters: [{ name: 'Pontos (GeoJSON, KML, Shapefile .zip, GeoPackage, CSV)', extensions: poiSets.EXTS }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return inspectPoi(r.filePaths[0]);
  });
  h('pois:inspectPath', (p) => inspectPoi(String(p || '')));

  // Padrão da dissertação: o que está diferente em cada tela e "restaurar tudo"
  h('defaults:summary', () => defaultsSummary(requireWs()));
  h('defaults:restoreAll', () => {
    const ws = requireWs();
    const antes = defaultsSummary(ws);
    sspProfile.writeParams(ws, sspProfile.DEFAULTS);
    sspProfile.writeFilter(ws, sspProfile.FILTER_DEFAULTS);
    sspProfile.writeDataset(ws, sspProfile.DATASET_DEFAULTS);
    modelParams.reset(ws, null);
    riskParams.reset(ws, null);
    log.warn('configurações', `tudo de volta ao padrão da dissertação${antes.itens.length ? `: ${antes.itens.map((i) => i.tela).join(', ')}` : ''}`);
    return defaultsSummary(ws);
  });

  // Modo científico: exportar os resultados do replay para o artigo
  h('replay:export', async () => {
    const ws = requireWs();
    const r = await replayExport.exportar(ws, { repoRoot: paths.REPO_ROOT, seqDir: path.join(ws, 'runs', '_sequencias'), appVersion: app.getVersion() });
    log.ok('modo científico', `resultados exportados: ${r.arquivo} (${r.n} arquivos)`);
    shell.showItemInFolder(r.arquivo);
    return r;
  });
  h('replay:results', () => cycle.replayResults(requireWs()));

  // Fundo do mapa: chave da CARTO (basemaps.cartocdn.com)
  h('basemap:get', () => basemap.view());
  h('basemap:set', async (o) => {
    const v = basemap.set(o || {});
    log.info('fundo do mapa', v.temChave ? `chave da CARTO salva (…${v.final}) · estilo ${v.estilos[v.estilo]}` : 'sem chave: o mapa usa as ruas da área');
    await mapServer.restart();
    return v;
  });
  h('basemap:test', () => basemap.test());
  h('basemap:openKeyPage', async (which) => { await shell.openExternal(which === 'termos' ? basemap.view().paginaTermos : basemap.view().paginaChave); return true; });
  h('run:status', () => runs.status());
  h('run:list', (job, limit) => runs.list(requireWs(), { job, limit }));
  h('run:get', (runId) => {
    if (!/^[\w-]+$/.test(runId || '')) throw new Error('Execução inválida.');
    const dir = path.join(requireWs(), 'runs', runId);
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
    return { manifest: read('manifest.json'), job: read('job.json') };
  });
  h('run:verify', async (runId) => {
    const r = await runs.verify(requireWs(), runId);
    log[r.ok ? 'ok' : 'warn']('verificação', `${runId}: ${r.ok ? 'saídas íntegras' : r.files.filter((f) => f.state !== 'ok').map((f) => `${f.path} (${f.state === 'missing' ? 'sumiu' : 'mudou'})`).join(', ')}`);
    return r;
  });
  h('run:open', async (runId) => {
    if (!/^[\w-]+$/.test(runId || '')) throw new Error('Execução inválida.');
    const err = await shell.openPath(path.join(requireWs(), 'runs', runId));
    if (err) throw new Error(err);
    return true;
  });

  h('env:hardware', async () => {
    const info = await hardware.collect({ workspace: dataDir() });
    lastHardware = info;
    log.info('ambiente', `CPU: ${info.cpu.model} (${info.cpu.threads} threads) · RAM ${info.ram.totalGb} GB · GPU: ${info.gpus.map((g) => g.name).join(' | ') || 'nenhuma identificada'} · perfil: ${info.verdict.title}`);
    return info;
  });

  h('publish:geojsonList', () => geojsonExport.available(requireWs()));
  h('publish:exportGeojson', async (opts) => {
    // Sem perguntar: <pasta de trabalho>/publish/geojson/AAAA-MM
    const ws = requireWs();
    const tag = String(opts?.tag || '');
    if (!/^\d{4}_\d{2}$/.test(tag)) throw new Error('Mês inválido.');
    const out = geojsonExport.exportGeojson(ws, { ...opts, dest: path.join(ws, 'publish', 'geojson', tag.replace('_', '-')) });
    log.ok('publicação', `${out.written.length} GeoJSON exportado(s) em ${out.dest}`);
    shell.openPath(out.dest);
    return out;
  });

  h('map:start', async () => {
    const st = await mapServer.start(path.join(requireWs(), 'processed'));
    return { ...st, theme: resolvedTheme() };
  });
  h('map:stop', () => mapServer.stop());
  h('map:status', () => mapServer.status());
  h('map:openExternal', async () => {
    const st = await mapServer.start(path.join(requireWs(), 'processed'));
    await shell.openExternal(st.url);
    return true;
  });

  // Pacote para servidor Node: montar + verificar, pré-visualizar, exportar, histórico
  const pubRef = (r) => (r && typeof r === 'object' ? { staged: r.staged ? String(r.staged) : undefined, name: r.name ? String(r.name) : undefined } : null);
  h('publish:options', () => { const ws = requireWs(); return publisher.options(ws, forecast.info(ws)); });
  h('publish:build', async (opts) => {
    const ws = requireWs();
    if (runs.status()) throw new Error('Espere a execução em andamento terminar.');
    const ps = powerSaveBlocker.start('prevent-app-suspension');
    const fundo = opts?.fundoCarto ? basemap.forServer() : null;
    if (opts?.fundoCarto && fundo.provedor !== 'carto') throw new Error('Não há chave da CARTO salva. Adicione a chave na tela Previsão ou escolha o fundo com as ruas da área.');
    try { return await publisher.build(ws, opts || {}, (ev) => send('publish:event', ev), fundo); } finally { powerSaveBlocker.stop(ps); }
  });
  h('publish:cancel', () => publisher.cancel());
  h('publish:verify', (ref) => publisher.verify(requireWs(), pubRef(ref), (ev) => send('publish:event', ev)));
  h('publish:preview', async (ref) => publisher.startPreview(requireWs(), pubRef(ref)));
  h('publish:previewStop', () => publisher.stopPreview());
  h('publish:previewExternal', async () => {
    const u = publisher.preview?.server?.url();
    if (!u) throw new Error('A pré-visualização não está aberta.');
    await shell.openExternal(u);
    return true;
  });
  h('publish:export', (id, o) => publisher.exportPackage(requireWs(), String(id || ''), { zip: o?.zip !== false }, (ev) => send('publish:event', ev)));
  h('publish:history', () => publisher.history(requireWs()));
  h('publish:latestStaged', () => publisher.latestStaged(requireWs()));
  h('publish:openDir', async (ref) => {
    const ws = requireWs();
    const dir = ref ? publisher.resolve(ws, pubRef(ref)) : publisher.dirs(ws).pacotes;
    fs.mkdirSync(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });

  h('logs:recent', (n, min) => log.recent(n || 500, min || 'debug'));
  h('logs:openDir', () => shell.openPath(paths.logsDir()));
  h('logs:fromRenderer', (level, scope, msg) => {
    const lv = ['debug', 'info', 'ok', 'warn', 'error'].includes(level) ? level : 'info';
    log[lv]('interface:' + String(scope).slice(0, 40), String(msg).slice(0, 4000));
    return true;
  });

  log.onEntry((e) => send('log:entry', e));
  nativeTheme.on('updated', () => send('theme:changed', resolvedTheme()));
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(process.argv.includes('--dev') ? Menu.getApplicationMenu() : null);
  nativeTheme.themeSource = settings.get().theme || 'system';
  registerIpc();
  createWindow();
  log.info('app', `Pre-Crime Studio ${app.getVersion()} · Electron ${process.versions.electron} · pasta de trabalho: ${dataDir() || '(ainda não escolhida)'}`);
  // Garante a estrutura a cada abertura (alguém pode ter apagado uma subpasta)
  // Recria o que faltar (alguém pode ter apagado uma subpasta). Pastas das etapas só
  // depois que houver planilhas importadas.
  const ws = dataDir();
  if (ws) {
    workspace.ensure(ws, { baseDir: paths.BASE_DIR })
      .then(() => (workspace.stagesReady(ws) || workspace.hasSpreadsheets(ws) ? ensureStages(ws) : null))
      .catch((e) => log.error('workspace', e));
  }
  metricsTimer = setInterval(() => send('sys:metrics', sysMetrics.collect()), 2000);
  // Verifica o Python em segundo plano (importar os pacotes leva alguns segundos)
  pythonEnv.check().then((st) => {
    log.info('ambiente', st.state === 'ready' ? `Python ${st.python.version} pronto (${st.python.origin === 'app' ? 'ambiente do app' : st.python.path})`
      : st.state === 'missing' ? 'Python do pipeline ainda não preparado' : `Python incompleto: falta ${st.missing.join(', ')}`);
    send('env:python', st);
  }).catch((e) => log.error('ambiente', e));
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { clearInterval(metricsTimer); seq?.cancel(); mapServer.stop(); publisher.stopPreview(); publisher.cancel(); runs.cancel(); pythonEnv.cancelInstall(); });
