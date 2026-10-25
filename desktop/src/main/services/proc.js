// Processos filhos: iniciar com saída linha a linha e encerrar a árvore inteira.
const { spawn, execFile } = require('child_process');

const isWin = process.platform === 'win32';

/**
 * Inicia um processo e entrega cada linha de stdout/stderr (UTF-8).
 * \r também quebra linha (barras de progresso). Devolve { child, done } — done resolve
 * com o código de saída.
 */
function startLines(cmd, args, { cwd, env, onLine = () => {} } = {}) {
  const child = spawn(cmd, args, { cwd, env, windowsHide: true, detached: !isWin });
  const pump = (stream, src) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line, src);
      }
    });
    stream.on('end', () => { if (buf.trim()) onLine(buf, src); });
  };
  pump(child.stdout, 'out');
  pump(child.stderr, 'err');
  const done = new Promise((resolve) => {
    child.on('error', (e) => { onLine(`[ERRO] ${e.message}`, 'err'); resolve(-1); });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 130 : -1)));
  });
  return { child, done };
}

/** Encerra o processo e todos os filhos (o treino abre 3 processos). */
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* já saiu */ } }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* já saiu */ } }, 5000).unref();
  }
}

/** Roda e devolve stdout (null se falhar ou passar do tempo). */
function capture(cmd, args, { cwd, env, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
      resolve(err ? null : { stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

module.exports = { startLines, killTree, capture, isWin };
