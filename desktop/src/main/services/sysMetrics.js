// Uso de CPU, memória e GPU (nvidia-smi) da máquina e do processo Python (barra de status).
const os = require('os');

let last = snapshot();
function snapshot() {
  let idle = 0, tot = 0;
  for (const c of os.cpus()) { for (const v of Object.values(c.times)) tot += v; idle += c.times.idle; }
  return { idle, tot };
}

function collect() {
  const now = snapshot();
  const dTot = now.tot - last.tot, dIdle = now.idle - last.idle;
  last = now;
  const GB = 1024 ** 3;
  return {
    cpuPct: dTot > 0 ? Math.round((1 - dIdle / dTot) * 100) : null,
    ramUsedGb: +((os.totalmem() - os.freemem()) / GB).toFixed(1),
    ramTotalGb: +(os.totalmem() / GB).toFixed(1),
    cores: os.cpus().length,
  };
}

module.exports = { collect };
