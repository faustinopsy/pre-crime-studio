// Perfil de uma planilha da SSP (.xlsx), sem dependências.
// Roda como processo filho (Node do Electron com ELECTRON_RUN_AS_NODE=1):
//   node xlsx-profile.js <arquivo.xlsx> <saida.json>
// Lê o zip e o XML em streaming e conta, por combinação de
//   município | ocorrência | tipo de veículo | AAAA-MM (data da ocorrência)
// quantas linhas existem e quantas têm coordenadas. Progresso no stdout: @@P {json}
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const WANT = ['NOME_MUNICIPIO', 'DESCR_OCORRENCIA_VEICULO', 'DESCR_TIPO_VEICULO', 'DATA_OCORRENCIA_BO', 'LATITUDE', 'LONGITUDE'];
const VERSION = 2; // mude quando a leitura mudar: o app relê as planilhas
const say = (o) => process.stdout.write('@@P ' + JSON.stringify(o) + '\n');

// ── zip ───────────────────────────────────────────────────────────────────────
function readEntries(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 66000 + 22);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('não é um arquivo zip/xlsx válido');
  let cdCount = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || cdCount === 0xffff) { // zip64
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
      const z64Off = Number(tail.readBigUInt64LE(loc + 8));
      const z = Buffer.alloc(56); fs.readSync(fd, z, 0, 56, z64Off);
      cdCount = Number(z.readBigUInt64LE(32)); cdSize = Number(z.readBigUInt64LE(40)); cdOff = Number(z.readBigUInt64LE(48));
    }
  }
  const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
  const entries = {};
  let p = 0;
  for (let k = 0; k < cdCount && p < cd.length; k++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let comp = cd.readUInt32LE(p + 20), uncomp = cd.readUInt32LE(p + 24);
    const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
    let off = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nl);
    let e = p + 46 + nl; const eEnd = e + el;
    while (e + 4 <= eEnd) {
      const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2); let q = e + 4;
      if (id === 0x0001) {
        if (uncomp === 0xffffffff) { uncomp = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (comp === 0xffffffff) { comp = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (off === 0xffffffff) { off = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    entries[name] = { method, comp, uncomp, off };
    p = eEnd + cl;
  }
  return { fd, entries };
}

function entryStream({ fd, entries }, file, name) {
  const en = entries[name];
  if (!en) return null;
  const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, en.off);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('cabeçalho zip inválido em ' + name);
  const start = en.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = fs.createReadStream(file, { start, end: start + en.comp - 1, highWaterMark: 1 << 20 });
  if (en.method === 0) return raw;
  if (en.method !== 8) throw new Error('compressão não suportada: ' + en.method);
  return raw.pipe(zlib.createInflateRaw({ chunkSize: 1 << 20 }));
}

async function readText(z, file, name) {
  const s = entryStream(z, file, name);
  if (!s) return null;
  const parts = [];
  for await (const c of s) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

// Percorre um XML grande entregando cada elemento <tag ...>...</tag> completo.
// Trata <tag/> vazio (a SSP tem <si/> em algumas planilhas; ignorar isso desloca todos os
// textos compartilhados seguintes) e não confunde <row> com <rowBreaks>.
async function eachBlock(stream, tag, onBlock, onBytes) {
  const open = '<' + tag, close = '</' + tag + '>';
  let buf = '', bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length; onBytes?.(bytes);
    buf += chunk.toString('utf8');
    let from = 0;
    for (;;) {
      let a = buf.indexOf(open, from);
      if (a < 0) { from = Math.max(from, buf.length - open.length); break; }
      const next = buf[a + open.length];
      if (next === undefined) { from = a; break; }
      if (next !== '>' && next !== '/' && next !== ' ' && next !== '\t' && next !== '\r' && next !== '\n') { from = a + open.length; continue; }
      const gt = buf.indexOf('>', a);
      if (gt < 0) { from = a; break; }
      if (buf[gt - 1] === '/') {                       // <tag .../>
        if (onBlock(buf.slice(a, gt + 1)) === false) return;
        from = gt + 1; continue;
      }
      const b = buf.indexOf(close, gt);
      if (b < 0) { from = a; break; }
      if (onBlock(buf.slice(a, b + close.length)) === false) return;
      from = b + close.length;
    }
    buf = buf.slice(from);
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : (ENT[e] ?? m));
const texts = (blk) => { let out = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(blk))) out += m[1]; return unxml(out); };

function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function toYm(v, isNum) {
  if (v == null || v === '') return 'sem data';
  if (isNum) {
    const n = Number(v); if (!isFinite(n) || n < 1000) return 'inválida';
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  let m = /^(\d{4})-(\d{2})/.exec(v); if (m) return `${m[1]}-${m[2]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v); if (m) return `${m[3]}-${m[2].padStart(2, '0')}`;
  return 'inválida';
}
const hasCoord = (v) => { if (v == null || v === '') return false; const n = Number(String(v).replace(',', '.')); return isFinite(n) && n !== 0; };

async function main() {
  const [file, out] = process.argv.slice(2);
  const t0 = Date.now();
  const z = readEntries(file);
  const names = Object.keys(z.entries);

  // aba: a primeira cujo nome tem "VEICULO" (mesma regra do pipeline), senão a primeira
  const wb = await readText(z, file, 'xl/workbook.xml');
  const rels = await readText(z, file, 'xl/_rels/workbook.xml.rels') || '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map((m) => ({ name: unxml(m[1]), rid: m[2] }));
  if (!sheets.length) throw new Error('planilha sem abas');
  const pick = sheets.find((s) => /VE[IÍ]CULO/i.test(s.name)) || sheets[0];
  const relM = new RegExp(`<Relationship\\b[^>]*Id="${pick.rid}"[^>]*Target="([^"]+)"`).exec(rels) || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${pick.rid}"`).exec(rels);
  let target = relM ? relM[1].replace(/^\/?(xl\/)?/, '') : 'worksheets/sheet1.xml';
  target = 'xl/' + target;
  if (!names.includes(target)) throw new Error('aba não encontrada no arquivo: ' + target);

  // textos compartilhados
  say({ step: 'textos' });
  const sst = [];
  const sstStream = entryStream(z, file, 'xl/sharedStrings.xml');
  if (sstStream) await eachBlock(sstStream, 'si', (blk) => { sst.push(texts(blk)); });

  // linhas
  const total = z.entries[target].uncomp || 1;
  let header = null, cols = null, rows = 0, skipped = 0, lastPct = -1;
  const counts = new Map();
  await eachBlock(entryStream(z, file, target), 'row', (row) => {
    const cells = {};
    const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
    while ((m = re.exec(row))) {
      const attrs = m[1];
      const ref = /\br="([A-Z]+)\d*"/.exec(attrs); if (!ref) continue;
      const ci = colIndex(ref[1]);
      if (cols && !cols.has(ci)) continue;
      const t = (/\bt="(\w+)"/.exec(attrs) || [])[1] || 'n';
      const inner = m[2] || '';
      let v = null;
      if (t === 's') { const vv = /<v>([^<]*)<\/v>/.exec(inner); v = vv ? sst[Number(vv[1])] : null; }
      else if (t === 'inlineStr') v = texts(inner);
      else { const vv = /<v>([^<]*)<\/v>/.exec(inner); v = vv ? unxml(vv[1]) : null; }
      cells[ci] = { v, num: t === 'n' };
    }
    if (!Object.keys(cells).length) return;            // linha vazia
    if (!header) {
      // cabeçalho: primeira linha com pelo menos 3 das colunas esperadas
      const h = {};
      for (const [ci, c] of Object.entries(cells)) if (c.v != null) h[String(c.v).trim()] = Number(ci);
      if (WANT.filter((w) => h[w] != null).length < 3) { skipped++; return; }
      header = h;
      cols = new Set(WANT.map((w) => header[w]).filter((x) => x != null));
      return;
    }
    rows++;
    const g = (k) => (header[k] != null ? cells[header[k]] : undefined);
    const mun = String(g('NOME_MUNICIPIO')?.v ?? '').trim().toUpperCase() || '(vazio)';
    const oc = String(g('DESCR_OCORRENCIA_VEICULO')?.v ?? '').trim() || '(vazio)';
    const ve = String(g('DESCR_TIPO_VEICULO')?.v ?? '').trim() || '(vazio)';
    const dt = g('DATA_OCORRENCIA_BO');
    const ym = toYm(dt?.v, dt?.num);
    const co = hasCoord(g('LATITUDE')?.v) && hasCoord(g('LONGITUDE')?.v);
    const key = `${mun}|${oc}|${ve}|${ym}`;
    let c = counts.get(key); if (!c) { c = [0, 0]; counts.set(key, c); }
    c[0]++; if (co) c[1]++;
  }, (bytes) => {
    const pct = Math.min(99, Math.floor((bytes / total) * 100));
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; say({ step: 'linhas', pct, rows }); }
  });

  const result = {
    file: require('path').basename(file), sheet: pick.name,
    columns: header ? Object.keys(header) : [], missing: WANT.filter((w) => !header || header[w] == null),
    rows, skippedBeforeHeader: skipped, counts: Object.fromEntries(counts), ms: Date.now() - t0, version: VERSION,
  };
  fs.writeFileSync(out, JSON.stringify(result));
  say({ step: 'fim', rows, ms: result.ms });
}

main().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });
