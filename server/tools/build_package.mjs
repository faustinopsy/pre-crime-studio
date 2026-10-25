#!/usr/bin/env node
// Monta (e verifica) um pacote de publicação pela linha de comando — o mesmo que a tela
// Publicação do app faz (o app roda este script num processo à parte, com --eventos).
//
//   node tools/build_package.mjs --data <processed> --out <pasta nova> --meses 2026_02[,2026_01]
//        [--areas area_01,area_02] [--modelos Ensemble,RF] [--sem-crimes] [--sem-metricas] [--ruas] [--pois]
//        [--titulo "..."] [--apresentacao "..."] [--aviso "..."] [--versao x.y.z]
//        [--verificar] [--zip] [--eventos]
//
//   node tools/build_package.mjs --verificar-pacote <pasta do pacote> --data <processed>
//        só verifica um pacote já montado (arquivos e rotas contra o servidor ao vivo)
//
// --eventos: imprime linhas "@@PUB {json}" (progresso, manifesto, verificação) para o app.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage } from '../lib/package-build.js';
import { checkFiles, compareServers } from '../lib/verify.js';
import { zipDir } from '../lib/zip.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);
const list = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : null);
const EV = flag('eventos');
const emit = (t, o) => { if (EV) process.stdout.write(`@@PUB ${JSON.stringify({ t, ...o })}\n`); };
const say = (s) => { if (!EV) console.log(s); };
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;

const DATA = arg('data');
const ONLY_VERIFY = arg('verificar-pacote');
const OUT = ONLY_VERIFY || arg('out');
if (!DATA || !OUT || (!ONLY_VERIFY && !arg('meses'))) {
  console.error('uso: node tools/build_package.mjs --data <processed> --out <pasta> --meses AAAA_MM[,...]');
  process.exit(2);
}

try {
  let man;
  if (ONLY_VERIFY) {
    man = JSON.parse(readFileSync(join(resolve(OUT), 'manifest.json'), 'utf8'));
  } else {
    const t0 = Date.now();
    man = buildPackage({
      processedDir: resolve(DATA), serverDir: resolve(HERE, '..'), outDir: resolve(OUT), appVersion: arg('versao', 'cli'),
      selection: { tags: list(arg('meses')), areas: list(arg('areas')), models: list(arg('modelos')), crimes: !flag('sem-crimes'), metricas: !flag('sem-metricas'), ruas: flag('ruas'), pois: flag('pois') },
      site: { titulo: arg('titulo') || undefined, apresentacao: arg('apresentacao') || '', aviso: arg('aviso') || undefined },
      // fundo do mapa (com a chave da CARTO) vem por variável de ambiente, para não aparecer na linha de comando
      fundo: (() => { try { return JSON.parse(process.env.PRECRIME_PKG_FUNDO || 'null'); } catch { return null; } })(),
      onProgress: (p) => {
        emit('progress', p);
        if (!EV && process.stdout.isTTY) process.stdout.write(`\r${p.etapa} ${p.done}/${p.total} ${p.arquivo || ''}`.padEnd(70));
      },
    });
    if (!EV && process.stdout.isTTY) process.stdout.write('\r'.padEnd(72) + '\r');
    emit('manifest', { dir: resolve(OUT), secs: (Date.now() - t0) / 1000, resumo: { selecao: man.selecao, tamanho: man.tamanho, tamanhoOrigem: man.tamanhoOrigem, arquivos: man.arquivos.length, criadoEm: man.criadoEm } });
    say(`pacote: ${resolve(OUT)} · ${man.arquivos.length} arquivos · ${mb(man.tamanho)} (origem: ${mb(man.tamanhoOrigem)}) · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    say(`meses ${man.selecao.meses.join(', ')} · áreas ${man.selecao.areas.length} · modelos ${man.selecao.modelos.join(', ')}`);
  }

  if (flag('verificar') || ONLY_VERIFY) {
    emit('progress', { etapa: 'arquivos', done: 0, total: 1 });
    const files = checkFiles(resolve(OUT));
    say(`arquivos: ${files.ok ? 'OK' : 'PROBLEMAS'} (${files.arquivos}, ${mb(files.tamanho)})`);
    for (const p of files.problemas) say('  ' + p);
    const start = (args) => new Promise((ok, ko) => {
      const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d; const m = buf.match(/LISTENING (\d+)/); if (m) ok({ p, base: `http://127.0.0.1:${m[1]}` }); });
      p.on('exit', (c) => ko(new Error('servidor saiu: ' + c)));
    });
    // o servidor do pacote roda com a cópia que está no pacote, como no servidor de destino
    const pkg = await start([join(resolve(OUT), 'server.js'), '--port', '0']);
    const live = await start([join(HERE, '..', 'server.js'), '--data', resolve(DATA), '--port', '0']);
    try {
      const r = await compareServers({
        pkgBase: pkg.base, liveBase: live.base, sel: man.selecao,
        onProgress: (p) => emit('progress', { etapa: 'rotas', done: p.done, total: p.total, arquivo: p.rota }),
      });
      const ver = { em: new Date().toISOString(), arquivos: files, rotas: { total: r.rotas, iguais: r.iguais, diferencas: r.diferencas.slice(0, 20), ausentes: r.ausentes.slice(0, 20) }, ok: files.ok && r.ok };
      emit('verify', ver);
      say(`rotas: ${r.rotas} · iguais ao servidor ao vivo: ${r.iguais} · diferenças: ${r.diferencas.length} · sem resposta: ${r.ausentes.length}`);
      for (const d of [...r.diferencas, ...r.ausentes].slice(0, 20)) say('  ' + JSON.stringify(d).slice(0, 300));
      process.exitCode = ver.ok ? 0 : 1;
    } finally { pkg.p.kill(); live.p.kill(); }
  }
  if (flag('zip')) {
    emit('progress', { etapa: 'zip', done: 0, total: 1 });
    const z = zipDir(resolve(OUT), resolve(OUT) + '.zip', { prefix: basename(resolve(OUT)) });
    emit('zip', { file: resolve(OUT) + '.zip', bytes: z.bytes });
    say(`zip: ${resolve(OUT)}.zip · ${mb(z.bytes)}`);
  }
  emit('done', { ok: process.exitCode !== 1 });
} catch (e) {
  emit('error', { msg: e.message });
  if (!EV) console.error('[ERRO] ' + e.message);
  process.exitCode = 1;
}
