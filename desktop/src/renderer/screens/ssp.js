// Dados SSP: o operador importa as planilhas escolhendo arquivos, escolhendo a pasta
// onde elas estão ou arrastando para cá. O app copia para a pasta de trabalho.
import { store, call, refreshWorkspace } from '../lib/store.js';
import { confirmar } from '../lib/dialog.js';
import { icon } from '../lib/icons.js';
import { esc, fmtBytes, fmtDate, toast } from '../lib/dom.js';
import { phaseHead, animCard, phaseNav } from './phase.js';
import { newSheetBox } from '../components/new-sheet.js';

const STATUS_TXT = { novo: 'importada', atualizado: 'atualizada', igual: 'sem mudança', erro: 'erro' };

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('ssp', `<div class="btn-row">
        <button class="btn" data-act="folder">${icon('folder')} Importar uma pasta…</button>
        <button class="btn primary" data-act="files">${icon('ssp')} Importar planilhas…</button></div>`, { nextLabel: 'Limpeza', nextDisabled: true, nextTitle: 'Importe ao menos uma planilha' })}
    <div class="dropzone" id="drop" tabindex="0" role="button" aria-label="Arraste planilhas ou uma pasta para importar">
      ${icon('ssp')}
      <div><b>Arraste as planilhas da SSP para cá</b><br>
      <span class="muted">Arquivos .xlsx (VeiculosSubtraidos_AAAA.xlsx) ou uma pasta inteira. O original não é alterado.</span></div>
    </div>
    <div class="card" id="progress" hidden>
      <h2>Importando</h2>
      <div class="prog-label"><span id="prog-name"></span><span id="prog-info" class="num"></span></div>
      <div class="prog-track"><i id="prog-bar"></i></div>
    </div>
    <div class="card" id="results" hidden></div>
    <div class="card next-card" id="next" hidden></div>
    <div class="card" id="newsheet" hidden></div>
    <div class="card">
      <h2>Planilhas na pasta de trabalho <span class="muted" id="count" style="text-transform:none;letter-spacing:0;font-weight:500"></span></h2>
      <div id="table"></div>
      <div class="btn-row" style="margin-top:12px"><button class="btn" data-act="open">${icon('folder')} Abrir pasta</button></div>
    </div>
    ${animCard('ssp')}`;

  const $ = (s) => el.querySelector(s);
  let busy = false;

  function renderTable(files) {
    renderNext(files);
    $('#count').textContent = files.length ? `· ${files.length} arquivo(s), ${fmtBytes(files.reduce((s, f) => s + f.size, 0))}` : '';
    if (!files.length) {
      $('#table').innerHTML = '<div class="empty">Nenhuma planilha importada ainda. Use os botões acima ou arraste os arquivos.</div>';
      return;
    }
    const years = files.map((f) => Number(f.year)).filter(Boolean).sort();
    const gaps = [];
    for (let y = years[0]; y <= years[years.length - 1]; y++) if (!years.includes(y)) gaps.push(y);
    $('#table').innerHTML = `
      ${gaps.length ? `<p style="color:var(--warn);margin-bottom:10px">Faltam os anos ${gaps.join(', ')}.</p>` : ''}
      <table class="tbl">
        <thead><tr><th>Ano</th><th>Arquivo</th><th class="r">Tamanho</th><th>Importada em</th><th>Origem</th><th></th></tr></thead>
        <tbody>${files.map((f) => `<tr>
          <td><b>${esc(f.year || '—')}</b></td>
          <td class="mono">${esc(f.name)}${f.standard ? '' : ' <span class="pill" data-status="partial">nome fora do padrão</span>'}</td>
          <td class="r num">${fmtBytes(f.size)}</td>
          <td>${f.importedAt ? fmtDate(Date.parse(f.importedAt)) : fmtDate(f.mtime)}</td>
          <td class="muted mono ellipsis" title="${esc(f.source || '')}">${esc(f.source || '—')}</td>
          <td class="r"><button class="icon-btn" data-remove="${esc(f.name)}" title="Tirar do processamento">${icon('x')}</button></td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  // Depois da importação: chamada clara para o passo seguinte
  let reading = null;
  function renderNewSheet() {
    const html = newSheetBox(store.get().ws);
    const box = $('#newsheet');
    box.hidden = !html;
    box.innerHTML = html;
    // com o quadro da planilha nova, o "Próximo passo" genérico sai (o quadro já leva à Limpeza)
    if (html) $('#next').hidden = true;
  }
  const offWsNs = store.subscribe((_s, why) => { if (why === 'ws') renderNewSheet(); });

  function renderNext(files) {
    const box = $('#next');
    box.hidden = !files.length;
    if (!files.length) return;
    const nav = el.querySelector('.phase-nav [data-go="clean"]');
    if (nav) nav.disabled = false;
    if (newSheetBox(store.get().ws)) { box.hidden = true; return; }
    box.innerHTML = `<div class="next">
        <div class="txt"><b>Planilhas prontas. Próximo passo: Limpeza</b>
        <span class="muted">${reading ? esc(reading) : 'Escolha o que entra na base: furto, roubo ou recuperados e os tipos de veículo.'}</span></div>
        <button class="btn primary" data-go="clean">Próximo: Limpeza ${icon('chevron-right')}</button>
      </div>`;
  }
  const offProfile = window.pc.on('ssp:profile', (p) => {
    reading = p.state === 'lendo' ? `Lendo ${p.name} (${p.index} de ${p.total}) para preparar as opções da Limpeza…` : null;
    if (p.state === 'pronto' && p.index === p.total) reading = null;
    const t = el.querySelector('#next .txt span');
    if (t) t.textContent = reading || 'Escolha o que entra na base: furto, roubo ou recuperados e os tipos de veículo.';
  });
  const offWsProg = window.pc.on('workspace:progress', (p) => {
    $('#progress').hidden = false;
    $('#prog-name').textContent = 'Preparando as pastas de cada etapa';
    $('#prog-info').textContent = p.msg || '';
    $('#prog-bar').style.width = '100%';
  });

  function showResults(results, stagesCreated = []) {
    const box = $('#results');
    const n = (s) => results.filter((r) => r.status === s).length;
    box.hidden = false;
    box.innerHTML = `<h2>Resultado da importação</h2>
      <p style="margin-bottom:8px">${n('novo')} nova(s) · ${n('atualizado')} atualizada(s) · ${n('igual')} sem mudança · ${n('erro')} com erro</p>
      <div class="checks">${results.map((r) => `<span class="check ${r.status === 'erro' ? 'no' : 'ok'}">${icon(r.status === 'erro' ? 'x' : 'check')}
        <b class="mono">${esc(r.name)}</b>&nbsp;— ${esc(STATUS_TXT[r.status])}: ${esc(r.message)}</span>`).join('')}</div>`;
    if (stagesCreated.length) {
      box.insertAdjacentHTML('beforeend', `<p class="muted" style="margin-top:10px">${icon('folder')} O app criou as pastas de cada etapa na pasta de trabalho (${stagesCreated.length}).</p>`);
    }
    const changed = n('novo') + n('atualizado');
    if (changed) toast(`${changed} planilha(s) importada(s). Veja abaixo o que roda de novo.`, 'ok');
    else if (n('erro')) toast('Nenhuma planilha importada. Veja os erros.', 'err');
  }

  async function run(fn) {
    if (busy) return;
    busy = true; el.classList.add('busy');
    try {
      const r = await fn();
      if (r) { renderTable(r.files); showResults(r.results, r.stagesCreated); await refreshWorkspace(); }
    } catch (e) { toast(e.message, 'err', 8000); }
    finally { busy = false; el.classList.remove('busy'); $('#progress').hidden = true; }
  }

  const offProg = window.pc.on('ssp:progress', (p) => {
    $('#progress').hidden = false;
    $('#prog-name').textContent = `${p.index}/${p.total} · ${p.name}`;
    const pct = p.size ? Math.round(((p.bytes || 0) / p.size) * 100) : 0;
    $('#prog-info').textContent = p.status === 'copiando' ? `${fmtBytes(p.bytes || 0)} de ${fmtBytes(p.size)}` : STATUS_TXT[p.status] || p.status;
    $('#prog-bar').style.width = `${p.status === 'copiando' ? pct : 100}%`;
  });

  el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const rm = e.target.closest('[data-remove]')?.dataset.remove;
    if (act === 'files') run(() => call('ssp:pickFiles'));
    if (act === 'folder') run(() => call('ssp:pickFolder'));
    if (act === 'open') call('workspace:open', 'dados_ssp').catch((err) => toast(err.message, 'err'));
    if (rm && await confirmar(`Tirar ${rm} do processamento?`, { detalhe: 'O arquivo vai para dados_ssp/_removidas e pode ser recuperado.', ok: 'Tirar do processamento', perigo: true })) {
      try { renderTable(await call('ssp:remove', rm)); await refreshWorkspace(); } catch (err) { toast(err.message, 'err'); }
    }
  });
  const drop = $('#drop');
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(() => call('ssp:pickFiles')); } });
  drop.addEventListener('click', () => run(() => call('ssp:pickFiles')));
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map((f) => window.pc.pathForFile(f)).filter(Boolean);
    if (paths.length) run(() => call('ssp:importPaths', paths));
  });

  call('ssp:list').then(renderTable).catch((e) => { $('#table').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
  renderNewSheet();
  return () => { offProg(); offProfile(); offWsProg(); offWsNs(); };
}
