// Publicação: o pacote para o servidor Node (escolher → montar e verificar → pré-visualizar →
// exportar), o histórico de pacotes e as outras saídas (GeoJSON para o geojson.io e imagens PNG).
import { store, call, refreshWorkspace } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { seloPersonalizado } from '../lib/padrao.js';
import { esc, fmtBytes, toast, scrollToEl, fmtDate } from '../lib/dom.js';
import { phaseHead, animCard } from './phase.js';

const MODEL_LABEL = { Ensemble: 'Ensemble', RF: 'Random Forest', LSTM: 'LSTM', Transformer: 'Transformer' };
const monthLabel = (t) => t.split('_').reverse().join('/');
import { areaLabel } from '../components/run-panel.js';
const ETAPA = {
  previsoes: 'Separando geometria e risco das previsões', mes: 'Crimes reais, histórico e scores das células', metricas: 'Métricas dos meses escolhidos',
  ruas: 'Ruas para o mapa sem internet', servidor: 'Copiando o servidor e o painel', manifesto: 'Calculando o sha256 de cada arquivo',
  arquivos: 'Conferindo os arquivos', rotas: 'Comparando cada rota com o mapa interno', zip: 'Compactando (.zip)', pronto: 'Pronto',
};
const DEVICES = [['desktop', 'Computador', null], ['tablet', 'Tablet', 820], ['phone', 'Celular', 390]];
const PREF = 'precrime.publish.sel';
const loadSel = () => { try { return JSON.parse(localStorage.getItem(PREF)) || null; } catch { return null; } };
const saveSel = (s) => { try { localStorage.setItem(PREF, JSON.stringify(s)); } catch { /* sem armazenamento */ } };

// estado do módulo: sobrevive à troca de tela enquanto a montagem roda
let JOB = null;      // { running, etapa, done, total, arquivo, error }
let LAST = null;     // resultado da última montagem { id, dir, manifest, verify, exported? }

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('publish', '')}
    <section class="card" id="pkg"><h2>${icon('publish')} Pacote para o servidor</h2><div class="empty">Carregando…</div></section>
    <section class="card" id="job" hidden></section>
    <section class="card" id="preview" hidden></section>
    <section class="card" id="hist"></section>
    <h2 class="section-title">Outras saídas</h2>
    <div class="card" id="geo"><h2>${icon('map')} Exportar GeoJSON</h2><div class="empty">Carregando…</div></div>
    <div class="card tip">
      <h2>${icon('external')} Ver o GeoJSON sem instalar nada</h2>
      <ol class="tip-list">
        <li>Exporte o mês no quadro acima. O app grava em <span class="mono">publish\\geojson\\AAAA-MM</span> dentro da pasta de trabalho e abre a pasta.</li>
        <li>Abra o <a href="https://geojson.io" target="_blank" rel="noopener">geojson.io</a> no navegador.</li>
        <li>Arraste o arquivo <span class="mono">.geojson</span> para cima do mapa. As cores já vêm no arquivo: vermelho é alto risco, amarelo é médio.</li>
        <li>Clique numa célula para ver o score e o período. O mesmo arquivo abre no QGIS e no Google My Maps.</li>
      </ol>
    </div>
    <div class="card tip">
      <h2>${icon('map')} Imagem da previsão (PNG)</h2>
      <p class="muted">No <b>Mapa</b>, escolha área, modelo e mês e use <b>Baixar imagem</b>. A imagem sai com título, legenda e os números do mês, pronta para relatório, e fica em <span class="mono">publish\\imagens</span> na pasta de trabalho.</p>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-go="map">${icon('map')} Ir para o Mapa</button>
        <button class="btn" data-open="publish/imagens">${icon('folder')} Abrir pasta das imagens</button></div>
    </div>
    ${animCard('publish')}`;
  const $ = (s) => el.querySelector(s);
  let opt = null;
  let device = 'desktop';
  let previewUrl = null;

  // ── 1. o que publicar ───────────────────────────────────────────────────────
  function renderForm() {
    const box = $('#pkg');
    if (!opt) return;
    if (!opt.months.length) {
      box.innerHTML = `<h2>${icon('publish')} Pacote para o servidor</h2><div class="empty">Ainda não há previsões para publicar.
        <div class="btn-row" style="justify-content:center;margin-top:12px"><button class="btn primary" data-go="predict">${icon('chevron-left')} Ir para Previsão</button></div></div>`;
      return;
    }
    const prev = loadSel() || {};
    const tags = prev.tags?.filter((t) => opt.months.some((m) => m.tag === t)) || [opt.months[0].tag];
    const allAreas = [...new Set(opt.months.flatMap((m) => m.areas))].sort();
    const allModels = ['Ensemble', 'RF', 'LSTM', 'Transformer'].filter((x) => opt.months.some((m) => m.models.includes(x)));
    const areas = prev.areas?.filter((a) => allAreas.includes(a)) || allAreas;
    const models = prev.models?.filter((m) => allModels.includes(m)) || allModels;
    const busy = JOB?.running;
    const dis = busy ? 'disabled' : '';
    box.innerHTML = `<h2>${icon('publish')} Pacote para o servidor</h2>
      <p class="muted" style="margin-bottom:14px">Gera uma pasta com o mapa e só os dados escolhidos, que roda em qualquer servidor com <b>node server.js</b> (sem instalar nada). Antes de exportar, o app confere cada arquivo e compara cada rota com o mapa interno.</p>
      <div class="pub-grid">
        <fieldset><legend>Meses</legend>${opt.months.map((m) => `<label class="chk"><input type="checkbox" name="p-tag" value="${m.tag}" ${tags.includes(m.tag) ? 'checked' : ''} ${dis}>
          <b>${esc(m.label)}</b> ${m.validated.length ? `<span class="pill" data-status="done">${icon('check')}validado</span>` : '<span class="pill" data-status="pending">sem validação</span>'}${seloPersonalizado(m.personalizado)}</label>`).join('')}</fieldset>
        <fieldset><legend>Áreas</legend>${allAreas.map((a) => `<label class="chk"><input type="checkbox" name="p-area" value="${a}" ${areas.includes(a) ? 'checked' : ''} ${dis}> ${esc(areaLabel(a))}</label>`).join('')}</fieldset>
        <fieldset><legend>Modelos</legend>${allModels.map((m) => `<label class="chk"><input type="checkbox" name="p-model" value="${m}" ${models.includes(m) ? 'checked' : ''} ${dis}> ${esc(MODEL_LABEL[m])}</label>`).join('')}</fieldset>
        <fieldset><legend>Incluir</legend>
          <label class="chk"><input type="checkbox" id="p-crimes" ${prev.crimes !== false ? 'checked' : ''} ${dis}> Crimes reais (pontos no mapa)</label>
          <label class="chk"><input type="checkbox" id="p-metricas" ${prev.metricas !== false ? 'checked' : ''} ${dis}> Métricas (painel Desempenho)</label>
          <label class="chk" title="${opt.streets.length ? '' : 'A pasta de trabalho não tem as ruas das áreas.'}"><input type="checkbox" id="p-ruas" ${prev.ruas && opt.streets.length ? 'checked' : ''} ${busy || !opt.streets.length ? 'disabled' : ''}> Ruas para o mapa sem internet <span class="muted">(+1 a 2 MB por área)</span></label>
          <label class="chk" title="${opt.pois?.length ? '' : 'A pasta de trabalho não tem os pontos de interesse das áreas.'}"><input type="checkbox" id="p-pois" ${prev.pois && opt.pois?.length ? 'checked' : ''} ${busy || !opt.pois?.length ? 'disabled' : ''}> Pontos de interesse <span class="muted">(bares, bancos, polícia…; o visitante liga por categoria)</span></label>
        </fieldset>
        <fieldset><legend>Fundo do mapa</legend>
          <label class="chk"><input type="radio" name="p-fundo" value="ruas" ${!(prev.fundoCarto && opt.basemap?.temChave) ? 'checked' : ''} ${dis}> Ruas da área <span class="muted">(sem chave; as ruas vão no pacote)</span></label>
          <label class="chk" title="${opt.basemap?.temChave ? '' : 'Adicione a chave da CARTO na tela Previsão.'}"><input type="radio" name="p-fundo" value="carto" ${prev.fundoCarto && opt.basemap?.temChave ? 'checked' : ''} ${busy || !opt.basemap?.temChave ? 'disabled' : ''}> CARTO com a sua chave</label>
          <p class="muted small">${opt.basemap?.temChave
            ? 'Com a CARTO, a chave fica visível para quem abrir o site. No painel da CARTO, restrinja a chave ao endereço do site.'
            : 'Para o fundo completo da CARTO, salve a chave em <button class="link-btn" data-go="predict" type="button">Previsão</button>.'}</p>
        </fieldset>
      </div>
      <div class="pub-texts">
        <label class="field">Título do site<input id="p-titulo" maxlength="80" value="${esc(opt.site.titulo)}" ${dis}></label>
        <label class="field">Apresentação <span class="muted">(opcional, aparece abaixo do título)</span><textarea id="p-apres" rows="2" maxlength="600" ${dis}>${esc(opt.site.apresentacao)}</textarea></label>
        <label class="field"><span>Aviso de uso responsável <button class="link-btn" data-act="aviso-padrao" type="button">restaurar o texto padrão</button></span><textarea id="p-aviso" rows="3" maxlength="800" ${dis}>${esc(opt.site.aviso)}</textarea></label>
      </div>
      <div class="exec-row" style="margin-top:14px">
        ${busy ? `<button class="btn" data-act="cancel">${icon('x')} Cancelar</button>` : `<button class="btn primary" data-act="build">${icon('play')} Montar e verificar</button>`}
        <span class="muted" id="p-note"></span>
      </div>`;
    note();
  }
  function selection() {
    const pick = (n) => [...el.querySelectorAll(`input[name="${n}"]:checked`)].map((i) => i.value);
    return {
      tags: pick('p-tag'), areas: pick('p-area'), models: pick('p-model'),
      crimes: $('#p-crimes')?.checked, metricas: $('#p-metricas')?.checked, ruas: $('#p-ruas')?.checked, pois: $('#p-pois')?.checked,
      fundoCarto: el.querySelector('input[name="p-fundo"]:checked')?.value === 'carto',
      site: { titulo: $('#p-titulo')?.value, apresentacao: $('#p-apres')?.value, aviso: $('#p-aviso')?.value },
    };
  }
  function note() {
    const n = $('#p-note');
    if (!n) return;
    const s = selection();
    const files = s.tags.length * s.areas.length * s.models.length;
    const unval = s.tags.filter((t) => !opt.months.find((m) => m.tag === t)?.validated.length);
    n.innerHTML = !s.tags.length ? 'Escolha ao menos um mês.' : !s.areas.length || !s.models.length ? 'Escolha ao menos uma área e um modelo.'
      : `${files} mapa(s) de risco${unval.length ? ` · ${esc(unval.map(monthLabel).join(', '))} ainda sem validação (o painel mostra só a previsão)` : ''}`;
  }

  // ── 2. montagem e verificação ────────────────────────────────────────────────
  function renderJob() {
    const box = $('#job');
    if (!JOB && !LAST) { box.hidden = true; return; }
    box.hidden = false;
    if (JOB?.running || JOB?.error) {
      const frac = JOB.total ? JOB.done / JOB.total : 0;
      box.innerHTML = `<h2>${JOB.error ? 'A montagem não terminou' : 'Montando o pacote'} <span class="pill" data-status="${JOB.error ? 'error' : 'running'}">${JOB.error ? 'Parou' : 'Em andamento'}</span></h2>
        ${JOB.error ? `<div class="callout" data-tone="err">${icon('x')}<div>${esc(JOB.error)}</div></div>`
          : `<div class="run-stage">${esc(ETAPA[JOB.etapa] || 'Preparando…')}${JOB.arquivo ? ` <span class="muted">· ${esc(JOB.arquivo)}</span>` : ''}</div>
             <div class="prog-track busy"><i style="width:${Math.max(3, Math.round(frac * 100))}%"></i></div>`}`;
      return;
    }
    const m = LAST.manifest, v = LAST.verify;
    const sel = m.selecao;
    const forb = v?.arquivos?.problemas?.filter((p) => / no pacote: /.test(p)) || [];
    const checks = [
      [v?.arquivos?.ok, `${v?.arquivos?.arquivos ?? m.arquivos.length} arquivos, cada um com sha256 no manifesto`],
      [v && !forb.length, 'Nenhuma planilha, base unificada, dataset ou modelo no pacote'],
      [v && !v.rotas.diferencas.length && !v.rotas.ausentes.length, `${v?.rotas?.iguais ?? 0} de ${v?.rotas?.total ?? 0} rotas devolvem exatamente o mesmo que o mapa interno`],
    ];
    const probs = v && !v.ok ? [...(v.arquivos.problemas || []), ...v.rotas.diferencas.map((d) => `${d.rota}: ${d.motivo || `${d.n} diferença(s)`}`), ...v.rotas.ausentes.map((d) => `${d.rota}: respondeu ${d.status}`)] : [];
    box.innerHTML = `<h2>${LAST.exported ? 'Pacote exportado' : 'Pacote montado'} <span class="pill" data-status="${v?.ok ? 'done' : 'error'}">${v?.ok ? `${icon('check')}verificado` : 'com problemas'}</span>
        <span class="spacer"></span><span class="muted">${esc(fmtDate(Date.parse(m.criadoEm)))}</span></h2>
      <div class="pub-sum">
        <div><b class="num">${fmtBytes(m.tamanho)}</b><span class="muted">tamanho do pacote</span></div>
        <div><b class="num">${fmtBytes(m.tamanhoOrigem)}</b><span class="muted">arquivos de origem</span></div>
        <div><b>${esc(sel.meses.map(monthLabel).join(', '))}</b><span class="muted">${sel.areas.length} área(s) · ${sel.modelos.length} modelo(s)</span></div>
        <div><b>${[sel.crimes_reais && 'crimes reais', sel.metricas && 'métricas', sel.ruas && 'ruas', sel.pois && 'pontos de interesse'].filter(Boolean).join(', ') || '—'}</b><span class="muted">incluídos</span></div>
      </div>
      <div class="checks">${checks.map(([ok, t]) => `<span class="check ${ok ? 'ok' : 'no'}">${icon(ok ? 'check' : 'x')} ${esc(t)}</span>`).join('')}</div>
      ${probs.length ? `<details class="pk" open><summary>Problemas encontrados</summary><ul class="tip-list">${probs.slice(0, 30).map((x) => `<li class="mono">${esc(x)}</li>`).join('')}</ul></details>` : ''}
      ${m.execucoes?.length ? `<details class="pk"><summary>Execuções que geraram estes dados (${m.execucoes.length})</summary><table class="tbl"><tbody>${m.execucoes.map((x) => `<tr><td class="mono">${esc(x.execucao)}</td><td>${x.fase === 'predict' ? 'Previsão' : 'Validação'}</td><td>${esc(monthLabel(x.mes))}</td><td>${esc(x.area === 'todas' ? 'todas as áreas' : areaLabel(x.area))}</td></tr>`).join('')}</tbody></table></details>` : ''}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn" data-act="preview">${icon('map')} Pré-visualizar</button>
        ${LAST.exported
          ? `<button class="btn" data-pub-open="${esc(LAST.exported.name)}">${icon('folder')} Abrir a pasta do pacote</button>`
          : `<label class="chk"><input type="checkbox" id="p-zip" checked> Também em .zip</label>
             <button class="btn primary" data-act="export" ${v?.ok ? '' : 'disabled title="Corrija os problemas e monte de novo"'}>${icon('publish')} Exportar pacote</button>`}
      </div>
      ${LAST.exported ? `<div class="callout" data-tone="info" style="margin-top:12px">${icon('info')}<div>
          Copie a pasta <span class="mono">${esc(LAST.exported.name)}</span>${LAST.exported.zip ? ' (ou o <span class="mono">.zip</span>)' : ''} para o servidor e rode:
          <pre class="cmd">node server.js --host 0.0.0.0 --port 8080</pre>
          Precisa de Node.js 20 ou mais novo. O <span class="mono">README.md</span> do pacote explica PM2, Docker e nginx.</div></div>` : ''}`;
  }

  // ── 3. pré-visualização ──────────────────────────────────────────────────────
  function renderPreview() {
    const box = $('#preview');
    if (!previewUrl) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    const w = DEVICES.find((d) => d[0] === device)[2];
    box.innerHTML = `<h2>Pré-visualização <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">· o servidor do próprio pacote</span>
        <span class="spacer"></span>
        <span class="seg" role="group" aria-label="Tamanho da tela">${DEVICES.map(([k, l]) => `<button data-dev="${k}" class="${k === device ? 'on' : ''}" aria-pressed="${k === device}">${l}</button>`).join('')}</span>
        <button class="btn sm" data-act="external">${icon('external')} Navegador</button>
        <button class="btn sm" data-act="close-preview">${icon('x')} Fechar</button></h2>
      <div class="pub-frame-wrap"><iframe class="pub-frame" title="Pré-visualização do pacote" src="${esc(previewUrl)}" style="${w ? `width:${w}px` : 'width:100%'}"></iframe></div>`;
  }
  async function openPreview(ref) {
    try {
      const st = await call('publish:preview', ref);
      previewUrl = `${st.url}?theme=${store.get().settings?.themeResolved || 'light'}`;
      renderPreview(); scrollToEl($('#preview'));
    } catch (e) { toast(e.message, 'err'); }
  }

  // ── histórico ───────────────────────────────────────────────────────────────
  async function renderHistory() {
    let list = [];
    try { list = await call('publish:history'); } catch { /* sem pasta */ }
    $('#hist').innerHTML = `<h2>Pacotes exportados</h2>${!list.length ? '<div class="empty">Nenhum pacote exportado ainda.</div>' : `
      <table class="tbl"><thead><tr><th>Criado em</th><th>Meses</th><th>Áreas · modelos</th><th class="r">Tamanho</th><th>Verificação</th><th></th></tr></thead>
      <tbody>${list.map((p) => `<tr><td>${esc(fmtDate(Date.parse(p.criadoEm)))}<br><span class="muted mono small">${esc(p.name)}</span></td>
        <td>${esc(p.selecao.meses.map(monthLabel).join(', '))}</td><td>${p.selecao.areas.length} · ${esc(p.selecao.modelos.join(', '))}</td>
        <td class="r num">${fmtBytes(p.tamanho)}${p.zip ? `<br><span class="muted small">zip ${fmtBytes(p.zip.bytes)}</span>` : ''}</td>
        <td>${p.verificacao ? `<span class="pill" data-status="${p.verificacao.ok ? 'done' : 'error'}">${p.verificacao.ok ? `${icon('check')}ok` : 'problemas'}</span> <span class="muted small">${esc(fmtDate(Date.parse(p.verificacao.em)))}</span>` : '—'}</td>
        <td class="r nowrap"><button class="btn sm" data-pub-preview="${esc(p.name)}" title="Pré-visualizar">${icon('map')}</button>
          <button class="btn sm" data-pub-verify="${esc(p.name)}" title="Conferir de novo os arquivos e as rotas">${icon('validate')} Verificar</button>
          <button class="btn sm" data-pub-open="${esc(p.name)}" title="Abrir a pasta">${icon('folder')}</button></td></tr>`).join('')}</tbody></table>
      <p class="note">Ficam em <span class="mono">publish\\pacotes</span> na pasta de trabalho. "Verificar" confere de novo o sha256 de cada arquivo e compara as rotas com o mapa interno atual: se a previsão foi refeita depois, aparecem as diferenças.</p>`}`;
  }

  // ── eventos ─────────────────────────────────────────────────────────────────
  const off = window.pc.on('publish:event', (ev) => {
    if (!JOB?.running) return;
    if (ev.t === 'progress') Object.assign(JOB, { etapa: ev.etapa, done: ev.done, total: ev.total, arquivo: ev.arquivo || '' });
    renderJob();
  });

  el.addEventListener('input', (e) => { if (e.target.closest('#pkg')) note(); });
  el.addEventListener('change', (e) => {
    if (e.target.closest('#pkg')) { note(); const s = selection(); saveSel({ tags: s.tags, areas: s.areas, models: s.models, crimes: s.crimes, metricas: s.metricas, ruas: s.ruas, pois: s.pois, fundoCarto: s.fundoCarto }); }
  });
  el.addEventListener('click', async (e) => {
    const t = e.target;
    const open = t.closest('[data-open]');
    if (open) { call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err')); return; }
    if (t.closest('[data-act="aviso-padrao"]')) { e.preventDefault(); $('#p-aviso').value = opt.avisoPadrao; return; }
    if (t.closest('[data-act="build"]')) {
      const s = selection();
      if (!s.tags.length || !s.areas.length || !s.models.length) { toast('Escolha ao menos um mês, uma área e um modelo.', 'err'); return; }
      JOB = { running: true, etapa: null, done: 0, total: 0 }; LAST = null; previewUrl = null;
      renderForm(); renderJob(); renderPreview(); scrollToEl($('#job'));
      try {
        LAST = await call('publish:build', s);
        JOB = null;
        toast(LAST.verify?.ok ? 'Pacote montado e verificado.' : 'Pacote montado, mas a verificação encontrou problemas.', LAST.verify?.ok ? 'ok' : 'err', 8000);
        renderJob(); openPreview({ staged: LAST.id });
      } catch (err) {
        JOB = { ...JOB, running: false, error: /SIGTERM|código null/.test(err.message) ? 'Montagem cancelada.' : err.message };
        renderJob();
      }
      renderForm();
      return;
    }
    if (t.closest('[data-act="cancel"]')) { call('publish:cancel'); return; }
    if (t.closest('[data-act="preview"]') && LAST) { openPreview(LAST.exported ? { name: LAST.exported.name } : { staged: LAST.id }); return; }
    if (t.closest('[data-act="external"]')) { call('publish:previewExternal').catch((err) => toast(err.message, 'err')); return; }
    if (t.closest('[data-act="close-preview"]')) { await call('publish:previewStop'); previewUrl = null; renderPreview(); return; }
    const dev = t.closest('[data-dev]');
    if (dev) { device = dev.dataset.dev; renderPreview(); return; }
    if (t.closest('[data-act="export"]') && LAST) {
      const b = t.closest('button'); b.disabled = true;
      try {
        const r = await call('publish:export', LAST.id, { zip: $('#p-zip')?.checked });
        LAST.exported = r;
        if (previewUrl) { const st = await call('publish:preview', { name: r.name }); previewUrl = `${st.url}?theme=${store.get().settings?.themeResolved || 'light'}`; renderPreview(); }
        toast(`Pacote exportado em publish\\pacotes\\${r.name}${r.zip ? ' (+ .zip)' : ''}.`, 'ok', 10000, { label: 'Abrir pasta', fn: () => call('publish:openDir', { name: r.name }) });
        renderJob(); renderHistory(); refreshWorkspace();
      } catch (err) { toast(err.message, 'err', 10000); b.disabled = false; }
      return;
    }
    const po = t.closest('[data-pub-open]');
    if (po) { call('publish:openDir', { name: po.dataset.pubOpen }).catch((err) => toast(err.message, 'err')); return; }
    const pp = t.closest('[data-pub-preview]');
    if (pp) { openPreview({ name: pp.dataset.pubPreview }); return; }
    const pv = t.closest('[data-pub-verify]');
    if (pv) {
      pv.disabled = true; pv.innerHTML = `${icon('refresh')} Verificando…`;
      try {
        const v = await call('publish:verify', { name: pv.dataset.pubVerify });
        toast(v?.ok ? 'Pacote íntegro: arquivos e rotas conferem.' : 'A verificação encontrou diferenças. Veja o arquivo .verificacao.json ao lado do pacote.', v?.ok ? 'ok' : 'err', 9000);
      } catch (err) { toast(err.message, 'err'); }
      renderHistory();
    }
  });

  async function load() {
    try {
      opt = await call('publish:options');
      opt.basemap = await call('basemap:get').catch(() => null);
      renderForm();
    } catch (e) { $('#pkg').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  load(); renderJob(); renderHistory();
  // pacote montado fora desta tela (ciclo mensal) e ainda não exportado
  if (!LAST && !JOB) call('publish:latestStaged').then((r) => { if (r && !LAST) { LAST = r; renderJob(); } }).catch(() => {});
  mountGeojson(el);
  return () => { off(); if (previewUrl) call('publish:previewStop').catch(() => {}); };
}

// ── GeoJSON avulso para o geojson.io ────────────────────────────────────────────
function mountGeojson(el) {
  const box = el.querySelector('#geo');
  let data = null;

  const render = () => {
    if (!data?.months?.length) { box.innerHTML = `<h2>${icon('map')} Exportar GeoJSON</h2><div class="empty">Ainda não há previsões geradas nesta pasta de trabalho.</div>`; return; }
    const m = data.months[0];
    box.innerHTML = `<h2>${icon('map')} Exportar GeoJSON</h2>
      <div class="form-grid">
        <label>Mês<select id="g-month">${data.months.map((x) => `<option value="${x.tag}">${esc(x.label)}</option>`).join('')}</select></label>
        <fieldset><legend>Modelos</legend><div id="g-models"></div></fieldset>
        <fieldset><legend>Áreas</legend><div id="g-areas"></div></fieldset>
        <fieldset><legend>Opções</legend>
          <label class="chk"><input type="checkbox" id="g-alert" checked> Só as células em alerta (arquivo leve)</label>
          <label class="chk"><input type="checkbox" id="g-merge" checked> Um arquivo com todas as áreas</label>
          <label class="chk"><input type="checkbox" id="g-crimes"> Incluir os crimes reais do mês</label>
        </fieldset>
      </div>
      <div class="btn-row" style="margin-top:14px"><button class="btn primary" data-act="export-geo">${icon('publish')} Exportar</button></div>
      <div id="g-out"></div>`;
    const fill = () => {
      const cur = data.months.find((x) => x.tag === el.querySelector('#g-month').value) || m;
      el.querySelector('#g-models').innerHTML = cur.models.map((x) => `<label class="chk"><input type="checkbox" name="model" value="${x}" ${x === 'Ensemble' ? 'checked' : ''}> ${esc(MODEL_LABEL[x] || x)}</label>`).join('');
      el.querySelector('#g-areas').innerHTML = cur.areas.map((x) => `<label class="chk"><input type="checkbox" name="area" value="${x}" checked> ${esc(areaLabel(x))}</label>`).join('');
      const crimes = el.querySelector('#g-crimes');
      crimes.disabled = !cur.crimesAreas.length;
      crimes.parentElement.title = cur.crimesAreas.length ? '' : 'Este mês ainda não tem crimes reais (aguardando a SSP).';
      if (!cur.crimesAreas.length) crimes.checked = false;
    };
    el.querySelector('#g-month').addEventListener('change', fill);
    fill();
  };

  box.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act="export-geo"]')) return;
    const pick = (n) => [...box.querySelectorAll(`input[name="${n}"]:checked`)].map((i) => i.value);
    const opts = {
      tag: box.querySelector('#g-month').value, models: pick('model'), areas: pick('area'),
      alertOnly: box.querySelector('#g-alert').checked, merge: box.querySelector('#g-merge').checked, includeCrimes: box.querySelector('#g-crimes').checked,
    };
    if (!opts.models.length || !opts.areas.length) { toast('Escolha ao menos um modelo e uma área.', 'err'); return; }
    try {
      const r = await call('publish:exportGeojson', opts);
      if (!r) return;
      box.querySelector('#g-out').innerHTML = `<p class="muted" style="margin-top:12px">Salvo em <span class="mono">${esc(r.dest)}</span></p>
        <div class="checks" style="margin-top:6px">${r.written.map((w) =>
        `<span class="check ok">${icon('check')} <span class="mono">${esc(w.file.split(/[\\/]/).pop())}</span>&nbsp;· ${w.features} células · ${fmtBytes(w.bytes)}</span>`).join('')}</div>`;
      toast(`${r.written.length} arquivo(s) salvos. Arraste no geojson.io para ver.`, 'ok', 7000);
    } catch (err) { toast(err.message, 'err'); }
  });

  call('publish:geojsonList').then((d) => { data = d; render(); }).catch((e) => { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}
