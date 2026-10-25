// Sequências de execuções: o ciclo mensal ("Fazer tudo") e o modo científico (replay sem
// vazamento e multi-seed).
//
// Uma sequência é uma lista de passos executados um depois do outro:
//   { kind: 'job', job, opts?, overrides?, resolve? }  uma fase do pipeline (pode virar várias
//        execuções, ex.: validar cada mês pronto). overrides: DATA_END e GLOBAL_SEED do passo.
//   { kind: 'internal', internal, args }            passo do próprio app (copiar resultados de
//        uma semente, agregar o multi-seed, montar o pacote de publicação).
// Cada sequência fica registrada em runs/_sequencias/<id>.json com o runId de cada execução,
// além do manifesto normal de cada execução.
const fs = require('fs');
const path = require('path');

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

class SequenceRunner {
  /**
   * startRun(job, opts, extra) → { runId }  (o mesmo caminho do botão Executar das telas)
   * resolvers[nome](ws, step, rec) → lista de opts (vazia = passo pulado; { motivo } no objeto)
   * internals[nome](ws, args, rec, progress) → texto de resumo
   */
  constructor({ log, send, startRun, runs, resolvers, internals, onBusy }) {
    Object.assign(this, { log, send, startRun, runs, resolvers, internals, onBusy });
    this.current = null;
    this.cancelled = false;
  }

  dir(ws) { return path.join(ws, 'runs', '_sequencias'); }
  save(ws, rec) {
    fs.mkdirSync(this.dir(ws), { recursive: true });
    fs.writeFileSync(path.join(this.dir(ws), `${rec.id}.json`), JSON.stringify(rec, null, 2));
  }
  emit(rec) { this.send('seq:event', rec); }
  status() { return this.current; }

  start(ws, plan) {
    if (this.current) throw new Error('Já existe uma sequência em andamento.');
    if (this.runs.status()) throw new Error('Espere a execução em andamento terminar.');
    if (!plan?.steps?.length) throw new Error('Nenhum passo escolhido.');
    const rec = {
      id: `${stamp()}_${plan.kind}`, kind: plan.kind, title: plan.title, params: plan.params || {},
      startedAt: new Date().toISOString(), status: 'running',
      steps: plan.steps.map((s, i) => ({ ...s, id: s.id || `p${i + 1}`, status: s.skip ? 'skipped' : 'pending', runs: [], detail: null })),
    };
    this.current = rec;
    this.cancelled = false;
    this.save(ws, rec);
    this.log.info('sequência', `${rec.title}: iniciando (${rec.steps.filter((s) => !s.skip).length} passos)`);
    this.onBusy?.(true);
    this.loop(ws, rec).catch((e) => this.log.error('sequência', e.stack || e.message));
    return rec;
  }

  async loop(ws, rec) {
    const t0 = Date.now();
    for (const step of rec.steps) {
      if (this.cancelled) { if (step.status === 'pending') step.status = 'cancelled'; continue; }
      if (step.status === 'skipped') continue;
      step.status = 'running'; step.startedAt = new Date().toISOString();
      this.emit(rec); this.save(ws, rec);
      try {
        if (step.kind === 'job') {
          const list = step.resolve ? await this.resolvers[step.resolve](ws, step, rec) : [step.opts || {}];
          if (!list.length || list[0]?.motivo) {
            step.status = 'skipped'; step.detail = list[0]?.motivo || 'nada a fazer';
          } else {
            for (const opts of list) {
              if (this.cancelled) break;
              const r = await this.startRun(step.job, opts, { overrides: step.overrides, padrao: step.padrao, poiSet: step.poiSet || null, sequencia: { id: rec.id, passo: step.id } });
              const entry = { runId: r.runId, mes: opts.mes || null, area: opts.area || null, status: 'running' };
              step.runs.push(entry);
              this.emit(rec); this.save(ws, rec);
              const end = await this.runs.waitEnd(r.runId);
              entry.status = end.status; entry.secs = end.manifest?.secs ?? null;
              if (end.status !== 'ok') throw Object.assign(new Error(end.manifest?.error?.msg || (end.status === 'cancelled' ? 'cancelada' : 'a execução falhou')), { cancelled: end.status === 'cancelled' });
            }
            step.status = this.cancelled ? 'cancelled' : 'done';
          }
        } else {
          step.detail = await this.internals[step.internal](ws, step.args || {}, rec, (p) => { step.progress = p; this.emit(rec); });
          step.status = this.cancelled ? 'cancelled' : 'done';
        }
      } catch (e) {
        step.status = e.cancelled || this.cancelled ? 'cancelled' : 'error';
        step.detail = e.message;
        rec.status = step.status === 'cancelled' ? 'cancelled' : 'error';
        this.cancelled = true; // os passos seguintes dependem deste
      }
      step.endedAt = new Date().toISOString();
      this.emit(rec); this.save(ws, rec);
    }
    if (rec.status === 'running') rec.status = this.cancelled ? 'cancelled' : 'ok';
    rec.endedAt = new Date().toISOString();
    rec.secs = Math.round((Date.now() - t0) / 1000);
    this.save(ws, rec);
    this.current = null;
    this.onBusy?.(false);
    this.log[rec.status === 'ok' ? 'ok' : 'warn']('sequência', `${rec.title}: ${rec.status === 'ok' ? 'concluída' : rec.status === 'cancelled' ? 'cancelada' : 'parou com erro'}`);
    this.emit(rec);
  }

  cancel() {
    if (!this.current) return false;
    this.cancelled = true;
    this.runs.cancel();
    return true;
  }

  list(ws, limit = 20) {
    let names = [];
    try { names = fs.readdirSync(this.dir(ws)).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit); } catch { return []; }
    return names.map((f) => { try { return JSON.parse(fs.readFileSync(path.join(this.dir(ws), f), 'utf8')); } catch { return null; } })
      .filter(Boolean).map((r) => (r.status === 'running' && r.id !== this.current?.id ? { ...r, status: 'interrupted' } : r));
  }
}

// ── Ajudantes de data ────────────────────────────────────────────────────────────────────────
/** Último dia do mês anterior a 'AAAA-MM' (o que se sabia antes do mês). */
function endOfPrevMonth(mes) {
  const [y, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
}
function addMonths(mes, n) {
  const [y, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

module.exports = { SequenceRunner, endOfPrevMonth, addMonths };
