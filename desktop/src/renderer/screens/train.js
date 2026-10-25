// Treino: Random Forest, LSTM e Transformer por área, com acompanhamento ao vivo
// (modelo × área, época, perda), os hiperparâmetros de cada modelo (recomendados da
// dissertação, editáveis e explicados) e a arquitetura de cada modelo em 3D.
import { store, call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast, scrollToEl, fmtDate } from '../lib/dom.js';
import { phaseHead, animCard, statusCardHtml } from './phase.js';
import { mountRunPanel, execControls, areaLabel } from '../components/run-panel.js';
import '../components/pc-model-arch.js';
import { seloCampo, botaoRestaurar, confirmarRestaurar } from '../lib/padrao.js';

const MODELS = [['rf', 'Random Forest', 'processador'], ['lstm', 'LSTM', 'gpu'], ['transformer', 'Transformer', 'gpu']];
const KEY = { rf: 'RF', lstm: 'LSTM', transformer: 'Transformer' };
const PREF_KEY = 'precrime.train.opts';
const TAB_KEY = 'precrime.train.ptab';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || null; } catch { return null; } };
const savePrefs = (o) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(o)); } catch { /* sem armazenamento */ } };
const loadTab = () => { try { return localStorage.getItem(TAB_KEY) || 'RF'; } catch { return 'RF'; } };
const saveTab = (t) => { try { localStorage.setItem(TAB_KEY, t); } catch { /* sem armazenamento */ } };

// números no padrão brasileiro (0,001 · 2.048)
const fmtV = (v) => (v === null || v === undefined ? 'sem limite' : Number.isInteger(v) ? Number(v).toLocaleString('pt-BR') : String(v).replace('.', ','));
const same = (a, b) => (a === null || b === null || a === undefined || b === undefined ? (a ?? null) === (b ?? null) : Number(a) === Number(b));

/** Mesma validação do processo principal (services/modelParams.js), para avisar na hora. */
function checkValue(p, raw, none) {
  if (p.tipo === 'intOrNone' && none) return [null, null];
  const n = Number(String(raw).replace(',', '.'));
  if (String(raw).trim() === '' || !Number.isFinite(n)) return [null, 'Informe um número.'];
  if (p.tipo === 'choice') return p.opcoes.includes(n) ? [n, null] : [null, `Escolha um de: ${p.opcoes.join(', ')}.`];
  if ((p.tipo === 'int' || p.tipo === 'intOrNone') && !Number.isInteger(n)) return [null, 'Use um número inteiro.'];
  if (n < p.min || n > p.max) return [null, `Use um valor entre ${fmtV(p.min)} e ${fmtV(p.max)}.`];
  return [n, null];
}

export function mount(el) {
  el.innerHTML = `
    ${phaseHead('train', '')}
    <div class="card" id="opts"></div>
    <div class="card" id="params"></div>
    <div id="run-panel"></div>
    <div class="card"><h2>Como cada modelo funciona</h2><pc-model-arch id="arch" model="rf" height="420"></pc-model-arch></div>
    <div class="card" id="models-done"></div>
    <div id="status-card"></div>`;
  const $ = (s) => el.querySelector(s);
  const arch = $('#arch');

  const hw = store.get().hardware;
  let opts = loadPrefs() || { area: '', completo: false, modo: hw?.verdict?.profile === 'eco' ? 'sequencial' : 'paralelo', modelos: ['rf', 'lstm', 'transformer'] };
  let P = null;             // train:params (schema, recomendados, valores, mudados, treinados)
  let tab = loadTab();
  const errs = {};          // erros de validação por campo, da aba aberta
  const typed = {};         // o que foi digitado num campo inválido (para não sumir)

  // ── Como treinar ───────────────────────────────────────────────────────────
  function paramsLine() {
    if (!P) return '';
    const sel = opts.modelos.map((m) => KEY[m]);
    const mud = sel.filter((m) => P.mudados[m]);
    if (!mud.length) return `<div class="dev-line">${icon('settings')}<span>Parâmetros: padrão da dissertação. <button class="link-btn" data-pgo>Ver ou ajustar</button></span></div>`;
    const txt = mud.map((m) => `<b>${esc(P.schema[m].nome)}</b> (${Object.entries(P.mudados[m]).map(([k, v]) => `${esc(P.schema[m].params.find((p) => p.k === k)?.label.toLowerCase() || k)} ${esc(fmtV(v))}`).join(', ')})`).join('; ');
    return `<div class="dev-line">${icon('warn')}<span>Parâmetros diferentes do padrão da dissertação: ${txt}. <button class="link-btn" data-pgo>Ver ou ajustar</button></span></div>`;
  }

  // semente do treino (GLOBAL_SEED): a mesma inicialização dá o mesmo modelo
  function seedLine() {
    if (!P?.semente) return '';
    const { valor, padrao } = P.semente;
    return `<div class="seed-line"><label for="t-seed"><b>Semente</b></label>
      <input id="t-seed" type="number" min="0" step="1" value="${esc(valor)}" class="poi-in" ${panel.isRunning() ? 'disabled' : ''}>
      ${seloCampo(valor === padrao, String(padrao), 'data-seed-reset')}
      <span class="muted small">Inicialização aleatória do Random Forest, da LSTM e do Transformer. Com a mesma semente e os mesmos dados, o treino se repete; o Modo científico usa várias sementes para medir essa variação.</span></div>`;
  }

  function renderOpts() {
    const { ws, python } = store.get();
    if (!ws) return;
    const feat = ws.phases?.find((p) => p.id === 'features');
    const areas = feat?.areasDone || [];
    const torch = python?.packages?.torch?.ok;
    const cuda = python?.torch?.cuda_available;
    const nets = opts.modelos.some((m) => m !== 'rf');
    const nvidia = store.get().hardware?.gpus?.find((g) => g.vendor === 'NVIDIA' && g.source === 'nvidia-smi')?.name;
    const blocker = !areas.length ? { text: 'O Treino usa os datasets das Features. Rode as Features antes.', go: 'features', goLabel: 'Ir para Features' }
      : nets && python && !torch ? { text: 'Falta o PyTorch para LSTM e Transformer. Prepare o ambiente ou treine só o Random Forest.', go: 'env', goLabel: 'Ir para Ambiente' }
      : !opts.modelos.length ? { text: 'Escolha ao menos um modelo.' } : null;
    if (opts.area && !areas.includes(opts.area)) opts.area = '';
    $('#opts').innerHTML = `
      <h2>Como treinar</h2>
      <div class="choice">
        <div class="choice-group"><h3>Modo</h3>
          <label class="opt"><input type="radio" name="completo" value="0" ${!opts.completo ? 'checked' : ''}><span><b>Rápido</b><span class="muted">Treina só o modelo final de cada área. Para o uso mensal.</span></span></label>
          <label class="opt"><input type="radio" name="completo" value="1" ${opts.completo ? 'checked' : ''}><span><b>Completo</b><span class="muted">Antes do modelo final, mede o acerto (AUC) em vários cortes no tempo desde 2022. Leva bem mais; serve para avaliar o modelo.</span></span></label>
        </div>
        <div class="choice-group"><h3>Execução</h3>
          <label class="opt"><input type="radio" name="modo" value="paralelo" ${opts.modo === 'paralelo' ? 'checked' : ''}><span><b>Três modelos ao mesmo tempo</b><span class="muted">Mais rápido. Precisa de 16 GB de memória ou mais.</span></span></label>
          <label class="opt"><input type="radio" name="modo" value="sequencial" ${opts.modo === 'sequencial' ? 'checked' : ''}><span><b>Um modelo por vez</b><span class="muted">Usa menos memória. Recomendado com 8 a 16 GB${hw?.verdict?.profile === 'eco' ? ' (é o caso deste computador)' : ''}.</span></span></label>
        </div>
        <div class="choice-group"><h3>Modelos</h3>
          ${MODELS.map(([k, l, dev]) => `<label class="chk"><input type="checkbox" name="modelo" value="${k}" ${opts.modelos.includes(k) ? 'checked' : ''}> <b>${l}</b>
            <span class="muted">&nbsp;· ${dev === 'gpu' ? (cuda ? 'placa de vídeo' : 'processador') : 'processador'}</span></label>`).join('')}
          <p class="muted small">O Ensemble (na Previsão) usa os três. Treine só um para refazer um modelo específico.</p>
        </div>
      </div>
      <div class="dev-line">${icon('env')}${!python ? 'Verificando o Python…'
        : !torch ? 'PyTorch não instalado: só o Random Forest pode treinar.'
        : cuda ? `LSTM e Transformer vão usar a placa de vídeo <b>&nbsp;${esc(python.torch.device)}</b>.`
        : nvidia ? `<span>LSTM e Transformer vão rodar no processador: o PyTorch instalado não usa a <b>${esc(nvidia)}</b>. <button class="link-btn" data-go="env">Instalar o PyTorch para a placa de vídeo</button></span>`
        : 'LSTM e Transformer vão rodar no processador (sem placa de vídeo NVIDIA): o treino fica bem mais lento.'}</div>
      ${paramsLine()}
      ${seedLine()}
      ${execControls({ job: 'train', label: 'Treino', python, running: panel.isRunning(), areas, area: opts.area, blocker,
        note: opts.completo ? 'O modo completo pode levar horas com as 8 áreas.' : 'Rápido com as 8 áreas: perto de 50 minutos numa máquina com placa de vídeo.' })}`;
  }

  // ── Parâmetros dos modelos (uma aba por modelo) ────────────────────────────────
  function inputHtml(p, v) {
    const id = `pp-${p.k}`;
    if (p.tipo === 'choice') {
      const cur = p.k in typed ? Number(typed[p.k]) : v;
      return `<select id="${id}" data-pk="${p.k}" ${errs[p.k] ? 'aria-invalid="true"' : ''}>${p.opcoes.map((o) => `<option value="${o}" ${same(o, cur) ? 'selected' : ''}>${esc(fmtV(o))}</option>`).join('')}</select>`;
    }
    const none = p.tipo === 'intOrNone' && v === null;
    const step = p.tipo === 'float' ? 'any' : p.step || 1;
    const shown = p.k in typed ? typed[p.k] : none ? '' : v;
    return `<input id="${id}" type="number" inputmode="decimal" data-pk="${p.k}" min="${p.min}" max="${p.max}" step="${step}" value="${esc(shown)}" ${none ? 'disabled' : ''} ${errs[p.k] ? 'aria-invalid="true"' : ''}>
      ${p.tipo === 'intOrNone' ? `<label class="chk pnone"><input type="checkbox" data-pk-none="${p.k}" ${none ? 'checked' : ''}> sem limite</label>` : ''}`;
  }

  function rowHtml(m, p) {
    const v = P.valores[m][p.k];
    const rec = P.recomendados[m][p.k];
    const changed = !same(v, rec);
    const err = errs[p.k];
    return `<div class="prow ${changed ? 'changed' : ''} ${err ? 'invalid' : ''}">
      <div class="prow-head">
        <label for="pp-${p.k}" class="prow-label"><b>${esc(p.label)}</b><code class="mono">${esc(p.k)}</code></label>
        <div class="prow-input">${inputHtml(p, v)}</div>
        <div class="prow-rec">${seloCampo(!changed, fmtV(rec), `data-preset="${p.k}"`)}${P.otimizados && m === 'RF' && p.k in P.otimizados ? '<span class="muted small">(otimizado nesta pasta)</span>' : ''}</div>
      </div>
      ${err ? `<p class="prow-err" role="alert">${esc(err)}</p>` : ''}
      <p class="prow-help">${esc(p.faz)}</p>
      <ul class="prow-eff">
        <li>${icon('up')}<span><b>Mais alto:</b> ${esc(p.mais)}</span></li>
        <li>${icon('down')}<span><b>Mais baixo:</b> ${esc(p.menos)}</span></li>
        <li class="muted">${icon('info')}<span>${esc(p.custo)}</span></li>
      </ul>
    </div>`;
  }

  function renderParams() {
    if (!P) { $('#params').innerHTML = '<h2>Parâmetros dos modelos</h2><div class="empty">Carregando…</div>'; return; }
    if (!P.schema[tab]) tab = 'RF';
    const S = P.schema[tab];
    const running = panel.isRunning();
    const nMud = Object.keys(P.mudados).length;
    const grupo = (g, titulo, sub) => {
      const ps = S.params.filter((p) => p.grupo === g);
      return ps.length ? `<h3 class="pgroup">${titulo} <span class="muted">— ${sub}</span></h3>${ps.map((p) => rowHtml(tab, p)).join('')}` : '';
    };
    $('#params').innerHTML = `
      <h2>Parâmetros dos modelos <span class="spacer"></span>
        <span class="pill" data-status="${nMud ? 'partial' : 'done'}">${nMud ? `${nMud} modelo${nMud > 1 ? 's' : ''} com mudanças` : 'Padrão da dissertação'}</span></h2>
      <p class="muted">Cada campo abre com o valor usado na dissertação. Você pode ajustar e treinar de novo: a mudança é salva na hora
        e vale a partir do próximo treino${running ? ' (o treino em andamento continua com os valores com que começou)' : ''}. Cada modelo guarda os parâmetros
        com que foi treinado, e a Previsão usa esses.</p>
      <div class="ptabs" role="tablist">${Object.keys(P.schema).map((m) => `<button role="tab" data-ptab="${m}" class="${m === tab ? 'on' : ''}" aria-selected="${m === tab}" tabindex="${m === tab ? 0 : -1}">${esc(P.schema[m].nome)}${P.mudados[m] ? '<i class="pdot" title="Diferente do padrão da dissertação"></i>' : ''}</button>`).join('')}</div>
      <div class="ppanel" role="tabpanel">
        <p class="presumo">${esc(S.resumo)}</p>
        <p class="muted pfixos"><b>Fixos:</b> ${esc(S.fixos)}</p>
        ${tab === 'RF' && P.otimizados ? `<p class="muted pfixos">${icon('info')} Esta pasta tem parâmetros otimizados do Random Forest (<span class="mono">processed/best_params.json</span>): eles aparecem como padrão.</p>` : ''}
        ${grupo('arquitetura', 'Arquitetura', 'o formato do modelo')}
        ${grupo('treino', 'Treino', 'como o modelo aprende')}
        <div class="btn-row" style="margin-top:14px">
          ${botaoRestaurar('data-preset-all', { disabled: !P.mudados[tab] })}
          ${nMud > 1 || (nMud === 1 && !P.mudados[tab]) || P.semente?.valor !== P.semente?.padrao ? botaoRestaurar('data-preset-every', { label: 'Restaurar todos os modelos e a semente' }) : ''}
        </div>
      </div>`;
  }

  async function saveParam(m, k, value) {
    try {
      P = await call('train:paramsSet', m, { [k]: value });
      delete errs[k]; delete typed[k];
      arch.setParams(P.valores);
      renderParams(); renderOpts(); renderDone();
    } catch (err) {
      errs[k] = err.message;
      typed[k] = value;
      renderParams();
    }
  }

  async function loadParams() {
    try { P = await call('train:params'); } catch (err) { P = null; toast(err.message, 'err'); }
    if (P) arch.setParams(P.valores);
    renderParams(); renderOpts(); renderDone();
  }

  function selectTab(m, syncArch = true) {
    if (!P?.schema[m] || m === tab) return;
    tab = m; saveTab(m);
    for (const k of Object.keys(errs)) delete errs[k];
    for (const k of Object.keys(typed)) delete typed[k];
    renderParams();
    if (syncArch) arch.setAttribute('model', m.toLowerCase());
  }

  // ── Modelos treinados ─────────────────────────────────────────────────────────
  /** Diferenças entre os parâmetros com que o modelo foi treinado e os atuais. */
  function trainedInfo(m, a) {
    if (!P) return null;
    const reg = P.treinados[`${P.prefixo[m]}_${a}`];
    const usados = reg?.parametros || P.recomendados[m]; // sem registro: treinado antes desta versão, com os recomendados
    const keys = P.schema[m].params.map((p) => p.k);
    const label = (k) => P.schema[m].params.find((p) => p.k === k)?.label.toLowerCase() || k;
    const vsRec = keys.filter((k) => k in usados && !same(usados[k], P.recomendados[m][k]));
    const vsCur = keys.filter((k) => k in usados && !same(usados[k], P.valores[m][k]));
    const tip = [
      reg ? (vsRec.length ? `Treinado com: ${vsRec.map((k) => `${label(k)} ${fmtV(usados[k])}`).join(', ')}` : 'Treinado com os parâmetros recomendados')
        : 'Treinado antes do registro de parâmetros (com os recomendados)',
      vsCur.length ? `Diferente dos parâmetros atuais: ${vsCur.map((k) => `${label(k)} ${fmtV(usados[k])} → ${fmtV(P.valores[m][k])}`).join(', ')}` : '',
      reg?.seed != null ? `Semente ${reg.seed}${reg.dataEnd ? ` · dados até ${reg.dataEnd.split('-').reverse().join('/')}` : ''}` : '',
    ].filter(Boolean).join('\n');
    return { custom: vsRec.length > 0, outdated: vsCur.length > 0, tip, seed: reg?.seed ?? null };
  }

  function renderDone() {
    const tr = store.get().ws?.phases?.find((p) => p.id === 'train');
    const feat = store.get().ws?.phases?.find((p) => p.id === 'features');
    const areas = [...new Set([...(feat?.areasDone || []), ...Object.values(tr?.models || {}).flat()])].sort();
    if (!areas.length) { $('#models-done').innerHTML = '<h2>Modelos treinados</h2><div class="empty">Nenhum modelo treinado nesta pasta de trabalho.</div>'; return; }
    const file = { RF: (a) => `rf_${a}.pkl`, LSTM: (a) => `lstm_${a}.pth`, Transformer: (a) => `transformer_${a}.pth` };
    $('#models-done').innerHTML = `<h2>Modelos treinados</h2>
      <table class="tbl models-done"><thead><tr><th>Área</th><th>Random Forest</th><th>LSTM</th><th>Transformer</th><th>Dataset</th></tr></thead>
      <tbody>${areas.map((a) => {
        const ds = tr?.datasetTimes?.[a];
        return `<tr><td><b>${esc(areaLabel(a))}</b></td>${['RF', 'LSTM', 'Transformer'].map((m) => {
          const t = tr?.modelTimes?.[file[m](a)];
          if (!t) return '<td class="no">—</td>';
          const staleDs = ds && ds > t;
          const pi = trainedInfo(m, a);
          const stale = staleDs || pi?.outdated;
          const title = [staleDs ? 'O dataset é mais novo que o modelo' : '', pi?.tip || ''].filter(Boolean).join('\n');
          return `<td class="${stale ? '' : 'ok'}" title="${esc(title)}">${stale ? icon('stale') : icon('check')} ${esc(fmtDate(t))}${pi?.custom ? ` <span class="ptag">${icon('settings')} ajustado</span>` : ''}${pi?.seed != null ? ` <span class="muted small">semente ${esc(pi.seed)}</span>` : ''}</td>`;
        }).join('')}<td class="muted">${ds ? esc(fmtDate(ds)) : '—'}</td></tr>`;
      }).join('')}</tbody></table>
      <p class="note">Um modelo fica desatualizado (${icon('stale')}) quando o dataset da área é mais novo que ele ou quando ele foi treinado com parâmetros
        diferentes dos atuais. <span class="ptag">${icon('settings')} ajustado</span> = treinado com parâmetros diferentes do padrão da dissertação. Passe o mouse sobre a data para ver os valores.</p>`;
  }

  // sincroniza a arquitetura 3D com o treino em andamento
  function syncArch(m) {
    const act = Object.entries(m?.active || {}).filter(([, a]) => a && !a.done);
    arch.setAttribute('active', act.map(([k]) => k.toLowerCase()).join(','));
    const cur = (arch.getAttribute('model') || 'rf');
    const mine = act.find(([k]) => k.toLowerCase() === cur);
    if (mine) {
      const a = mine[1];
      arch.setAttribute('area', a.area || '');
      if (a.epoch) { arch.setAttribute('epoch', a.epoch); arch.setAttribute('epochs', a.epochs); } else { arch.removeAttribute('epoch'); arch.removeAttribute('epochs'); }
      if (a.lastLoss != null) arch.setAttribute('loss', a.lastLoss); else arch.removeAttribute('loss');
    }
  }

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'completo') opts.completo = t.value === '1';
    if (t.name === 'modo') opts.modo = t.value;
    if (t.name === 'modelo') opts.modelos = [...el.querySelectorAll('input[name="modelo"]:checked')].map((i) => i.value);
    if (t.matches('[data-exec-area]')) opts.area = t.value;
    if (t.id === 't-seed' && P) {
      call('train:seedSet', t.value).then((v) => { P = v; renderOpts(); }).catch((err) => { toast(err.message, 'err'); renderOpts(); });
      return;
    }
    if (['completo', 'modo', 'modelo'].includes(t.name) || t.matches('[data-exec-area]')) { savePrefs(opts); renderOpts(); }
    // parâmetros: salva ao sair do campo (ou ao escolher na lista)
    if (t.matches('[data-pk]') && P) {
      const p = P.schema[tab].params.find((x) => x.k === t.dataset.pk);
      const [v, err] = checkValue(p, t.value, false);
      if (err) { errs[p.k] = err; typed[p.k] = t.value; renderParams(); $(`#pp-${p.k}`)?.focus(); return; }
      delete typed[p.k];
      if (same(v, P.valores[tab][p.k])) { delete errs[p.k]; renderParams(); return; }
      // regra entre parâmetros, avisada aqui sem ir ao processo principal
      if (tab === 'Transformer' && ['embed_dim', 'num_heads'].includes(p.k)) {
        const nx = { ...P.valores.Transformer, [p.k]: v };
        if (nx.embed_dim % nx.num_heads) {
          errs[p.k] = `O tamanho do embedding (${nx.embed_dim}) precisa ser divisível pelas cabeças de atenção (${nx.num_heads}). Ajuste um dos dois.`;
          typed[p.k] = t.value; renderParams(); return;
        }
        delete errs.embed_dim; delete errs.num_heads;
      }
      saveParam(tab, p.k, v);
    }
    if (t.matches('[data-pk-none]') && P) {
      const k = t.dataset.pkNone;
      const rec = P.recomendados[tab][k];
      saveParam(tab, k, t.checked ? null : (rec ?? 20));
    }
  });
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="run"]')) {
      try {
        await panel.run({ area: opts.area || null, completo: opts.completo, modo: opts.modo, modelos: opts.modelos });
        renderOpts(); scrollToEl($('#run-panel'));
        const first = opts.modelos.find((m) => m !== 'rf') || 'rf';
        arch.setAttribute('model', first);
      } catch (err) { toast(err.message, 'err', 8000); }
    }
    const open = e.target.closest('[data-open]');
    if (open) call('workspace:open', open.dataset.open).catch((err) => toast(err.message, 'err'));
    if (e.target.closest('[data-pgo]')) scrollToEl($('#params'));
    const tb = e.target.closest('[data-ptab]');
    if (tb) selectTab(tb.dataset.ptab);
    const one = e.target.closest('[data-preset]');
    if (one && P) saveParam(tab, one.dataset.preset, P.recomendados[tab][one.dataset.preset]);
    if (e.target.closest('[data-seed-reset]') && P) {
      try { P = await call('train:seedSet', P.semente.padrao); renderOpts(); toast('Semente de volta ao padrão da dissertação.', 'ok'); } catch (err) { toast(err.message, 'err'); }
    }
    if (e.target.closest('[data-preset-all]') && P) {
      if (!(await confirmarRestaurar(`Os parâmetros do ${P.schema[tab].nome}`))) return;
      try {
        P = await call('train:paramsReset', tab);
        for (const k of Object.keys(errs)) delete errs[k];
        for (const k of Object.keys(typed)) delete typed[k];
        arch.setParams(P.valores); renderParams(); renderOpts(); renderDone();
        toast(`${P.schema[tab].nome}: padrão da dissertação restaurado.`, 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }
    if (e.target.closest('[data-preset-every]') && P) {
      if (!(await confirmarRestaurar('Os parâmetros dos três modelos e a semente'))) return;
      try {
        P = await call('train:paramsReset', null);
        arch.setParams(P.valores); renderParams(); renderOpts(); renderDone();
        toast('Modelos e semente de volta ao padrão da dissertação.', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }
  });
  // teclado nas abas: setas esquerda/direita
  el.addEventListener('keydown', (e) => {
    const tb = e.target.closest('[data-ptab]');
    if (!tb || !P || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const ks = Object.keys(P.schema);
    const i = (ks.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : ks.length - 1)) % ks.length;
    selectTab(ks[i]);
    $(`[data-ptab="${ks[i]}"]`)?.focus();
  });
  // a aba da arquitetura 3D e a dos parâmetros andam juntas
  arch.addEventListener('model-change', (e) => { const m = KEY[e.detail]; if (m) selectTab(m, false); });

  const panel = mountRunPanel($('#run-panel'), 'train', {
    onState: () => { renderOpts(); renderParams(); },
    onEnd: () => { renderOpts(); arch.setAttribute('active', ''); loadParams(); },
    onTrainEvent: (_ev, m) => syncArch(m),
  });
  const renderStatus = () => { $('#status-card').innerHTML = statusCardHtml('train'); };
  const off = store.subscribe((_s, why) => {
    if (why === 'ws') { renderStatus(); renderOpts(); renderDone(); }
    if (why === 'python' || why === 'hw') renderOpts();
  });
  arch.setAttribute('model', tab.toLowerCase());
  renderStatus(); renderOpts(); renderParams(); renderDone();
  loadParams();
  if (!store.get().hardware) call('env:hardware').then((h) => store.set({ hardware: h }, 'hw')).catch(() => {});
  return () => { off(); panel.unmount(); };
}
