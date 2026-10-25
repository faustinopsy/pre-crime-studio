// Ambiente: o que esta máquina tem, o que ela consegue rodar e o Python do pipeline
// (verificar, preparar sozinho com um botão ou usar um Python que o operador já tenha).
import { store, call } from '../lib/store.js';
import { confirmar } from '../lib/dialog.js';
import { icon } from '../lib/icons.js';
import { esc, fmtDate, fmtBytes, toast } from '../lib/dom.js';
import { phaseHead } from './phase.js';

// Estado da preparação, fora da tela: continua valendo se o operador sair e voltar.
const STEPS = [
  ['uv', 'Instalador (uv)'], ['python', 'Python 3.12'], ['venv', 'Ambiente isolado do app'],
  ['packages', 'Pacotes científicos'], ['torch', 'PyTorch (redes neurais)'], ['check', 'Conferência'],
];
let INST = null; // { running, steps: {id: {state,msg}}, lines: [], download, error, startedAt }
const listeners = new Set();
window.pc.on('env:install', (ev) => {
  if (!INST) INST = { running: true, steps: {}, lines: [], download: null, error: null, startedAt: Date.now() };
  if (ev.t === 'step') INST.steps[ev.id] = { state: ev.state, msg: ev.msg };
  if (ev.t === 'line') { INST.lines.push(ev); if (INST.lines.length > 600) INST.lines.splice(0, INST.lines.length - 600); }
  if (ev.t === 'download') INST.download = ev;
  if (ev.t === 'finished') INST.running = false;
  if (ev.t === 'failed') {
    INST.error = ev.msg; INST.running = false; INST.cancelled = ev.cancelled;
    for (const st of Object.values(INST.steps)) if (st.state === 'running') st.state = ev.cancelled ? 'pending' : 'error';
  }
  for (const fn of listeners) fn();
});

export function mount(el) {
  el.innerHTML = `${phaseHead('env', `<button class="btn" data-act="check">${icon('refresh')} Verificar de novo</button>`)}
    <div id="py"></div>
    <div id="install"></div>
    <div id="body"><div class="empty">Verificando esta máquina…</div></div>`;
  const body = el.querySelector('#body');
  const pyBox = el.querySelector('#py');
  const instBox = el.querySelector('#install');

  const gb = (mb) => (mb ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1).replace('.', ',')} GB` : '—');
  const render = (hw) => {
    const v = hw.verdict;
    body.innerHTML = `
      <div class="verdict" data-tone="${v.tone}">
        ${icon(v.tone === 'ok' ? 'check' : 'half')}
        <div><b>${esc(v.title)}</b><span>${esc(v.text)}</span></div>
      </div>
      <div class="cards">
        <div class="card hw">
          <h2>${icon('env')} Processador</h2>
          <div class="hw-main">${esc(hw.cpu.model)}</div>
          <dl class="kv"><dt>Núcleos lógicos</dt><dd class="num">${hw.cpu.threads}</dd>
            <dt>Frequência base</dt><dd class="num">${hw.cpu.speedMhz ? (hw.cpu.speedMhz / 1000).toFixed(2).replace('.', ',') + ' GHz' : '—'}</dd>
            <dt>Arquitetura</dt><dd>${esc(hw.cpu.arch)}</dd></dl>
        </div>
        <div class="card hw">
          <h2>${icon('features')} Memória</h2>
          <div class="hw-main">${String(hw.ram.totalGb).replace('.', ',')} GB</div>
          <dl class="kv"><dt>Livre agora</dt><dd class="num">${String(hw.ram.freeGb).replace('.', ',')} GB</dd>
            <dt>Recomendado</dt><dd>16 GB ou mais</dd></dl>
        </div>
        <div class="card hw">
          <h2>${icon('folder')} Disco da pasta de trabalho</h2>
          <div class="hw-main">${hw.disk ? `${String(hw.disk.freeGb).replace('.', ',')} GB livres` : '—'}</div>
          <dl class="kv"><dt>Total</dt><dd class="num">${hw.disk ? String(hw.disk.totalGb).replace('.', ',') + ' GB' : '—'}</dd>
            <dt>Necessário</dt><dd>cerca de 15 GB</dd></dl>
        </div>
      </div>
      <div class="card">
        <h2>${icon('train')} Placas de vídeo</h2>
        ${hw.gpus.length ? `<table class="tbl">
          <thead><tr><th>Placa</th><th>Fabricante</th><th class="r">Memória de vídeo</th><th>Driver</th><th>Uso no treino</th></tr></thead>
          <tbody>${hw.gpus.map((g) => {
            const cuda = g.vendor === 'NVIDIA' && g.source === 'nvidia-smi';
            return `<tr><td><b>${esc(g.name)}</b></td><td>${esc(g.vendor)}</td>
              <td class="r num">${gb(g.vramMb)}${g.vramCapped ? '+' : ''}</td><td class="mono">${esc(g.driver || '—')}</td>
              <td>${cuda ? `<span class="pill" data-status="done">${icon('check')}CUDA ${esc(g.cuda || '')}</span>`
                : g.vendor === 'NVIDIA' ? '<span class="pill" data-status="partial">instale o driver NVIDIA</span>'
                : '<span class="pill" data-status="pending">não usada (sem CUDA)</span>'}</td></tr>`;
          }).join('')}</tbody></table>
          <p class="note">LSTM e Transformer usam a placa de vídeo quando ela é NVIDIA com CUDA. O Random Forest sempre usa o processador.</p>`
          : '<div class="empty">Nenhuma placa de vídeo identificada. O treino roda no processador.</div>'}
      </div>
      <p class="muted" style="font-size:12px;margin-top:10px">Verificado em ${fmtDate(hw.checkedAt)}</p>`;
  };

  async function check() {
    try { const hw = await call('env:hardware'); store.set({ hardware: hw }, 'hw'); render(hw); }
    catch (e) { body.innerHTML = `<div class="empty">Não consegui verificar a máquina.<br>${esc(e.message)}</div>`; }
  }
  // ── Python do pipeline ──────────────────────────────────────────────────────
  const gpuName = () => store.get().hardware?.gpus?.find((g) => g.vendor === 'NVIDIA' && g.source === 'nvidia-smi')?.name;
  function renderPy() {
    const py = store.get().python;
    if (!py) { pyBox.innerHTML = `<div class="card py-card"><h2>${icon('env')} Python do pipeline</h2><p class="muted">Verificando o Python (importar os pacotes leva alguns segundos)…</p></div>`; return; }
    const running = INST?.running;
    const gpu = gpuName();
    const tone = py.state === 'ready' ? 'done' : py.state === 'partial' ? 'partial' : py.state === 'missing' ? 'pending' : 'error';
    const label = { ready: 'Pronto', partial: 'Incompleto', missing: 'Não preparado', broken: 'Com problema' }[py.state];
    const t = py.torch;
    const torchLine = !py.packages?.torch?.ok ? 'PyTorch não instalado: Treino, Previsão e Validação ainda não podem rodar.'
      : t?.cuda_available ? `PyTorch ${esc(t.version)} usando a placa de vídeo <b>${esc(t.device)}</b>.`
      : `PyTorch ${esc(t?.version || py.packages.torch.version)} só no processador.`;
    // placa NVIDIA presente, mas o PyTorch instalado não a usa
    const gpuIdle = gpu && py.packages?.torch?.ok && !t?.cuda_available;
    const gpuCallout = !gpuIdle ? '' : `<div class="callout" data-tone="warn">${icon('warn')}<div>
        Este computador tem a <b>${esc(gpu)}</b>, mas ${t?.built_cuda
          ? 'o PyTorch não conseguiu usá-la. Atualize o driver da NVIDIA e clique em <b>Verificar o Python</b>.'
          : 'o PyTorch instalado é a versão só para processador: LSTM e Transformer treinam bem mais devagar.'}
        <div class="btn-row" style="margin-top:8px"><button class="btn primary" data-py="torch-gpu" ${running ? 'disabled' : ''}>${icon('play')} Instalar o PyTorch para a placa de vídeo</button>
        <span class="muted small">Troca só o PyTorch (cerca de 2,5 GB). Os outros pacotes ficam como estão.</span></div></div></div>`;
    const pk = py.requirements || Object.keys(py.packages || {});
    pyBox.innerHTML = `<div class="card py-card" data-state="${py.state}">
      <h2>${icon('env')} Python do pipeline <span class="pill" data-status="${tone}">${esc(label)}</span></h2>
      ${py.state === 'missing' ? `<p>O app ainda não tem o Python que roda o pipeline. <b>Preparar ambiente</b> instala tudo sozinho, sem mexer no Python do computador:
          Python 3.12, os pacotes científicos e o PyTorch ${gpu ? `para a sua <b>${esc(gpu)}</b>` : 'para o processador'}.</p>
          <p class="muted" style="margin-top:6px">Download de ${gpu ? 'cerca de 3 GB' : 'cerca de 600 MB'}; leva de 5 a 20 minutos, conforme a internet. Fica em <span class="mono">${esc(py.root)}</span>.</p>`
      : py.state === 'broken' ? `<p>${esc(py.message || 'O Python configurado não respondeu.')}</p><p class="muted mono">${esc(py.python?.path || '')}</p>`
      : `<p><b>Python ${esc(py.python.version)}</b> · ${py.python.origin === 'app' ? 'ambiente do app' : 'Python escolhido por você'}
          <span class="muted mono" style="margin-left:6px">${esc(py.python.path)}</span></p>
         <p style="margin-top:4px">${torchLine}</p>
         ${gpuCallout}
         ${py.missing.length ? `<div class="callout" data-tone="warn">${icon('warn')}<div>Falta${py.missing.length > 1 ? 'm' : ''}: <b>${esc(py.missing.join(', '))}</b>.
            ${py.jobs?.clean ? 'A Limpeza já pode rodar.' : ''} Use <b>Preparar ambiente</b> para completar.</div></div>` : ''}
         ${py.python.okVersion === false ? `<div class="callout" data-tone="warn">${icon('warn')}<div>O pipeline foi testado com Python 3.10 a 3.13.</div></div>` : ''}`}
      <div class="btn-row" style="margin-top:14px">
        ${py.state !== 'ready' ? `<button class="btn primary" data-py="install" ${running ? 'disabled' : ''}>${icon('play')} Preparar ambiente</button>` : ''}
        <button class="btn" data-py="pick" ${running ? 'disabled' : ''}>${icon('folder')} Usar um Python que já tenho…</button>
        <button class="btn" data-py="recheck" ${running ? 'disabled' : ''}>${icon('refresh')} Verificar o Python</button>
        ${py.state === 'ready' || py.python?.origin === 'app' ? `<button class="btn" data-py="reinstall" ${running ? 'disabled' : ''}>${icon('undo')} Refazer do zero</button>` : ''}
        <span class="spacer"></span>
        <label class="field inline">PyTorch
          <select id="torch-choice" ${running ? 'disabled' : ''}>
            <option value="auto">Automático (recomendado)</option>
            <option value="cuda">Placa de vídeo NVIDIA (CUDA)</option>
            <option value="cpu">Só processador</option>
          </select></label>
      </div>
      ${pk.length && py.python ? `<details class="pk"><summary>Pacotes (${pk.length - py.missing.length} de ${pk.length} instalados)</summary>
        <div class="pk-grid">${pk.map((n) => { const p = py.packages?.[n]; return `<span class="pk-item ${p?.ok ? 'ok' : 'no'}" title="${esc(p?.ok ? '' : p?.error || 'não instalado')}">${icon(p?.ok ? 'check' : 'x')}${esc(n)} <i class="num">${esc(p?.ok ? p.version : '—')}</i></span>`; }).join('')}</div></details>` : ''}
      ${py.foraDoLock?.length ? `<div class="callout" data-tone="warn">${icon('warn')}<div><b>Versões diferentes das fixadas pelo app:</b>
        ${py.foraDoLock.map((x) => `${esc(x.pacote)} ${esc(x.instalado)} (fixada: ${esc(x.fixado)})`).join(' · ')}.
        Os resultados podem diferir um pouco dos da dissertação. <b>Refazer do zero</b> instala as versões fixadas.</div></div>` : ''}
      <details class="pk"><summary>Versões fixas e internet</summary>
        <p class="note">Para os resultados serem reprodutíveis, o app instala sempre as mesmas versões: Python ${esc(py.versoesFixas?.python || '3.12')},
          o instalador uv ${esc(py.versoesFixas?.uv || '')}, os pacotes de <span class="mono">${esc(py.versoesFixas?.arquivo || 'requirements.txt')}</span>
          e o PyTorch ${esc(py.versoesFixas?.torch || '')}. Cada execução registra no manifesto as versões que usou e se usou a placa de vídeo.</p>
        <p class="note"><b>Precisa de internet:</b> preparar o ambiente (baixa o uv, o Python, os pacotes e o PyTorch: cerca de 600 MB só com processador
          e 3 GB com placa de vídeo), baixar ruas e pontos de interesse ao criar uma área nova e o fundo de mapa da CARTO.
          <b>Funciona sem internet:</b> importar planilhas, Limpeza, Filtragem, Features, Treino, Previsão, Validação, Modo científico, o mapa
          (com o fundo das ruas da área) e a publicação.</p></details>
    </div>`;
  }

  function renderInstall() {
    if (!INST) { instBox.innerHTML = ''; return; }
    const done = STEPS.filter(([id]) => ['done', 'skipped'].includes(INST.steps[id]?.state)).length;
    const cur = STEPS.find(([id]) => INST.steps[id]?.state === 'running');
    const dl = INST.download && INST.download.total ? ` · ${fmtBytes(INST.download.bytes)} de ${fmtBytes(INST.download.total)}` : '';
    const ok = !INST.running && !INST.error;
    instBox.innerHTML = `<div class="card run-card" data-state="${INST.running ? 'running' : ok ? 'ok' : 'error'}">
      <h2>Preparando o ambiente <span class="pill" data-status="${INST.running ? 'running' : ok ? 'done' : INST.cancelled ? 'stale' : 'error'}">${INST.running ? 'Em andamento' : ok ? 'Concluído' : INST.cancelled ? 'Cancelado' : 'Falhou'}</span>
        <span class="spacer"></span><span class="num run-time"></span></h2>
      <ol class="inst-steps">${STEPS.map(([id, l]) => { const st = INST.steps[id]?.state || 'pending';
        return `<li data-state="${st}"><span class="dotc">${st === 'done' || st === 'skipped' ? icon('check') : st === 'error' ? icon('x') : ''}</span><div><b>${esc(l)}</b>${INST.steps[id]?.msg ? `<span class="muted">${esc(INST.steps[id].msg)}</span>` : ''}</div></li>`; }).join('')}</ol>
      <div class="prog-label" style="margin-top:12px"><span>${cur ? esc(cur[1]) + dl : ok ? 'Tudo pronto' : INST.error ? esc(INST.error) : ''}</span><span class="num">${done} de ${STEPS.length}</span></div>
      <div class="prog-track ${INST.running ? 'busy' : ''}"><i style="width:${Math.max(4, (done / STEPS.length) * 100)}%"></i></div>
      <details class="run-log" ${INST.error && !INST.cancelled ? 'open' : ''}><summary>Detalhes da instalação (${INST.lines.length} linhas)</summary>
        <div class="loglist">${INST.lines.slice(-250).map((l) => `<div class="logline" data-level="${l.level}"><span class="msg">${esc(l.text)}</span></div>`).join('')}</div></details>
      <div class="btn-row" style="margin-top:12px">
        ${INST.running ? `<button class="btn" data-py="cancel">${icon('x')} Cancelar</button>` : `<button class="btn" data-py="dismiss">Fechar</button>`}
        <button class="btn" data-py="openroot">${icon('folder')} Abrir pasta do ambiente</button>
      </div></div>`;
    const lg = instBox.querySelector('.loglist'); if (lg) lg.scrollTop = lg.scrollHeight;
    tick();
  }
  const tick = () => { const t = instBox.querySelector('.run-time'); if (t && INST) t.textContent = fmtElapsed((Date.now() - INST.startedAt) / 1000); };
  const tickTimer = setInterval(() => { if (INST?.running) tick(); }, 1000);

  let raf = 0;
  const onInst = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderInstall(); renderPy(); }); };
  listeners.add(onInst);

  async function install(reinstall, only) {
    const torch = only ? 'cuda' : el.querySelector('#torch-choice')?.value || 'auto';
    if (reinstall && !(await confirmar('Refazer o ambiente do app do zero?', { detalhe: 'Os pacotes são baixados de novo (o cache local ajuda).', ok: 'Refazer o ambiente' }))) return;
    INST = { running: true, steps: {}, lines: [], download: null, error: null, startedAt: Date.now() };
    onInst();
    try {
      const st = await call('env:install', { torch, reinstall, onlyTorch: !!only });
      INST.running = false;
      store.set({ python: st }, 'python');
      toast(st.torch && !st.torch.cuda_available && gpuName() ? 'Ambiente pronto, mas o PyTorch ainda não usa a placa de vídeo. Veja os detalhes da instalação.' : 'Ambiente pronto. Já dá para executar as fases.', st.torch && !st.torch.cuda_available && gpuName() ? 'warn' : 'ok', 10000);
    } catch (e) {
      if (INST) { INST.running = false; INST.error = INST.error || e.message; }
      if (!/cancelad/i.test(e.message)) toast(e.message, 'err', 10000);
    }
    onInst();
  }

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="check"]')) { body.innerHTML = '<div class="empty">Verificando esta máquina…</div>'; check(); recheck(); }
    const act = e.target.closest('[data-py]')?.dataset.py;
    if (!act) return;
    try {
      if (act === 'install') install(false);
      if (act === 'reinstall') install(true);
      if (act === 'torch-gpu') install(false, true);
      if (act === 'cancel') await call('env:installCancel');
      if (act === 'dismiss') { INST = null; onInst(); }
      if (act === 'openroot') await call('env:openRoot');
      if (act === 'recheck') recheck();
      if (act === 'pick') {
        const st = await call('env:pickPython');
        if (st) { store.set({ python: st }, 'python'); toast(st.state === 'ready' ? `Usando o Python ${st.python.version} escolhido.` : `Python escolhido; falta: ${st.missing.join(', ')}`, st.state === 'ready' ? 'ok' : 'err', 8000); }
      }
    } catch (err) { toast(err.message, 'err', 8000); }
  });
  async function recheck() {
    store.set({ python: null }, 'python');
    try { store.set({ python: await call('env:python', true) }, 'python'); } catch (err) { toast(err.message, 'err'); }
  }
  const off = store.subscribe((_s, why) => { if (why === 'python' || why === 'hw') renderPy(); });

  const cached = store.get().hardware;
  if (cached) render(cached); else check();
  renderPy(); renderInstall();
  return () => { off(); listeners.delete(onInst); clearInterval(tickTimer); cancelAnimationFrame(raf); };
}

const fmtElapsed = (s) => { s = Math.round(s); return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`; };
