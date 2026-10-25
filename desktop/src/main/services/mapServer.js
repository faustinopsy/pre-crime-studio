// Sobe o servidor do mapa (server/server.js) usando o Node embutido no Electron
// (ELECTRON_RUN_AS_NODE=1): o operador não precisa ter Node instalado.
// O mesmo servidor serve o mapa interno (modo "ao vivo", lendo data/processed) e a
// pré-visualização do pacote de publicação.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class MapServer {
  // env(): variáveis extras do servidor (ex.: PRECRIME_BASEMAP com o fundo do mapa)
  constructor({ serverJs, log, live = true, label = 'mapa', env = null }) {
    this.serverJs = serverJs; this.log = log; this.live = live; this.label = label; this.env = env;
    this.proc = null; this.port = null; this.dataDir = null; this.starting = null;
  }

  status() { return { running: !!this.proc, port: this.port, dataDir: this.dataDir, url: this.url() }; }
  url() { return this.port ? `http://127.0.0.1:${this.port}/` : null; }

  async start(dataDir) {
    if (this.proc && this.dataDir === dataDir) return this.status();
    if (this.starting) await this.starting.catch(() => {});
    await this.stop();
    if (!fs.existsSync(dataDir)) throw new Error(`Pasta de resultados não encontrada: ${dataDir}`);
    if (!fs.existsSync(this.serverJs)) throw new Error(`Servidor do mapa não encontrado: ${this.serverJs}`);

    this.starting = new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [this.serverJs, '--data', dataDir, '--port', '0', '--host', '127.0.0.1', ...(this.live ? ['--live'] : [])], {
        env: { ...process.env, ...(this.env ? this.env() : {}), ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        cwd: path.dirname(this.serverJs),
      });
      let buf = '';
      const timer = setTimeout(() => { proc.kill(); reject(new Error('O servidor do mapa não respondeu em 15 s.')); }, 15000);
      proc.stdout.on('data', (d) => {
        buf += d.toString();
        const m = buf.match(/LISTENING (\d+)/);
        if (m && !this.port) {
          clearTimeout(timer);
          this.proc = proc; this.port = Number(m[1]); this.dataDir = dataDir;
          this.log.ok(this.label, `servidor do ${this.label} em ${this.url()} (dados: ${dataDir})`);
          resolve(this.status());
        }
      });
      proc.stderr.on('data', (d) => this.log.error(this.label, d.toString().trim()));
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === proc) { this.log.warn(this.label, `servidor do ${this.label} encerrou (código ${code})`); this.proc = null; this.port = null; }
        else if (!this.port) reject(new Error(`O servidor do mapa saiu com código ${code}.`));
      });
    });
    try { return await this.starting; } finally { this.starting = null; }
  }

  /** Reinicia com a mesma pasta (ex.: mudou o fundo do mapa). Não faz nada se estiver parado. */
  async restart() {
    const dir = this.dataDir;
    if (!this.proc || !dir) return null;
    await this.stop();
    return this.start(dir);
  }

  async stop() {
    const p = this.proc;
    this.proc = null; this.port = null; this.dataDir = null;
    if (p && !p.killed) { p.kill(); this.log.info(this.label, `servidor do ${this.label} parado`); }
  }
}

module.exports = { MapServer };
