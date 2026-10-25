// Log do sistema: arquivo diário UTF-8 em <userData>/logs, buffer em memória para a tela
// de Logs e aviso em tempo real para a interface. Captura erros do main e do renderer.
const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 10, info: 20, ok: 25, warn: 30, error: 40 };

class Logger {
  constructor(dir, { keep = 2000 } = {}) {
    this.dir = dir; this.keep = keep; this.buffer = []; this.listeners = new Set();
    fs.mkdirSync(dir, { recursive: true });
  }
  get file() { return path.join(this.dir, `precrime-${new Date().toISOString().slice(0, 10)}.log`); }

  write(level, scope, msg, extra) {
    const entry = { ts: Date.now(), level, scope, msg: msg instanceof Error ? (msg.stack || msg.message) : String(msg) };
    if (extra !== undefined) entry.extra = safe(extra);
    this.buffer.push(entry);
    if (this.buffer.length > this.keep) this.buffer.splice(0, this.buffer.length - this.keep);
    const line = `${new Date(entry.ts).toISOString()} [${level.toUpperCase().padEnd(5)}] ${scope}: ${entry.msg}${entry.extra ? ' ' + entry.extra : ''}\n`;
    try { fs.appendFileSync(this.file, line, 'utf8'); } catch { /* disco cheio etc. */ }
    if (level === 'error' || level === 'warn') console[level === 'error' ? 'error' : 'warn'](line.trim());
    for (const fn of this.listeners) { try { fn(entry); } catch { /* ouvinte quebrado */ } }
    return entry;
  }
  debug(s, m, e) { return this.write('debug', s, m, e); }
  info(s, m, e) { return this.write('info', s, m, e); }
  ok(s, m, e) { return this.write('ok', s, m, e); }
  warn(s, m, e) { return this.write('warn', s, m, e); }
  error(s, m, e) { return this.write('error', s, m, e); }

  onEntry(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  recent(n = 500, min = 'debug') {
    const lv = LEVELS[min] || 0;
    return this.buffer.filter((e) => LEVELS[e.level] >= lv).slice(-n);
  }

  captureProcess() {
    process.on('uncaughtException', (e) => this.error('processo', e));
    process.on('unhandledRejection', (e) => this.error('promessa', e instanceof Error ? e : String(e)));
    return this;
  }
  captureWebContents(wc) {
    wc.on('console-message', (ev) => {
      const level = ev.level ?? ev; // Electron >= 36 entrega um objeto de evento
      const lv = level === 'error' || level === 3 ? 'error' : level === 'warning' || level === 2 ? 'warn' : null;
      if (lv) this[lv]('interface', `${ev.message} (${path.basename(ev.sourceId || '')}:${ev.lineNumber ?? ''})`);
    });
    wc.on('render-process-gone', (_e, d) => this.error('interface', 'processo da interface encerrado: ' + d.reason));
    wc.on('did-fail-load', (_e, code, desc, url) => { if (code !== -3) this.error('interface', `falha ao carregar ${url}: ${code} ${desc}`); });
  }
}

function safe(x) { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }

module.exports = { Logger, LEVELS };
