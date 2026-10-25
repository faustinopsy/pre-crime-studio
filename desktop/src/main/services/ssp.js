// Planilhas da SSP na pasta de trabalho (<pasta>/dados_ssp).
// O usuário importa: escolhendo arquivos, escolhendo a pasta onde eles estão ou
// arrastando para a tela. O app copia (nunca move o original), confere se é um .xlsx
// de verdade, calcula o sha256 e guarda o registro em dados_ssp/_importacoes.json.
// Planilha do mesmo nome com conteúdo diferente substitui a anterior, que vai para
// dados_ssp/_substituidas/ (nada é apagado).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STD = /^VeiculosSubtraidos_(\d{4})\.xlsx$/i;
const REG = '_importacoes.json';

const sspDir = (ws) => path.join(ws, 'dados_ssp');
const yearOf = (name) => (name.match(/(20\d{2})/) || [])[1] || null;

function readReg(ws) {
  try { return JSON.parse(fs.readFileSync(path.join(sspDir(ws), REG), 'utf8')); } catch { return { files: {}, history: [] }; }
}
function writeReg(ws, reg) {
  fs.writeFileSync(path.join(sspDir(ws), REG), JSON.stringify(reg, null, 2), 'utf8');
}

/** Planilhas já importadas. */
function list(ws) {
  const dir = sspDir(ws);
  const reg = readReg(ws);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$')); } catch { /* sem pasta */ }
  return names.map((name) => {
    const st = fs.statSync(path.join(dir, name));
    const r = reg.files[name] || {};
    return {
      name, size: st.size, mtime: st.mtimeMs, year: yearOf(name), standard: STD.test(name),
      sha256: r.sha256 || null, importedAt: r.importedAt || null, source: r.source || null,
    };
  }).sort((a, b) => (a.year || '').localeCompare(b.year || '') || a.name.localeCompare(b.name));
}

/** Planilhas .xlsx dentro de uma pasta escolhida pelo usuário (sem entrar em subpastas). */
function scanFolder(folder) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch (e) { throw new Error(`Não consegui ler a pasta: ${e.message}`); }
  return names
    .filter((f) => /\.xlsx$/i.test(f) && !f.startsWith('~$'))
    .map((f) => path.join(folder, f))
    .filter((p) => fs.statSync(p).isFile());
}

function isXlsx(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }
  finally { fs.closeSync(fd); }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Copia calculando o hash no caminho; avisa o progresso em bytes. */
function copyWithHash(src, dst, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 });
    const ws = fs.createWriteStream(dst);
    let done = 0;
    rs.on('data', (d) => { h.update(d); done += d.length; onBytes(done); });
    rs.on('error', reject); ws.on('error', reject);
    ws.on('finish', () => resolve(h.digest('hex')));
    rs.pipe(ws);
  });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/**
 * Importa uma lista de arquivos. onProgress({index,total,name,bytes,size,status}).
 * Devolve [{ name, status: 'novo'|'atualizado'|'igual'|'erro', message }].
 */
async function importFiles(ws, files, onProgress = () => {}) {
  const dir = sspDir(ws);
  fs.mkdirSync(dir, { recursive: true });
  const reg = readReg(ws);
  const results = [];
  const unique = [...new Set(files.map((f) => path.resolve(f)))];

  for (let i = 0; i < unique.length; i++) {
    const src = unique[i];
    const name = path.basename(src);
    const base = { index: i + 1, total: unique.length, name };
    try {
      if (!/\.xlsx$/i.test(name)) throw new Error('não é um arquivo .xlsx');
      if (path.dirname(src) === dir) { results.push({ name, status: 'igual', message: 'já está na pasta de trabalho' }); continue; }
      const st = fs.statSync(src);
      if (!st.isFile() || st.size === 0) throw new Error('arquivo vazio ou inválido');
      if (!isXlsx(src)) throw new Error('o conteúdo não é de uma planilha Excel (.xlsx)');

      const target = path.join(dir, name);
      const tmp = target + '.part';
      onProgress({ ...base, bytes: 0, size: st.size, status: 'copiando' });
      const sha = await copyWithHash(src, tmp, (b) => onProgress({ ...base, bytes: b, size: st.size, status: 'copiando' }));

      let status = 'novo';
      if (fs.existsSync(target)) {
        const old = reg.files[name]?.sha256 || await hashFile(target);
        if (old === sha) {
          await fs.promises.unlink(tmp);
          results.push({ name, status: 'igual', message: 'mesmo conteúdo da planilha já importada' });
          onProgress({ ...base, bytes: st.size, size: st.size, status: 'igual' });
          continue;
        }
        const bak = path.join(dir, '_substituidas');
        fs.mkdirSync(bak, { recursive: true });
        await fs.promises.rename(target, path.join(bak, `${path.parse(name).name}_${stamp()}.xlsx`));
        status = 'atualizado';
      }
      await fs.promises.rename(tmp, target);
      const entry = { sha256: sha, size: st.size, importedAt: new Date().toISOString(), source: src };
      reg.files[name] = entry;
      reg.history.push({ name, status, ...entry });
      writeReg(ws, reg);
      results.push({
        name, status,
        message: (status === 'atualizado' ? 'substituiu a versão anterior (guardada em _substituidas)' : 'importada')
          + (STD.test(name) ? '' : ' · nome fora do padrão VeiculosSubtraidos_AAAA.xlsx'),
      });
      onProgress({ ...base, bytes: st.size, size: st.size, status });
    } catch (e) {
      try { fs.unlinkSync(path.join(dir, name + '.part')); } catch { /* nada a limpar */ }
      results.push({ name, status: 'erro', message: e.message });
      onProgress({ ...base, status: 'erro', message: e.message });
    }
  }
  return results;
}

/** Tira a planilha do processamento, movendo para dados_ssp/_removidas (não apaga). */
async function remove(ws, name) {
  const dir = sspDir(ws);
  const safe = path.basename(String(name));
  const src = path.join(dir, safe);
  if (!/\.xlsx$/i.test(safe) || !fs.existsSync(src)) throw new Error('Planilha não encontrada: ' + safe);
  const dst = path.join(dir, '_removidas');
  fs.mkdirSync(dst, { recursive: true });
  await fs.promises.rename(src, path.join(dst, `${path.parse(safe).name}_${stamp()}.xlsx`));
  const reg = readReg(ws);
  delete reg.files[safe];
  reg.history.push({ name: safe, status: 'removido', at: new Date().toISOString() });
  writeReg(ws, reg);
  return true;
}

module.exports = { list, scanFolder, importFiles, remove };
