// Diagnóstico da máquina: processador, memória, placas de vídeo e disco da pasta de trabalho.
// Placas de vídeo: nvidia-smi (nome, VRAM exata, driver, CUDA) quando houver NVIDIA;
// no Windows, Win32_VideoController lista todas (Intel, AMD, NVIDIA); no Linux, lspci.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function nvidia() {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!out) return [];
  const cuda = await cudaVersion();
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const [name, mem, driver] = l.split(',').map((s) => s.trim());
    return { name, vendor: 'NVIDIA', vramMb: Number(mem) || null, driver, cuda: cuda || cudaFromDriver(driver), cudaGuessed: !cuda, source: 'nvidia-smi' };
  });
}

// Versão máxima de CUDA que o driver suporta. O cabeçalho do nvidia-smi muda entre
// versões do driver ("CUDA Version: 12.4", "CUDA Version : 13.0", "CUDA Driver Version"),
// então tenta os dois formatos de saída e aceita qualquer grafia.
const CUDA_RE = /CUDA(?:\s+Driver)?\s+Version\s*:\s*(\d+(?:\.\d+)?)/i;
async function cudaVersion() {
  for (const args of [[], ['-q']]) {
    const out = await run('nvidia-smi', args, 15000);
    const m = out && out.match(CUDA_RE);
    if (m) return m[1];
  }
  return null;
}

/** CUDA mínimo garantido pela versão do driver NVIDIA (quando o nvidia-smi não informa). */
function cudaFromDriver(driver) {
  const major = parseInt(String(driver || '').split('.')[0], 10);
  if (!major) return null;
  return major >= 580 ? '13.0' : major >= 570 ? '12.8' : major >= 560 ? '12.6' : major >= 550 ? '12.4' : major >= 520 ? '11.8' : null;
}

async function windowsGpus() {
  const ps = 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM,DriverVersion | ConvertTo-Json -Compress';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
  if (!out) return [];
  let rows; try { rows = JSON.parse(out); } catch { return []; }
  if (!Array.isArray(rows)) rows = [rows];
  return rows.filter((r) => r && r.Name && !/basic display|remote display|virtual/i.test(r.Name)).map((r) => ({
    name: r.Name.trim(),
    vendor: vendorOf(r.AdapterCompatibility || r.Name),
    // AdapterRAM é um inteiro de 32 bits: placas com mais de 4 GB aparecem como 4 GB
    vramMb: r.AdapterRAM ? Math.round(Number(r.AdapterRAM) / 1048576) : null,
    vramCapped: Number(r.AdapterRAM) >= 4293918720,
    driver: r.DriverVersion || null, source: 'Windows',
  }));
}

async function linuxGpus() {
  const out = await run('lspci', []);
  if (!out) return [];
  return out.split('\n').filter((l) => /VGA|3D controller|Display controller/i.test(l)).map((l) => {
    const name = l.replace(/^.*?(VGA compatible controller|3D controller|Display controller):\s*/i, '').trim();
    return { name, vendor: vendorOf(name), vramMb: null, driver: null, source: 'lspci' };
  });
}

function vendorOf(s) {
  // "Intel Corporation" contém "ati" (corpor-ATI-on): Intel antes de AMD e "ATI" como palavra
  if (/nvidia/i.test(s)) return 'NVIDIA';
  if (/intel/i.test(s)) return 'Intel';
  if (/\bamd\b|advanced micro|radeon|\bati\b/i.test(s)) return 'AMD';
  return s.split(' ')[0] || '—';
}

function diskOf(dir) {
  try {
    const st = fs.statfsSync(dir);
    return { freeGb: +((st.bavail * st.bsize) / 2 ** 30).toFixed(1), totalGb: +((st.blocks * st.bsize) / 2 ** 30).toFixed(1) };
  } catch { return null; }
}

/** Perfil inicial (limites a calibrar medindo o pico real de RAM do ETL e do treino). */
function verdict({ ramGb, gpus, disk }) {
  const cudaGpu = gpus.find((g) => g.vendor === 'NVIDIA' && (g.vramMb || 0) >= 3800);
  const lowDisk = disk && disk.freeGb < 15;
  if (ramGb < 7.5) return { profile: 'view', title: 'Só visualização', tone: 'warn', text: 'Pouca memória para processar. Dá para ver mapas, métricas e publicar resultados já gerados.' };
  if (ramGb < 15) return { profile: 'eco', title: 'Modo econômico', tone: 'warn', text: 'Dá para processar tudo, treinando um modelo por vez e uma área por vez. O treino fica mais lento.' };
  if (cudaGpu) return { profile: 'gpu', title: 'Completo com placa de vídeo', tone: 'ok', text: `Treino rápido usando a ${cudaGpu.name} (${Math.round(cudaGpu.vramMb / 1024)} GB). Os três modelos treinam em paralelo.${lowDisk ? ' Atenção: pouco espaço livre em disco.' : ''}` };
  return { profile: 'cpu', title: 'Completo sem placa de vídeo dedicada', tone: 'ok', text: `Tudo roda no processador; LSTM e Transformer levam mais tempo.${lowDisk ? ' Atenção: pouco espaço livre em disco.' : ''}` };
}

async function collect({ workspace } = {}) {
  const cpus = os.cpus();
  const [nv, list] = await Promise.all([
    nvidia(),
    process.platform === 'win32' ? windowsGpus() : process.platform === 'linux' ? linuxGpus() : Promise.resolve([]),
  ]);
  // junta: dados da nvidia-smi têm prioridade sobre a lista genérica
  const gpus = [...nv];
  for (const g of list) {
    if (g.vendor === 'NVIDIA' && nv.some((n) => g.name.includes(n.name) || n.name.includes(g.name.replace(/^NVIDIA\s*/i, '')))) continue;
    gpus.push(g);
  }
  const ramGb = +(os.totalmem() / 2 ** 30).toFixed(1);
  const disk = workspace ? diskOf(workspace) : null;
  const info = {
    cpu: { model: (cpus[0]?.model || '—').replace(/\s+/g, ' ').trim(), threads: cpus.length, speedMhz: cpus[0]?.speed || null, arch: os.arch() },
    ram: { totalGb: ramGb, freeGb: +(os.freemem() / 2 ** 30).toFixed(1) },
    gpus, nvidiaSmi: nv.length > 0,
    os: { platform: process.platform, release: os.release(), name: os.version ? os.version() : process.platform },
    disk, workspace: workspace || null,
    checkedAt: Date.now(),
  };
  info.verdict = verdict({ ramGb, gpus, disk });
  return info;
}

module.exports = { cudaFromDriver, CUDA_RE, collect };
