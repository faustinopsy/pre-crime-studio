// Publicação: monta o pacote para o servidor Node, verifica, mostra a pré-visualização e exporta.
//
//   publish/_staging/<data>/      pacote recém-montado (pré-visualização e verificação)
//   publish/pacotes/<nome>/       pacote exportado (pasta pronta para copiar para o servidor)
//   publish/pacotes/<nome>.zip    o mesmo, compactado
//   publish/pacotes/<nome>.verificacao.json   resultado da última verificação
//   publish/site.json             título, apresentação e aviso usados da última vez
//
// A montagem e a verificação rodam num processo à parte (server/tools/build_package.mjs com o
// Node do Electron), para a janela não travar com os arquivos grandes.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MapServer } = require('./mapServer');
const geojsonExport = require('./geojsonExport');

const AVISO_PADRAO = 'Previsão estatística a partir de registros da SSP-SP. Indica concentração provável de furtos e roubos de veículos por área, não aponta pessoas. Crimes não registrados ficam fora dos dados.';
const SAFE = /^[\w.-]+$/;

const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dirSize = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
};

class Publisher {
  constructor({ serverDir, log, appVersion }) {
    this.serverDir = serverDir; this.log = log; this.appVersion = appVersion;
    this.child = null;
    this.preview = null; // { server: MapServer, dir }
  }

  dirs(ws) {
    return { pub: path.join(ws, 'publish'), staging: path.join(ws, 'publish', '_staging'), pacotes: path.join(ws, 'publish', 'pacotes') };
  }

  /** O que dá para publicar: meses com previsão, áreas, modelos, crimes reais, ruas, textos. */
  options(ws, forecastInfo) {
    const av = geojsonExport.available(ws);
    const val = forecastInfo?.validations || {};
    const ruas = (() => { try { return fs.readdirSync(path.join(ws, 'streets')).filter((f) => /^ruas_area_\d+\.geojson$/.test(f)).map((f) => f.slice(5, -8)); } catch { return []; } })();
    const pois = (() => { try { return fs.readdirSync(path.join(ws, 'pois')).filter((f) => /^pois_area_\d+\.geojson$/.test(f)).map((f) => f.slice(5, -8)); } catch { return []; } })();
    const site = { titulo: 'Pre-Crime', apresentacao: '', aviso: AVISO_PADRAO, ...(readJson(path.join(this.dirs(ws).pub, 'site.json')) || {}) };
    return {
      months: av.months.map((m) => ({ ...m, validated: Object.keys(val[m.tag] || {}).sort(),
        personalizado: forecastInfo?.months?.find((x) => x.tag === m.tag)?.personalizado || [] })),
      streets: ruas, pois, site, avisoPadrao: AVISO_PADRAO,
    };
  }

  /** Roda server/tools/build_package.mjs e repassa os eventos @@PUB. */
  runTool(args, onEvent, env = {}) {
    if (this.child) throw new Error('Já existe uma montagem ou verificação em andamento.');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(this.serverDir, 'tools', 'build_package.mjs'), ...args, '--eventos'], {
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, cwd: this.serverDir,
      });
      this.child = child;
      const result = {};
      let buf = '', err = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('@@PUB ')) continue;
          let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          result[ev.t] = ev;
          onEvent?.(ev);
        }
      });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { this.child = null; reject(e); });
      child.on('exit', (code) => {
        this.child = null;
        if (result.error) return reject(new Error(result.error.msg));
        if (!result.done && code !== 0) return reject(new Error(err.trim().split('\n').pop() || `A montagem parou (código ${code}).`));
        resolve(result);
      });
    });
  }

  cancel() { if (this.child) { this.child.kill(); return true; } return false; }

  /**
   * Monta e verifica um pacote novo em publish/_staging.
   * fundo: { provedor: 'carto', estilo, chave } quando o operador escolheu levar o fundo da
   * CARTO (a chave fica visível no site publicado); sem ele, o site usa as ruas da área.
   */
  async build(ws, opts, onEvent, fundo = null) {
    const d = this.dirs(ws);
    await this.stopPreview();
    // montagens anteriores não exportadas: são temporárias do app
    if (fs.existsSync(d.staging)) for (const x of fs.readdirSync(d.staging)) fs.rmSync(path.join(d.staging, x), { recursive: true, force: true });
    fs.mkdirSync(d.staging, { recursive: true });
    const site = {
      titulo: String(opts.site?.titulo || 'Pre-Crime').trim().slice(0, 80),
      apresentacao: String(opts.site?.apresentacao || '').trim().slice(0, 600),
      aviso: String(opts.site?.aviso || AVISO_PADRAO).trim().slice(0, 800),
    };
    fs.writeFileSync(path.join(d.pub, 'site.json'), JSON.stringify(site, null, 2));
    const id = stamp();
    const out = path.join(d.staging, id);
    const tags = (opts.tags || []).filter((t) => /^\d{4}_\d{2}$/.test(t));
    const areas = (opts.areas || []).filter((a) => /^area_\d{2}$/.test(a));
    const models = (opts.models || []).filter((m) => ['Ensemble', 'RF', 'LSTM', 'Transformer'].includes(m));
    if (!tags.length) throw new Error('Escolha ao menos um mês.');
    if (!areas.length || !models.length) throw new Error('Escolha ao menos uma área e um modelo.');
    const args = ['--data', path.join(ws, 'processed'), '--out', out, '--meses', tags.join(','), '--areas', areas.join(','), '--modelos', models.join(','),
      '--titulo', site.titulo, '--apresentacao', site.apresentacao, '--aviso', site.aviso, '--versao', this.appVersion || '0', '--verificar'];
    if (!opts.crimes) args.push('--sem-crimes');
    if (!opts.metricas) args.push('--sem-metricas');
    const carto = fundo?.provedor === 'carto';
    // sem o fundo da CARTO, o site desenha as ruas da área: elas precisam ir no pacote
    if (opts.ruas || !carto) args.push('--ruas');
    if (opts.pois) args.push('--pois');
    this.log.info('publicação', `montando o pacote (${tags.join(', ')} · ${areas.length} área(s) · ${models.join(', ')} · fundo: ${carto ? 'CARTO' : 'ruas da área'})`);
    const r = await this.runTool(args, onEvent, carto ? { PRECRIME_PKG_FUNDO: JSON.stringify(fundo) } : {});
    const ok = r.verify?.ok;
    this.log[ok ? 'ok' : 'warn']('publicação', `pacote montado: ${(r.manifest.resumo.tamanho / 1048576).toFixed(1)} MB · verificação ${ok ? 'OK' : 'com problemas'}`);
    fs.writeFileSync(path.join(d.staging, `${id}.verificacao.json`), JSON.stringify(r.verify || null, null, 1));
    return { id, dir: out, staged: true, manifest: readJson(path.join(out, 'manifest.json')), verify: r.verify || null };
  }

  /** Verifica de novo um pacote (montado ou exportado). */
  async verify(ws, ref, onEvent) {
    const dir = this.resolve(ws, ref);
    const r = await this.runTool(['--verificar-pacote', dir, '--data', path.join(ws, 'processed')], onEvent);
    fs.writeFileSync(`${dir}.verificacao.json`, JSON.stringify(r.verify || null, null, 1));
    return r.verify || null;
  }

  /** ref: { staged: id } ou { name } (exportado) → pasta do pacote. */
  resolve(ws, ref) {
    const d = this.dirs(ws);
    const name = ref?.staged || ref?.name;
    if (!name || !SAFE.test(name)) throw new Error('Pacote inválido.');
    const dir = path.join(ref.staged ? d.staging : d.pacotes, name);
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) throw new Error('Pacote não encontrado.');
    return dir;
  }

  async startPreview(ws, ref) {
    const dir = this.resolve(ws, ref);
    if (this.preview?.dir === dir && this.preview.server.proc) return this.preview.server.status();
    await this.stopPreview();
    // roda o server.js do próprio pacote, como no servidor de destino
    const server = new MapServer({ serverJs: path.join(dir, 'server.js'), log: this.log, live: false, label: 'pacote' });
    this.preview = { server, dir };
    return server.start(path.join(dir, 'data'));
  }

  async stopPreview() {
    if (this.preview) { await this.preview.server.stop(); this.preview = null; await new Promise((r) => setTimeout(r, 150)); }
  }

  /** Move o pacote montado para publish/pacotes/<nome> e, se pedido, gera o .zip. */
  async exportPackage(ws, id, { zip = true } = {}, onEvent) {
    const d = this.dirs(ws);
    const src = this.resolve(ws, { staged: id });
    const man = readJson(path.join(src, 'manifest.json'));
    const meses = man.selecao.meses.map((t) => t.replace('_', '-'));
    const base = `precrime-publicacao-${meses.length > 2 ? `${meses[0]}_a_${meses[meses.length - 1]}` : meses.join('_')}`;
    fs.mkdirSync(d.pacotes, { recursive: true });
    let name = base, n = 2;
    while (fs.existsSync(path.join(d.pacotes, name)) || fs.existsSync(path.join(d.pacotes, `${name}.zip`))) name = `${base}-${n++}`;
    const dest = path.join(d.pacotes, name);
    const wasPreview = this.preview?.dir === src;
    await this.stopPreview(); // no Windows, a pasta em uso pelo servidor não pode ser movida
    // o Windows pode segurar a pasta por alguns instantes depois que o servidor fecha
    for (let i = 0; ; i++) {
      try { fs.renameSync(src, dest); break; } catch (e) {
        if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw new Error(`Não consegui mover o pacote para ${dest}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const ver = path.join(d.staging, `${id}.verificacao.json`);
    if (fs.existsSync(ver)) fs.renameSync(ver, `${dest}.verificacao.json`);
    let zipInfo = null;
    if (zip) {
      onEvent?.({ t: 'progress', etapa: 'zip', done: 0, total: 1 });
      const { zipDir } = await import(require('url').pathToFileURL(path.join(this.serverDir, 'lib', 'zip.js')).href);
      zipInfo = { file: `${dest}.zip`, ...zipDir(dest, `${dest}.zip`, { prefix: name }) };
    }
    this.log.ok('publicação', `pacote exportado em ${dest}${zipInfo ? ` (+ ${name}.zip)` : ''}`);
    if (wasPreview) await this.startPreview(ws, { name });
    return { name, dir: dest, zip: zipInfo };
  }

  /** O pacote montado mais recente que ainda não foi exportado (ex.: montado pelo ciclo mensal). */
  latestStaged(ws) {
    const d = this.dirs(ws);
    let ids = [];
    try { ids = fs.readdirSync(d.staging, { withFileTypes: true }).filter((e) => e.isDirectory() && SAFE.test(e.name)).map((e) => e.name).sort(); } catch { return null; }
    const id = ids.pop();
    if (!id) return null;
    const manifest = readJson(path.join(d.staging, id, 'manifest.json'));
    return manifest ? { id, dir: path.join(d.staging, id), manifest, verify: readJson(path.join(d.staging, `${id}.verificacao.json`)) } : null;
  }

  /** Pacotes já exportados (mais recentes primeiro). */
  history(ws) {
    const d = this.dirs(ws);
    let names = [];
    try { names = fs.readdirSync(d.pacotes, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
    return names.map((name) => {
      const dir = path.join(d.pacotes, name);
      const man = readJson(path.join(dir, 'manifest.json'));
      if (!man) return null;
      const zipFile = `${dir}.zip`;
      return {
        name, dir, criadoEm: man.criadoEm, selecao: man.selecao, site: man.site, tamanho: man.tamanho, tamanhoOrigem: man.tamanhoOrigem,
        execucoes: man.execucoes || [], zip: fs.existsSync(zipFile) ? { file: zipFile, bytes: fs.statSync(zipFile).size } : null,
        verificacao: readJson(`${dir}.verificacao.json`),
      };
    }).filter(Boolean).sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
  }
}

module.exports = { Publisher, AVISO_PADRAO, dirSize };
