// Execuções do pipeline: inicia uma fase no Python do app, lê os eventos @@PC, guarda o
// registro da execução e permite cancelar.
//
// <pasta de trabalho>/runs/<AAAA-MM-DD_HHMMSS>_<fase>/
//   job.json       o que foi pedido (fase, parâmetros, Python)
//   events.jsonl   todos os eventos @@PC, na ordem
//   run.log        log completo, UTF-8
//   manifest.json  o que aconteceu: tempos, entradas e saídas com sha256, métricas, erro
// "Verificar" recalcula o sha256 das saídas e diz se alguma mudou depois da execução.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startLines, killTree } = require('./proc');

const LABELS = { clean: 'Limpeza', filter: 'Filtragem', features: 'Features', train: 'Treino', predict: 'Previsão', validate: 'Validação', areas: 'Áreas', ensemble: 'Ensemble', science: 'Métricas científicas', pois: 'Pontos de interesse' };

function sha256(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', () => resolve(null));
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Nível de uma linha comum do pipeline (seção 4.3 do plano). */
function levelOf(text) {
  if (/\[ERRO|Traceback|Error:|Exception/.test(text)) return 'error';
  if (/\[AVISO\]|\[PERIGO\]|Warning:|WARNING/.test(text)) return 'warn';
  if (/\[SUCESSO\]|✅/.test(text)) return 'ok';
  return 'info';
}

class RunManager {
  constructor({ log, repoRoot, appInfo, send }) {
    this.log = log;
    this.repoRoot = repoRoot;
    this.appInfo = appInfo;
    this.send = send;
    this.current = null;
  }

  /** Promessa que resolve quando a execução termina: { status, manifest }. */
  waitEnd(runId) {
    if (!this.waiters) this.waiters = new Map();
    return new Promise((resolve) => this.waiters.set(runId, resolve));
  }

  status() {
    const c = this.current;
    return c ? { runId: c.runId, job: c.job, label: c.label, area: c.area, startedAt: c.startedAt, progress: c.progress, stage: c.stage, metrics: c.metrics } : null;
  }

  /**
   * job: 'clean' | 'filter' | 'features'
   * ctx: { ws, python, pythonStatus, overrides, area?, inputs: [{path, sha256?}] }
   */
  async start(job, ctx) {
    if (this.current) throw new Error(`Já existe uma execução em andamento: ${this.current.label}.`);
    if (!LABELS[job]) throw new Error(`Fase desconhecida: ${job}`);
    const startedAt = Date.now();
    const runId = `${stamp(new Date(startedAt))}_${job}`;
    const dir = path.join(ctx.ws, 'runs', runId);
    fs.mkdirSync(dir, { recursive: true });
    const label = LABELS[job];
    const pyInfo = ctx.pythonStatus?.python || { path: ctx.python };
    const jobInfo = {
      runId, job, label, requestedAt: new Date(startedAt).toISOString(),
      workspace: ctx.ws, area: ctx.area || null, options: ctx.options || {}, overrides: ctx.overrides,
      python: { path: ctx.python, version: pyInfo.version || null },
    };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(jobInfo, null, 2), 'utf8');

    const logStream = fs.createWriteStream(path.join(dir, 'run.log'), { flags: 'a', encoding: 'utf8' });
    const evStream = fs.createWriteStream(path.join(dir, 'events.jsonl'), { flags: 'a', encoding: 'utf8' });
    const run = {
      runId, job, label, dir, startedAt, ctx, area: ctx.area || null, progress: null, stage: null,
      metrics: {}, stages: [], artifacts: [], error: null, cancelled: false, lines: [], tail: [],
    };
    this.current = run;

    const emit = (payload) => this.send('run:event', { runId, job, ...payload });
    let batch = [];
    const flush = () => { if (batch.length) { emit({ t: 'lines', lines: batch }); batch = []; } };
    const flushTimer = setInterval(flush, 150);

    const onLine = (text, src) => {
      const ts = Date.now();
      if (text.startsWith('@@PC ')) {
        evStream.write(text.slice(5) + '\n');
        let ev; try { ev = JSON.parse(text.slice(5)); } catch { return; }
        this.onEvent(run, ev, emit);
        return;
      }
      // barras de progresso (tqdm) repetidas: guarda só no arquivo
      const level = src === 'err' && levelOf(text) === 'info' ? 'warn' : levelOf(text);
      logStream.write(`${new Date(ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`);
      if (/\d+%\|/.test(text) && !/100%\|/.test(text)) return;
      const entry = { ts, level, text };
      run.tail.push(entry); if (run.tail.length > 400) run.tail.shift();
      batch.push(entry);
      if (level !== 'debug') this.log[level === 'ok' ? 'ok' : level]('pipeline:' + job, text);
    };

    const env = {
      ...process.env,
      PRECRIME_DATA_DIR: ctx.ws,
      PRECRIME_CONFIG_OVERRIDES: JSON.stringify(ctx.overrides || {}),
      PRECRIME_EVENTS: '1',
      PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1',
    };
    delete env.PYTHONHOME; delete env.PYTHONPATH;
    this.log.info('execução', `${label}: iniciando (${runId})`);
    emit({ t: 'start', label, startedAt, dir, area: ctx.area || null });
    const args = ['-u', '-m', 'pipeline.bridge.run', job, ...(ctx.area ? ['--area', ctx.area] : []), ...(ctx.extraArgs || [])];
    const { child, done } = startLines(ctx.python, args, { cwd: this.repoRoot, env, onLine });
    run.child = child;

    done.then(async (code) => {
      clearInterval(flushTimer);
      flush();
      const endedAt = Date.now();
      const ok = code === 0 && !run.cancelled;
      const status = run.cancelled ? 'cancelled' : ok ? 'ok' : 'error';
      const manifest = await this.buildManifest(run, { code, endedAt, status });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      logStream.end(); evStream.end();
      this.current = null;
      const secs = (endedAt - startedAt) / 1000;
      if (status === 'ok') this.log.ok('execução', `${label} concluída em ${fmtSecs(secs)}`);
      else if (status === 'cancelled') this.log.warn('execução', `${label} cancelada depois de ${fmtSecs(secs)}`);
      else this.log.error('execução', `${label} falhou (código ${code})${run.error?.msg ? ': ' + run.error.msg : ''}`);
      emit({ t: 'end', status, code, secs, manifest });
      const w = this.waiters?.get(runId);
      if (w) { this.waiters.delete(runId); w({ status, manifest }); }
    });
    return { runId, dir, startedAt, label };
  }

  onEvent(run, ev, emit) {
    switch (ev.t) {
      case 'stage':
        if (ev.status === 'start') run.stage = ev.label || ev.id;
        else run.stages.push({ id: ev.id, ok: ev.ok, secs: ev.secs, rss_mb: ev.rss_mb, cpu_secs: ev.cpu_secs });
        break;
      case 'progress':
        run.progress = { done: ev.done, total: ev.total, etapa: ev.etapa || null, arquivo: ev.arquivo || null,
          area: ev.area || null, modelo: ev.modelo || null, sub: ev.sub ?? null, subtotal: ev.subtotal ?? null };
        break;
      case 'train':
        run.metrics.train = run.metrics.train || {};
        if (ev.status === 'end') (run.metrics.train[`${ev.model}|${ev.area}`] = { model: ev.model, area: ev.area, secs: ev.secs, linhas: ev.linhas, positivos: ev.positivos });
        break;
      case 'plan':
        { const { v, t, ts, ...plan } = ev; run.metrics.plan = plan; }
        break;
      case 'metric':
        if (ev.t === 'metric' && ev.id === 'train') {
          // curva de perda e AUC por dobra: guarda compacto por modelo × área
          const k = `${ev.model}|${ev.area}`;
          run.metrics.curves = run.metrics.curves || {};
          const c = (run.metrics.curves[k] = run.metrics.curves[k] || { loss: [], auc: [] });
          if (ev.key === 'loss' && ev.fase === 'final') c.loss.push(ev.value);
          if (ev.key === 'auc_fold') c.auc.push(ev.value);
          // replay sem vazamento: última semana usada no treino de cada área
          if (ev.key === 'ultima_semana_treino') (run.metrics.semanaTreino = run.metrics.semanaTreino || {})[ev.area] = { semana: ev.value, data_end: ev.data_end };
          break;
        }
        if (ev.area) {
          run.metrics.areas = run.metrics.areas || {};
          const a = (run.metrics.areas[ev.area] = run.metrics.areas[ev.area] || {});
          // métricas por modelo (Validação): área → chave → modelo
          if (ev.model) (a[ev.key] = (a[ev.key] && typeof a[ev.key] === 'object' && !Array.isArray(a[ev.key]) ? a[ev.key] : {}))[ev.model] = ev.value;
          else a[ev.key] = ev.value;
        } else run.metrics[ev.key] = ev.value;
        break;
      case 'artifact':
        run.artifacts.push({ path: ev.path, kind: ev.kind || '' });
        break;
      case 'error':
        run.error = { kind: ev.kind, msg: ev.msg, hint: ev.hint || null };
        break;
      default:
    }
    emit({ t: 'event', ev });
  }

  async buildManifest(run, { code, endedAt, status }) {
    const rel = (p) => path.relative(run.ctx.ws, p).split(path.sep).join('/');
    const inputs = [];
    for (const i of run.ctx.inputs || []) {
      let st = null; try { st = fs.statSync(i.path); } catch { /* sumiu */ }
      inputs.push({ path: rel(i.path), bytes: st?.size ?? null, mtime: st ? new Date(st.mtimeMs).toISOString() : null,
        sha256: i.sha256 || (st && !i.skipHash ? await sha256(i.path) : null) });
    }
    const outputs = [];
    if (status === 'ok') {
      for (const a of run.artifacts) {
        let st = null; try { st = fs.statSync(a.path); } catch { continue; }
        outputs.push({ path: rel(a.path), kind: a.kind, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), sha256: await sha256(a.path) });
      }
    }
    const p = run.ctx.pythonStatus;
    return {
      runId: run.runId, job: run.job, label: run.label, area: run.area, options: run.ctx.options || {}, status, exitCode: code,
      startedAt: new Date(run.startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
      secs: +((endedAt - run.startedAt) / 1000).toFixed(1),
      app: this.appInfo,
      env: {
        python: p?.python?.version || null, pythonPath: run.ctx.python,
        packages: p ? Object.fromEntries(Object.entries(p.packages || {}).filter(([, v]) => v.ok).map(([k, v]) => [k, v.version])) : {},
        torchCuda: p?.torch?.cuda_available ?? null,
        // o que a própria execução usou (o processo Python informa ao começar)
        versoesExecucao: run.metrics.versoes || null,
        usouPlacaDeVideo: run.metrics.gpu ?? null,
        placa: run.metrics.placa || null,
        versoesFixas: p?.versoesFixas || null,
        foraDoLock: p?.foraDoLock || [],
      },
      personalizado: run.ctx.personalizado || {},
      params: run.ctx.overrides || {},
      inputs, outputs, stages: run.stages, metrics: run.metrics, error: run.error,
    };
  }

  cancel() {
    const c = this.current;
    if (!c) return false;
    c.cancelled = true;
    killTree(c.child);
    this.log.warn('execução', `${c.label}: cancelamento pedido`);
    return true;
  }

  /** Execuções registradas na pasta de trabalho (mais recentes primeiro). */
  list(ws, { job, limit = 20 } = {}) {
    const dir = path.join(ws, 'runs');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}_\d{6}_/.test(n)).sort().reverse(); } catch { return []; }
    const out = [];
    for (const n of names) {
      if (job && !n.endsWith('_' + job)) continue;
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(dir, n, 'manifest.json'), 'utf8')); } catch {
        // sem manifesto: execução interrompida (app fechado no meio)
        m = { runId: n, job: n.split('_').slice(2).join('_'), status: this.current?.runId === n ? 'running' : 'interrupted' };
      }
      out.push({ ...m, dir: path.join(dir, n) });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Recalcula o sha256 das saídas e compara com o manifesto. */
  async verify(ws, runId) {
    if (!/^[\w-]+$/.test(runId || '')) throw new Error('Execução inválida.');
    const m = JSON.parse(fs.readFileSync(path.join(ws, 'runs', runId, 'manifest.json'), 'utf8'));
    const files = [];
    for (const o of m.outputs || []) {
      const abs = path.join(ws, ...o.path.split('/'));
      if (!fs.existsSync(abs)) { files.push({ path: o.path, state: 'missing' }); continue; }
      const h = await sha256(abs);
      files.push({ path: o.path, state: h === o.sha256 ? 'ok' : 'changed' });
    }
    return { runId, ok: files.every((f) => f.state === 'ok'), files, checkedAt: Date.now() };
  }
}

const fmtSecs = (s) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

module.exports = { RunManager, LABELS };
