// Ambiente Python do pipeline: encontrar, verificar e instalar.
//
// O app usa, nesta ordem:
//   1. o ambiente que ele mesmo prepara (venv em <dados locais>/PreCrimeStudio/venv);
//   2. um Python escolhido pelo operador ("Usar um Python que já tenho").
// "Preparar ambiente" faz tudo sozinho com o uv (gerenciador de pacotes da Astral):
//   baixa o uv → Python 3.12 → cria o venv → pacotes do requirements.txt → PyTorch
//   (CUDA se houver placa NVIDIA, senão CPU) → confere.
// Nada é instalado no Python do sistema.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Readable } = require('stream');
const { pipeline: streamPipeline } = require('stream/promises');
const { startLines, killTree, capture, isWin } = require('./proc');

const PY_VERSION = '3.12';
// Versões fixas para os resultados serem reprodutíveis (as do ambiente da dissertação).
// Para trocar: atualize aqui e em requirements.lock depois de rodar os testes de aceite.
const UV_VERSION = '0.13.0';
const TORCH_VERSION = '2.14.1';

// Pacotes que cada fase precisa (as demais fases entram junto com as telas delas).
const JOB_REQS = {
  clean: ['pandas', 'numpy', 'openpyxl', 'psutil'],
  filter: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyproj', 'pyogrio', 'psutil'],
  features: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyogrio', 'psutil'],
  train: ['pandas', 'numpy', 'scikit-learn', 'joblib', 'psutil'],   // o PyTorch é exigido só para LSTM e Transformer
  predict: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyogrio', 'scikit-learn', 'joblib', 'psutil'],
  validate: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyogrio', 'scikit-learn', 'matplotlib', 'seaborn', 'psutil'],
  areas: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyproj', 'pyogrio', 'psutil'],   // osmnx é opcional (ruas e POIs)
  ensemble: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyogrio', 'scikit-learn', 'psutil'],
  science: ['pandas', 'numpy', 'scipy', 'pyogrio', 'psutil'],
  pois: ['pandas', 'numpy', 'geopandas', 'shapely', 'pyproj', 'pyogrio', 'psutil'],   // osmnx só para baixar do OpenStreetMap
};

function rootDir(userData) {
  if (isWin && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'PreCrimeStudio');
  return path.join(userData, 'runtime');
}

class PythonEnv {
  constructor({ repoRoot, userData, settings, log, hardware }) {
    this.repoRoot = repoRoot;
    this.root = rootDir(userData);
    this.settings = settings;
    this.log = log;
    this.hardware = hardware;
    this.status = null;          // último resultado de check()
    this.installing = null;      // { child, cancelled }
    this.requirements = readRequirements(path.join(repoRoot, 'requirements.txt'));
  }

  get dirs() {
    return {
      root: this.root,
      tools: path.join(this.root, 'tools'),
      pythons: path.join(this.root, 'python'),
      cache: path.join(this.root, 'cache'),
      venv: path.join(this.root, 'venv'),
    };
  }
  venvPython() { return path.join(this.dirs.venv, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python'); }
  allPackages() { return [...this.requirements, 'torch']; }

  /** Python que as execuções vão usar (ou null). */
  pythonPath() {
    if (fs.existsSync(this.venvPython())) return this.venvPython();
    const chosen = this.settings.get().pythonPath;
    return chosen && fs.existsSync(chosen) ? chosen : null;
  }

  async probe(py) {
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' };
    const r = await capture(py, ['-m', 'pipeline.bridge.env_probe', ...this.allPackages()], { cwd: this.repoRoot, env, timeout: 180000 });
    if (!r) return null;
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('@@ENV '));
    try { return line ? JSON.parse(line.slice(6)) : null; } catch { return null; }
  }

  /** Verifica o Python em uso e os pacotes. */
  async check() {
    const py = this.pythonPath();
    const base = { root: this.root, checkedAt: Date.now(), requirements: this.allPackages() };
    if (!py) {
      this.status = { ...base, state: 'missing', python: null, packages: {}, missing: this.allPackages(), jobs: jobsOk({}) };
      return this.status;
    }
    const origin = py === this.venvPython() ? 'app' : 'escolhido';
    const p = await this.probe(py);
    if (!p) {
      this.status = { ...base, state: 'broken', python: { path: py, origin }, packages: {}, missing: this.allPackages(), jobs: jobsOk({}),
        message: 'Não consegui rodar este Python. Ele pode ter sido removido ou estar corrompido.' };
      return this.status;
    }
    const missing = this.allPackages().filter((n) => !p.packages[n]?.ok);
    const okVersion = /^3\.(1[0-3])\./.test(p.python + '.');
    // versões diferentes das fixadas (requirements.lock e TORCH_VERSION): os resultados podem mudar
    const lock = readLock(path.join(this.repoRoot, 'requirements.lock'));
    lock.torch = TORCH_VERSION;
    const foraDoLock = Object.entries(p.packages).filter(([n, v]) => v.ok && lock[n] && String(v.version).split('+')[0] !== lock[n])
      .map(([n, v]) => ({ pacote: n, instalado: v.version, fixado: lock[n] }));
    this.status = {
      ...base, versoesFixas: { arquivo: Object.keys(lock).length > 1 ? 'requirements.lock' : null, uv: UV_VERSION, torch: TORCH_VERSION, python: PY_VERSION }, foraDoLock,
      state: missing.length || !okVersion ? 'partial' : 'ready',
      python: { path: py, origin, version: p.python, isVenv: p.is_venv, bits: p.bits, okVersion },
      packages: p.packages, missing, torch: p.torch || null, jobs: jobsOk(p.packages),
    };
    return this.status;
  }

  /** Verifica um Python escolhido pelo operador e, se rodar, passa a usá-lo. */
  async useExisting(py) {
    const p = await this.probe(py);
    if (!p) throw new Error('Este arquivo não parece ser um Python que funcione.');
    this.settings.set({ pythonPath: py });
    return this.check();
  }

  // ── instalação ────────────────────────────────────────────────────────────
  /**
   * opts: { torch: 'auto'|'cuda'|'cpu', reinstall: bool }
   * onEvent({ t:'step', id, state, msg } | { t:'line', text, level } | { t:'download', bytes, total })
   */
  async install(opts = {}, onEvent = () => {}) {
    if (this.installing) throw new Error('A preparação do ambiente já está em andamento.');
    const d = this.dirs;
    for (const k of ['root', 'tools', 'pythons', 'cache']) fs.mkdirSync(d[k], { recursive: true });
    this.installing = { child: null, cancelled: false };
    const step = (id, state, msg = '') => { onEvent({ t: 'step', id, state, msg }); if (msg) this.log[state === 'error' ? 'error' : state === 'done' ? 'ok' : 'info']('ambiente', msg); };
    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: d.pythons, UV_CACHE_DIR: d.cache, UV_NATIVE_TLS: '1',
      UV_PYTHON_PREFERENCE: 'managed', UV_NO_PROGRESS: '1',
      NO_COLOR: '1', PYTHONIOENCODING: 'utf-8',
    };
    delete env.VIRTUAL_ENV; delete env.PYTHONHOME; delete env.PYTHONPATH;
    const run = async (cmd, args) => {
      if (this.installing.cancelled) throw new Error('cancelado');
      onEvent({ t: 'line', text: `> ${path.basename(cmd)} ${args.join(' ')}`, level: 'debug' });
      const { child, done } = startLines(cmd, args, { cwd: d.root, env, onLine: (text) => onEvent({ t: 'line', text, level: classify(text) }) });
      this.installing.child = child;
      const code = await done;
      this.installing.child = null;
      if (this.installing.cancelled) throw new Error('cancelado');
      return code;
    };
    const t0 = Date.now();
    try {
      // 1. uv
      step('uv', 'running', 'Procurando o instalador (uv)…');
      const uv = await this.ensureUv(env, onEvent);
      step('uv', 'done', `Instalador pronto: ${uv}`);

      // 2. Python 3.12
      step('python', 'running', `Procurando o Python ${PY_VERSION}…`);
      let found = await capture(uv, ['python', 'find', PY_VERSION], { env, timeout: 30000 });
      if (!found) {
        step('python', 'running', `Baixando o Python ${PY_VERSION} (cerca de 30 MB)…`);
        const code = await run(uv, ['python', 'install', PY_VERSION]);
        if (code !== 0) throw new Error(`Não consegui instalar o Python ${PY_VERSION}.`);
        found = await capture(uv, ['python', 'find', PY_VERSION], { env, timeout: 30000 });
      }
      step('python', 'done', `Python ${PY_VERSION}: ${(found?.stdout || '').trim() || 'instalado'}`);

      // 3. ambiente isolado (venv)
      const vpy = this.venvPython();
      if (opts.reinstall || !fs.existsSync(vpy)) {
        step('venv', 'running', 'Criando o ambiente isolado do app…');
        const code = await run(uv, ['venv', d.venv, '--python', PY_VERSION, '--clear']);
        if (code !== 0 || !fs.existsSync(vpy)) throw new Error('Não consegui criar o ambiente isolado.');
        step('venv', 'done', `Ambiente criado em ${d.venv}`);
      } else step('venv', 'skipped', 'O ambiente isolado já existe.');

      // 4. pacotes científicos
      if (opts.onlyTorch && fs.existsSync(vpy)) step('packages', 'skipped', 'Pacotes científicos mantidos (só o PyTorch será trocado).');
      else {
      // versões exatas (requirements.lock); sem o arquivo, as dependências diretas (requirements.txt)
      const lock = path.join(this.repoRoot, 'requirements.lock');
      const reqFile = fs.existsSync(lock) ? lock : path.join(this.repoRoot, 'requirements.txt');
      step('packages', 'running', `Instalando os pacotes científicos (pandas, geopandas, scikit-learn…)${reqFile === lock ? ' nas versões fixas do app' : ''}. Pode levar alguns minutos.`);
      let code = await run(uv, ['pip', 'install', '--python', vpy, '-r', reqFile]);
      if (code !== 0) throw new Error('A instalação dos pacotes falhou. Veja as linhas acima.');
      step('packages', 'done', 'Pacotes científicos instalados.');
      }

      // 5. PyTorch
      if (opts.torch === 'skip') step('torch', 'skipped', 'PyTorch não instalado nesta vez.');
      else {
        const indexes = await this.torchIndexes(opts.torch || 'auto');
        let ok = false;
        // primeiro a versão fixa (TORCH_VERSION) em cada índice; se nenhum tiver, a mais recente, com aviso
        for (const spec of [`torch==${TORCH_VERSION}`, 'torch']) {
          for (const idx of indexes) {
            step('torch', 'running', idx.cuda
              ? `Instalando o PyTorch ${spec === 'torch' ? '' : TORCH_VERSION + ' '}para placa de vídeo (${idx.label}, cerca de 2,5 GB)…`
              : `Instalando o PyTorch ${spec === 'torch' ? '' : TORCH_VERSION + ' '}para processador (cerca de 250 MB)…`);
            const code = await run(uv, ['pip', 'install', '--python', vpy, '--reinstall-package', 'torch', spec, '--index-url', idx.url]);
            if (code === 0) {
              ok = true;
              const fellBack = !idx.cuda && indexes.some((i) => i.cuda);
              step('torch', 'done', (fellBack
                ? 'PyTorch instalado só para o processador: a versão para placa de vídeo não instalou (veja os detalhes).'
                : `PyTorch instalado (${idx.label}).`) + (spec === 'torch' ? ` ATENÇÃO: a versão ${TORCH_VERSION} não estava disponível; os resultados podem diferir um pouco dos da dissertação.` : ''));
              break;
            }
            onEvent({ t: 'line', text: `[AVISO] Não deu certo com ${idx.label}; tentando a próxima opção.`, level: 'warn' });
          }
          if (ok) break;
        }
        if (!ok) throw new Error('Não consegui instalar o PyTorch.');
      }

      // 6. conferência
      step('check', 'running', 'Conferindo o ambiente…');
      this.settings.set({ pythonPath: null });
      const st = await this.check();
      if (st.state !== 'ready' && !(opts.torch === 'skip' && st.missing.every((m) => m === 'torch'))) {
        throw new Error(`Ainda falta: ${st.missing.join(', ')}`);
      }
      const cuda = st.torch?.cuda_available ? ` · placa de vídeo: ${st.torch.device}`
        : st.torch?.built_cuda ? ' · ATENÇÃO: o PyTorch é para placa de vídeo, mas não conseguiu usá-la (atualize o driver da NVIDIA)' : '';
      step('check', 'done', `Ambiente pronto em ${fmtSecs((Date.now() - t0) / 1000)} · Python ${st.python.version}${cuda}`);
      onEvent({ t: 'finished', state: st.state });
      return st;
    } catch (e) {
      const cancelled = this.installing?.cancelled;
      onEvent({ t: 'failed', cancelled, msg: cancelled ? 'Preparação cancelada.' : e.message });
      this.log[cancelled ? 'warn' : 'error']('ambiente', cancelled ? 'preparação do ambiente cancelada' : e.message);
      throw new Error(cancelled ? 'Preparação cancelada.' : e.message);
    } finally {
      this.installing = null;
    }
  }

  cancelInstall() {
    if (!this.installing) return false;
    this.installing.cancelled = true;
    killTree(this.installing.child);
    this.installing.abort?.abort();
    return true;
  }

  async ensureUv(env, onEvent) {
    const exe = isWin ? 'uv.exe' : 'uv';
    const dir = path.join(this.dirs.tools, `uv-${UV_VERSION}`);
    const local = path.join(dir, exe);
    if (fs.existsSync(local)) return local;
    // uv baixado por versões anteriores do app (tools/uv.exe): serve se for a mesma versão
    const legacy = path.join(this.dirs.tools, exe);
    if (fs.existsSync(legacy) && (await uvVersion(legacy, env)) === UV_VERSION) return legacy;
    try {
      await this.downloadUv(dir, env, onEvent);
      return local;
    } catch (e) {
      if (this.installing?.cancelled) throw e;
      // sem internet para o GitHub: um uv que já esteja no computador ainda serve, com aviso
      for (const cand of [legacy, 'uv']) {
        const v = cand === 'uv' || fs.existsSync(cand) ? await uvVersion(cand, env) : null;
        if (v) {
          onEvent({ t: 'line', text: `[AVISO] Não consegui baixar o uv ${UV_VERSION} (${e.message}). Usando o uv ${v} que já está no computador.`, level: 'warn' });
          return cand;
        }
      }
      throw e;
    }
  }

  async downloadUv(dir, env, onEvent) {
    const exe = isWin ? 'uv.exe' : 'uv';
    const asset = uvAsset();
    if (!asset) throw new Error(`Sistema não suportado para instalar o uv: ${process.platform}/${process.arch}`);
    fs.mkdirSync(dir, { recursive: true });
    const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`;
    const file = path.join(dir, asset);
    onEvent({ t: 'line', text: `Baixando ${url}`, level: 'info' });
    const ac = new AbortController();
    this.installing.abort = ac;
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`Não consegui baixar o uv (HTTP ${res.status}). Confira a conexão com a internet.`);
    const total = Number(res.headers.get('content-length')) || 0;
    let bytes = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (c) => { bytes += c.length; onEvent({ t: 'download', bytes, total }); });
    await streamPipeline(body, fs.createWriteStream(file));
    // extrai: o tar do próprio Windows 10/11 (System32) também abre .zip; o tar do Git não
    const tar = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const ex = await capture(tar, ['-xf', file, '-C', dir], { timeout: 60000 });
    if (!ex) throw new Error('Não consegui extrair o uv.');
    // o .tar.gz traz uma pasta; o .zip traz o executável solto
    const inner = fs.readdirSync(dir).map((n) => path.join(dir, n))
      .find((p) => fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, exe)));
    if (inner) fs.copyFileSync(path.join(inner, exe), path.join(dir, exe));
    if (!isWin) fs.chmodSync(path.join(dir, exe), 0o755);
    try { fs.unlinkSync(file); } catch { /* fica */ }
    if (!fs.existsSync(path.join(dir, exe))) throw new Error('O uv não apareceu depois de extraído.');
  }

  /** Índices do PyTorch a tentar, do melhor para o mais compatível. */
  async torchIndexes(choice) {
    const cpu = { url: 'https://download.pytorch.org/whl/cpu', label: 'CPU', cuda: false };
    if (choice === 'cpu') return [cpu];
    const hw = await this.hardware.collect({ fresh: true });
    const nv = hw.gpus.find((g) => g.vendor === 'NVIDIA' && g.source === 'nvidia-smi');
    const all = [['cu130', 13.0], ['cu129', 12.9], ['cu128', 12.8], ['cu126', 12.6], ['cu124', 12.4], ['cu118', 11.8]];
    if (!nv) return choice === 'cuda' ? [...all.slice(2).map(([k]) => mk(k)), cpu] : [cpu];
    // O driver precisa suportar a versão do CUDA do pacote. Sem a versão (nvidia-smi que não
    // informa), tenta as versões mais comuns: o uv falha rápido quando não há pacote compatível.
    const drv = parseFloat(nv.cuda || '0');
    const list = (drv ? all.filter(([, v]) => drv >= v) : all.slice(2)).map(([k]) => mk(k));
    return [...list, cpu];
    function mk(k) { return { url: `https://download.pytorch.org/whl/${k}`, label: `CUDA ${k.slice(2, 4)}.${k.slice(4)}`, cuda: true }; }
  }
}

async function uvVersion(cmd, env) {
  const r = await capture(cmd, ['--version'], { env, timeout: 10000 });
  const m = r?.stdout?.match(/uv (\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function uvAsset() {
  const a = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!a) return null;
  if (process.platform === 'win32') return `uv-${a}-pc-windows-msvc.zip`;
  if (process.platform === 'darwin') return `uv-${a}-apple-darwin.tar.gz`;
  if (process.platform === 'linux') return `uv-${a}-unknown-linux-gnu.tar.gz`;
  return null;
}

function readRequirements(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
      .map((l) => l.split(/[<>=!~;\[ ]/)[0].trim().toLowerCase()).filter(Boolean);
  } catch { return ['numpy', 'pandas', 'openpyxl', 'psutil']; }
}

/** requirements.lock → { pacote: versão } (nomes em minúsculas, como no requirements.txt). */
function readLock(file) {
  const out = {};
  try {
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = l.replace(/#.*/, '').match(/^\s*([A-Za-z0-9_.-]+)==([^\s;]+)/);
      if (m) out[m[1].toLowerCase()] = m[2];
    }
  } catch { /* sem lock */ }
  return out;
}

function jobsOk(packages) {
  return Object.fromEntries(Object.entries(JOB_REQS).map(([job, reqs]) => [job, reqs.every((r) => packages[r]?.ok)]));
}

function classify(text) {
  if (/\b(error|erro|failed|falha)\b/i.test(text)) return 'error';
  if (/\b(warn|warning|aviso)\b/i.test(text)) return 'warn';
  if (/^\s*\+ |Installed \d+|Prepared \d+|Downloaded/i.test(text)) return 'ok';
  return 'info';
}
const fmtSecs = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

module.exports = { PythonEnv, JOB_REQS, UV_VERSION, TORCH_VERSION, PY_VERSION };
