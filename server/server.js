#!/usr/bin/env node
// Servidor do mapa Pre-Crime — sem dependências (Node >= 20).
//
//   node server.js                       # lê ../data/processed, porta 8080
//   node server.js --data <pasta> --port 0
//
// --data   pasta com results_geojson/, results/ e metrics/ (o data/processed do pipeline
//          ou a pasta data/ de um pacote de publicação)
// --port   0 = porta livre escolhida pelo sistema (usado pelo app desktop)
// --host   padrão 127.0.0.1; use 0.0.0.0 para publicar
// --live   mapa interno do app (habilita /api/debug); não use ao publicar
//
// Ao subir imprime "LISTENING <porta>" (o app desktop espera essa linha).
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { openStore } from './lib/data.js';
import { buildRoutes, HttpError } from './lib/routes.js';

const gz = promisify(gzip);
const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return process.env[`PRECRIME_${name.toUpperCase()}`] ?? def;
}

// num pacote publicado os dados ficam em ./data (com pacote.json); no repositório, em ../data/processed
const DATA = resolve(arg('data', existsSync(join(HERE, 'data', 'pacote.json')) ? join(HERE, 'data') : join(HERE, '..', 'data', 'processed')));
const PUBLIC = resolve(arg('public', join(HERE, 'public')));
const PORT = Number(arg('port', 8080));
const HOST = arg('host', '127.0.0.1');

if (!existsSync(DATA)) {
  console.error(`[ERRO] pasta de dados não existe: ${DATA}`);
  process.exit(2);
}

const store = await openStore(DATA);
const LIVE = process.argv.includes('--live');
const dispatch = buildRoutes(store, { live: LIVE, publicDir: PUBLIC });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.geojson': 'application/json; charset=utf-8',
};
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

async function send(req, res, status, body, type) {
  const headers = { ...SECURITY, 'Content-Type': type, 'Cache-Control': 'no-cache' };
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = await gz(buf, { level: 5 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

function sendJson(req, res, status, obj) {
  return send(req, res, status, JSON.stringify(obj), MIME['.json']);
}

async function sendFile(req, res, file) {
  const st = statSync(file);
  const etag = `W/"${st.size}-${Math.round(st.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, SECURITY); return res.end(); }
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { ...SECURITY, 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
  if (st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/^image\//.test(type)) {
    const chunks = [];
    for await (const c of createReadStream(file)) chunks.push(c);
    const buf = await gz(Buffer.concat(chunks), { level: 5 });
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': buf.length });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function staticPath(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '').replace(/^\//, '');
  const full = normalize(join(PUBLIC, decodeURIComponent(rel)));
  if (!full.startsWith(PUBLIC + sep)) return null;
  return existsSync(full) && statSync(full).isFile() ? full : null;
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  let status = 200;
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { status = 405; return sendJson(req, res, 405, { error: 'método não permitido' }); }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const out = dispatch(url);
      if (out === undefined) { status = 404; return sendJson(req, res, 404, { error: 'rota não encontrada' }); }
      if (out && out.__file) return sendFile(req, res, out.__file);
      return sendJson(req, res, 200, out);
    }
    const file = staticPath(url.pathname);
    if (!file) { status = 404; return send(req, res, 404, 'Não encontrado', 'text/plain; charset=utf-8'); }
    return sendFile(req, res, file);
  } catch (e) {
    status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('[ERRO]', req.url, e);
    if (!res.headersSent) return sendJson(req, res, status, { error: e.message });
    res.destroy();
  } finally {
    if (process.env.PRECRIME_ACCESS_LOG === '1') console.log(`${req.method} ${req.url} ${status} ${Date.now() - t0}ms`);
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`LISTENING ${port}`);
  console.log(`Pre-Crime: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}  (dados: ${DATA})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
