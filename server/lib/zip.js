// Gera um .zip de uma pasta, sem dependências (deflate do zlib; arquivos já comprimidos vão sem
// recompressão). Suficiente para o pacote de publicação (bem abaixo de 4 GB).
import { closeSync, openSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as zlib from 'node:zlib';

const { deflateRawSync } = zlib;
// zlib.crc32 existe a partir do Node 22.2; antes disso, a tabela clássica
const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = zlib.crc32 || ((buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p)); else out.push(p);
  }
  return out.sort();
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Compacta srcDir em outFile; os caminhos dentro do zip começam com `prefix/`. */
export function zipDir(srcDir, outFile, { prefix = '' } = {}) {
  const fd = openSync(outFile, 'w');
  let offset = 0;
  const central = [];
  const write = (buf) => { writeSync(fd, buf); offset += buf.length; };
  try {
    for (const file of listFiles(srcDir)) {
      const name = Buffer.from((prefix ? prefix + '/' : '') + relative(srcDir, file).split(sep).join('/'), 'utf8');
      const data = readFileSync(file);
      const crc = crc32(data);
      const stored = /\.(gz|zip|png|jpe?g|woff2?)$/i.test(file);
      const body = stored ? data : deflateRawSync(data, { level: 9 });
      const method = stored ? 0 : 8;
      const { time, date } = dosTime(statSync(file).mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(method, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const at = offset;
      write(local); write(name); write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(0, 38); c.writeUInt32LE(at, 42);
      central.push(Buffer.concat([c, name]));
    }
    const cdStart = offset;
    for (const c of central) write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
    write(end);
  } finally { closeSync(fd); }
  return { arquivos: central.length, bytes: offset };
}
