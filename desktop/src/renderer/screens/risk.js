// Mapa de risco: o que transforma as probabilidades dos três modelos no mapa final.
// Ensemble (pesos, média × máximo, filtro de histórico, suavização), pontos de interesse (fator,
// pesos por tipo, normalização) e área de cobertura (quanto do mapa vira alto e médio risco, regra
// de corte). Tudo abre com o padrão da dissertação; as mudanças ficam num rascunho até "Salvar",
// e a pré-visualização recalcula só o Ensemble de um mês já previsto para mostrar o que muda.
import { store, call } from '../lib/store.js';
import { icon } from '../lib/icons.js';
import { esc, toast, scrollToEl } from '../lib/dom.js';
import { seloCampo, botaoRestaurar, confirmarRestaurar } from '../lib/padrao.js';
import { mountRunPanel, areaLabel } from '../components/run-panel.js';

const TAB_KEY = 'precrime.risk.tab';
const loadTab = () => { try { return localStorage.getItem(TAB_KEY) || 'ensemble'; } catch { return 'ensemble'; } };
const saveTab = (t) => { try { localStorage.setItem(TAB_KEY, t); } catch { /* sem armazenamento */ } };
const pct = (x) => `${(Math.round(x * 1000) / 10).toLocaleString('pt-BR')}%`;
const num = (x) => (x === null || x === undefined ? '—' : String(x).replace('.', ','));
const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : a === b);
const monthLabel = (t) => t.split(/[-_]/).reverse().join('/');

function fmtVal(p, v) {
  if (p.tipo === 'bool') return v ? 'ligado' : 'desligado';
  if (p.tipo === 'pct') return pct(v);
  if (p.tipo === 'choice') return (p.opcoes.find(([k]) => k === v) || [v, v])[1];
  return num(v);
}

export function mount(el) {
  el.innerHTML = `
    <div class="phase-head"><div style="flex:1"><h1>${icon('map')} Mapa de risco</h1>
      <p>Como as probabilidades do Random Forest, da LSTM e do Transformer viram o mapa final: o peso de cada modelo, o ajuste pelos pontos de interesse e quanto do mapa vira alto e médio risco. Tudo abre com os valores da dissertação. As mudanças valem a partir da próxima Previsão (as previsões já feitas não mudam) e a cobertura vale também para a Validação.</p></div></div>
    <section class="card" id="r-cfg"><h2>Configuração</h2><div class="empty">Carregando…</div></section>
    <section class="card" id="r-prev"></section>
    <div id="r-run"></div>`;
  const $ = (s) => el.querySelector(s);
  let V = null;                 // risk:view
  let tab = loadTab();
  let draft = { valores: {}, poi: {} };   // o que foi mudado e ainda não salvo
  const errs = {};
  let areaSel = null;
  let fi = null;                // forecast:info
  let prev = { area: null, tag: null, res: null };

  const val = (k) => (k in draft.valores ? draft.valores[k] : V.valores[k]);
  const poiW = (k) => (k in draft.poi ? draft.poi[k] : V.poi[k]);
  const dirty = () => Object.keys(draft.valores).length + Object.keys(draft.poi).length;

  function inputHtml(p) {
    const v = val(p.k);
    const dis = p.dep && !val(p.dep) ? 'disabled' : '';
    const inv = errs[p.k] ? 'aria-invalid="true"' : '';
    if (p.tipo === 'bool') return `<label class="switch"><input type="checkbox" data-rk="${p.k}" ${v ? 'checked' : ''} ${dis}><span>${v ? 'ligado' : 'desligado'}</span></label>`;
    if (p.tipo === 'choice') return `<select data-rk="${p.k}" ${dis} ${inv}>${p.opcoes.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    if (p.tipo === 'pct') {
      return `<span class="pct-in"><input type="number" data-rk="${p.k}" data-pct min="${p.min * 100}" max="${p.max * 100}" step="${(p.step || 0.01) * 100}" value="${Math.round(v * 1000) / 10}" ${dis} ${inv}><span>%</span></span>
        ${p.sugestoes ? `<span class="chips-mini">${p.sugestoes.map((s) => `<button class="chip-mini ${near(s, v) ? 'on' : ''}" data-rk-set="${p.k}" data-v="${s}">${pct(s)}</button>`).join('')}</span>` : ''}`;
    }
    return `<input type="number" inputmode="decimal" data-rk="${p.k}" min="${p.min}" max="${p.max}" step="${p.tipo === 'int' ? 1 : p.step || 'any'}" value="${esc(v)}" ${dis} ${inv}>`;
  }

  function rowHtml(p) {
    const v = val(p.k);
    const igual = near(v, p.padrao);
    return `<div class="prow ${igual ? '' : 'changed'} ${errs[p.k] ? 'invalid' : ''} ${p.dep && !val(p.dep) ? 'dep-off' : ''} ${p.perigo && v ? 'perigo' : ''}">
      <div class="prow-head">
        <label class="prow-label"><b>${esc(p.label)}</b>${p.k in draft.valores ? '<span class="ptag">não salvo</span>' : ''}</label>
        <div class="prow-input">${inputHtml(p)}</div>
        <div class="prow-rec">${seloCampo(igual, fmtVal(p, p.padrao), `data-rk-reset="${p.k}"`)}</div>
      </div>
      ${errs[p.k] ? `<p class="prow-err" role="alert">${esc(errs[p.k])}</p>` : ''}
      <p class="prow-help">${esc(p.faz)}</p>
      ${p.mais || p.menos ? `<ul class="prow-eff">${p.mais ? `<li>${icon('up')}<span><b>Mais alto:</b> ${esc(p.mais)}</span></li>` : ''}${p.menos ? `<li>${icon('down')}<span><b>Mais baixo:</b> ${esc(p.menos)}</span></li>` : ''}</ul>` : ''}
      ${p.perigo && v ? `<div class="callout" data-tone="err">${icon('warn')}<div>Ligado, a Validação usa os crimes reais do mês para escolher o corte: os números ficam otimistas e não servem para comparar modelos.</div></div>` : ''}
    </div>`;
  }

  function sumWarn() {
    const s = val('w_rf') + val('w_lstm') + val('w_transformer');
    return Math.abs(s - 1) > 1e-6 ? `<div class="callout" data-tone="warn">${icon('info')}<div>Os pesos somam ${num(Math.round(s * 1000) / 1000)}. O Ensemble divide pela soma, então só a proporção entre eles importa; na dissertação eles somam 1.</div></div>` : '';
  }

  function poiTable() {
    const tipos = V.tipos || [];
    const listados = new Set(Object.keys(V.poiPadrao));
    const comPeso = new Set(Object.keys({ ...V.poi, ...draft.poi }));
    const linhas = [...tipos.map((t) => t.k), ...[...comPeso].filter((k) => !tipos.some((t) => t.k === k))];
    const n = Object.fromEntries(tipos.map((t) => [t.k, t.n]));
    const geral = val('poi_padrao');
    const cj = V.poiConjunto;
    const linhaConjunto = `<div class="dev-line">${icon('map')}<span>Conjunto de pontos de interesse: <b>${esc(cj?.nome || 'Dissertação')}</b>
      ${cj && cj.id !== 'dissertacao' ? '<span class="pill sel-pers" data-status="partial">diferente da dissertação</span>' : '<span class="selo-padrao">padrão da dissertação</span>'}
      <button class="link-btn" data-go="pois">Trocar, baixar do OpenStreetMap ou importar</button></span></div>`;
    if (!V.tipos) return `${linhaConjunto}<div class="callout" data-tone="warn">${icon('warn')}<div>${esc(areaLabel(areaSel))} não tem pontos de interesse no conjunto ativo: o ajuste fica desligado nesta área. Para as áreas criadas por você, use "Ruas e POIs" na Filtragem ou baixe um conjunto na tela Pontos de interesse.</div></div>`;
    return `${linhaConjunto}<div class="tbl-wrap"><table class="tbl poi-tbl"><thead><tr><th>Categoria</th><th class="r">Na área</th><th>Peso</th><th></th></tr></thead><tbody>
      ${linhas.map((k) => {
        const i = k.indexOf(':');
        const [grupo, nome] = i > 0 ? [k.slice(0, i), k.slice(i + 1)] : ['', k];
        const proprio = comPeso.has(k) && poiW(k) !== undefined && poiW(k) !== null;
        const w = proprio ? poiW(k) : geral;
        const pad = listados.has(k) ? V.poiPadrao[k] : V.poiPadraoGeral;
        const igual = near(w, pad) && (proprio === listados.has(k) || near(w, pad));
        return `<tr class="${igual ? '' : 'changed'}"><td><b>${esc(nome)}</b> <span class="muted small">${grupo === 'shop' ? 'loja' : grupo || ''}</span></td>
          <td class="r num">${n[k] != null ? Number(n[k]).toLocaleString('pt-BR') : '0'}</td>
          <td><input type="number" step="0.5" min="-10" max="10" data-poi="${esc(k)}" value="${esc(w)}" class="poi-in">${!proprio ? '<span class="muted small"> (peso dos não listados)</span>' : ''}</td>
          <td>${seloCampo(near(w, pad), num(pad), `data-poi-reset="${esc(k)}"`)}</td></tr>`;
      }).join('')}</tbody></table></div>
      <p class="note">${icon('info')} As categorias vêm do conjunto de pontos de interesse ativo, com a contagem na área. Categorias novas usam o peso dos não listados até você mudar. Na dissertação, só bar, pub, nightclub e police têm peso próprio; todo o resto (restaurantes, bancos, lojas) usa o peso dos não listados (1). Por causa da normalização (MinMax), mudar o peso de um tipo também mexe um pouco no escore das outras células, porque o maior e o menor escore da área mudam.</p>`;
  }

  function coberturaExtra() {
    const g = V.grid;
    const a = val('alto'), m = val('medio');
    const linha = (rot, f) => g ? `<tr><td>${rot}</td><td class="r num">${pct(f)}</td><td class="r num">${Math.ceil(f * g.celulas - 1e-9).toLocaleString('pt-BR')}</td><td class="r num">${(Math.ceil(f * g.celulas - 1e-9) * g.km2).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km²</td></tr>` : '';
    const emp = V.empate;
    return `${g ? `<h3 class="pgroup">Tamanho real em ${esc(areaLabel(areaSel))} <span class="muted">— ${g.celulas.toLocaleString('pt-BR')} células de ${g.celulaM} m (${g.km2.toLocaleString('pt-BR', { maximumFractionDigits: 4 })} km² cada)</span></h3>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Faixa</th><th class="r">Fração</th><th class="r">Células</th><th class="r">Área a patrulhar</th></tr></thead>
      <tbody>${linha('Alto risco (vermelho)', a)}${linha('Alto + médio (vermelho + amarelo)', m)}</tbody></table></div>` : ''}
      ${emp?.colapso && val('corte') === 'maior_igual' ? `<div class="callout" data-tone="warn">${icon('warn')}<div><b>Muitas células empatadas no corte.</b> Na última previsão de ${esc(areaLabel(areaSel))} (${esc(monthLabel(emp.mes))}), a regra "maior ou igual" marcaria ${pct(emp.fracMaiorIgual)} da área como alto risco, e não ${pct(a)}. O top exato marca exatamente a fração escolhida.</div></div>` : ''}
      <p class="note">O Modo científico mede sempre 5%, 10% e 20% (os quantis 0,95, 0,90 e 0,80), qualquer que seja a cobertura escolhida aqui.</p>`;
  }

  function render() {
    if (!V) return;
    if (!V.abas.some(([k]) => k === tab)) tab = 'ensemble';
    const [, , desc] = V.abas.find(([k]) => k === tab);
    const mudAba = (aba) => V.schema.some((p) => p.aba === aba && !near(V.valores[p.k], p.padrao)) || (aba === 'poi' && Object.keys(V.mudados.poi).length);
    const ps = V.schema.filter((p) => p.aba === tab);
    const d = dirty();
    $('#r-cfg').innerHTML = `
      <h2>Configuração <span class="spacer"></span>
        <span class="pill" data-status="${V.nMudados ? 'partial' : 'done'}">${V.nMudados ? `${V.nMudados} valor${V.nMudados > 1 ? 'es' : ''} diferente${V.nMudados > 1 ? 's' : ''} da dissertação` : 'Padrão da dissertação'}</span></h2>
      <div class="ptabs" role="tablist">${V.abas.map(([k, l]) => `<button role="tab" data-rtab="${k}" class="${k === tab ? 'on' : ''}" aria-selected="${k === tab}">${esc(l)}${mudAba(k) ? '<i class="pdot" title="Diferente do padrão da dissertação"></i>' : ''}</button>`).join('')}</div>
      <div class="ppanel" role="tabpanel">
        <p class="presumo">${esc(desc)}</p>
        ${(tab === 'poi' || tab === 'cobertura') && V.areas.length ? `<label class="field inline">Área<select id="r-area">${V.areas.map((a) => `<option value="${a}" ${a === areaSel ? 'selected' : ''}>${esc(areaLabel(a))}</option>`).join('')}</select></label>` : ''}
        ${tab === 'ensemble' ? sumWarn() : ''}
        ${ps.map(rowHtml).join('')}
        ${tab === 'poi' ? `<h3 class="pgroup">Pesos por tipo <span class="muted">— positivo aumenta o risco, negativo diminui, 0 ignora</span></h3>${poiTable()}` : ''}
        ${tab === 'cobertura' ? coberturaExtra() : ''}
        <div class="btn-row" style="margin-top:14px">
          <button class="btn primary" data-r="save" ${d ? '' : 'disabled'}>${icon('save')} Salvar${d ? ` (${d})` : ''}</button>
          <button class="btn" data-r="discard" ${d ? '' : 'disabled'}>${icon('x')} Descartar mudanças</button>
          ${botaoRestaurar('data-r="reset-tab"', { disabled: !mudAba(tab) })}
          ${V.nMudados ? botaoRestaurar('data-r="reset-all"', { label: 'Restaurar o mapa de risco inteiro' }) : ''}
        </div>
        ${d ? `<p class="note">${icon('info')} Há ${d} mudança(s) não salva(s). Use <b>Pré-visualizar</b> abaixo para ver o efeito num mês já previsto antes de salvar.</p>` : ''}
      </div>`;
  }

  function mesesDaArea(a) { return (fi?.months || []).filter((m) => m.areas.includes(a)).map((m) => m.tag).reverse(); }

  function svgMapa(res) {
    const fs = res.features.filter((f) => f.geometry);
    if (!fs.length) return '';
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);
    for (const f of fs) for (const poly of rings(f.geometry)) for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const W = 520, k = Math.cos(((y0 + y1) / 2) * Math.PI / 180);
    const sx = W / ((x1 - x0) * k || 1), H = Math.max(160, Math.min(520, (y1 - y0) * sx));
    const P = (x, y) => `${((x - x0) * k * sx).toFixed(1)},${((y1 - y) * sx).toFixed(1)}`;
    const cor = { entra: 'var(--risk-in, #d92d20)', sai: 'var(--risk-out, #2563eb)', fica: 'var(--risk-keep, #6b7280)', fora: 'transparent' };
    return `<svg class="prev-map" viewBox="0 0 ${W} ${H.toFixed(0)}" role="img" aria-label="Mapa das células que mudam">
      ${fs.map((f) => rings(f.geometry).map((poly) => `<path d="M${poly[0].map(([x, y]) => P(x, y)).join('L')}Z" fill="${cor[f.estado]}" stroke="var(--line)" stroke-width="0.4"><title>Célula ${f.id}: ${{ entra: 'entra no alto risco', sai: 'sai do alto risco', fica: 'continua alto risco', fora: 'fora do alto risco' }[f.estado]}</title></path>`).join('')).join('')}
    </svg>
    <div class="prev-leg"><span><i style="background:#d92d20"></i>entra no alto risco</span><span><i style="background:#2563eb"></i>sai</span><span><i style="background:#6b7280"></i>continua</span></div>`;
  }

  function renderPrev() {
    const box = $('#r-prev');
    const areasP = [...new Set((fi?.months || []).flatMap((m) => m.areas))].sort();
    if (!areasP.length) { box.innerHTML = `<h2>Pré-visualizar</h2><p class="muted">Faça uma Previsão primeiro: a pré-visualização recalcula só o Ensemble de um mês já previsto com os valores desta tela e mostra quais células entram e saem do alto risco.</p>`; return; }
    if (!prev.area || !areasP.includes(prev.area)) prev.area = areaSel && areasP.includes(areaSel) ? areaSel : areasP[0];
    const ms = mesesDaArea(prev.area);
    if (!prev.tag || !ms.includes(prev.tag)) prev.tag = ms[0];
    const r = prev.res;
    const running = panel?.isRunning();
    box.innerHTML = `<h2>Pré-visualizar</h2>
      <p class="muted">Recalcula só o Ensemble do mês escolhido (sem treinar nem prever de novo) com os valores da tela, salvos ou não, e compara com o Ensemble salvo dessa previsão.</p>
      <div class="sci-grid">
        <label class="field">Área<select id="pv-area" ${running ? 'disabled' : ''}>${areasP.map((a) => `<option value="${a}" ${a === prev.area ? 'selected' : ''}>${esc(areaLabel(a))}</option>`).join('')}</select></label>
        <label class="field">Mês previsto<select id="pv-tag" ${running ? 'disabled' : ''}>${ms.map((t) => `<option value="${t}" ${t === prev.tag ? 'selected' : ''}>${esc(monthLabel(t))}</option>`).join('')}</select></label>
      </div>
      <div class="btn-row" style="margin-top:10px"><button class="btn primary" data-r="preview" ${running ? 'disabled' : ''}>${icon('play')} Pré-visualizar</button></div>
      ${r ? `<div class="prev-res">
          <div class="kpis-mini"><div><b>${r.entram}</b><span>células entram no alto risco</span></div><div><b>${r.saem}</b><span>saem</span></div><div><b>${r.ficam}</b><span>continuam</span></div><div><b>${num(r.correlacao)}</b><span>correlação com o salvo</span></div></div>
          ${svgMapa(r)}
          ${r.entram + r.saem === 0 ? `<p class="note">${icon('check')} Nenhuma célula muda de faixa: com esses valores, o mapa de alto risco desse mês seria o mesmo.</p>` : ''}
        </div>` : ''}`;
  }

  async function load() {
    try { V = await call('risk:view', areaSel); areaSel = V.area; } catch (err) { toast(err.message, 'err'); return; }
    render();
  }

  function setDraft(k, v) {
    const p = V.schema.find((x) => x.k === k);
    if (near(v, V.valores[k])) delete draft.valores[k]; else draft.valores[k] = v;
    delete errs[k];
    if (p?.k === 'medio' || p?.k === 'alto') {
      if (!(val('medio') > val('alto'))) errs.medio = 'O alto + médio risco precisa ser maior que o alto risco.'; else delete errs.medio;
    }
    render();
  }

  el.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'r-area') { areaSel = t.value; load(); return; }
    if (t.id === 'pv-area') { prev.area = t.value; prev.tag = null; prev.res = null; renderPrev(); return; }
    if (t.id === 'pv-tag') { prev.tag = t.value; prev.res = null; renderPrev(); return; }
    if (t.matches('[data-rk]') && V) {
      const p = V.schema.find((x) => x.k === t.dataset.rk);
      if (p.tipo === 'bool') return setDraft(p.k, t.checked);
      if (p.tipo === 'choice') return setDraft(p.k, t.value);
      let n = Number(String(t.value).replace(',', '.'));
      if (p.tipo === 'pct') n /= 100;
      if (String(t.value).trim() === '' || !Number.isFinite(n)) { errs[p.k] = 'Informe um número.'; render(); return; }
      if (p.tipo === 'int' && !Number.isInteger(n)) { errs[p.k] = 'Use um número inteiro.'; render(); return; }
      if (n < p.min - 1e-12 || n > p.max + 1e-12) { errs[p.k] = `Use um valor entre ${fmtVal(p, p.min)} e ${fmtVal(p, p.max)}.`; render(); return; }
      setDraft(p.k, p.tipo === 'pct' ? Math.round(n * 1000) / 1000 : n);
    }
    if (t.matches('[data-poi]') && V) {
      const k = t.dataset.poi, n = Number(String(t.value).replace(',', '.'));
      if (!Number.isFinite(n) || n < -10 || n > 10) { toast('Use um peso entre -10 e 10.', 'err'); render(); return; }
      if (near(n, V.poi[k] ?? val('poi_padrao'))) delete draft.poi[k]; else draft.poi[k] = n;
      render();
    }
  });

  el.addEventListener('click', async (e) => {
    const tb = e.target.closest('[data-rtab]');
    if (tb) { tab = tb.dataset.rtab; saveTab(tab); render(); return; }
    const chip = e.target.closest('[data-rk-set]');
    if (chip) { setDraft(chip.dataset.rkSet, Number(chip.dataset.v)); return; }
    const one = e.target.closest('[data-rk-reset]');
    if (one) { const p = V.schema.find((x) => x.k === one.dataset.rkReset); setDraft(p.k, p.padrao); return; }
    const pr = e.target.closest('[data-poi-reset]');
    if (pr) { const k = pr.dataset.poiReset; draft.poi[k] = k in V.poiPadrao ? V.poiPadrao[k] : val('poi_padrao'); if (near(draft.poi[k], V.poi[k])) delete draft.poi[k]; render(); return; }
    const act = e.target.closest('[data-r]')?.dataset.r;
    if (!act) return;
    try {
      if (act === 'save') {
        if (Object.keys(errs).length) { toast(Object.values(errs)[0], 'err'); return; }
        V = await call('risk:set', { ...draft, area: areaSel });
        draft = { valores: {}, poi: {} };
        render();
        toast(V.nMudados ? 'Mapa de risco salvo. Vale a partir da próxima Previsão.' : 'Mapa de risco salvo: padrão da dissertação.', 'ok');
      }
      if (act === 'discard') { draft = { valores: {}, poi: {} }; for (const k of Object.keys(errs)) delete errs[k]; render(); }
      if (act === 'reset-tab') {
        const nome = V.abas.find(([k]) => k === tab)[1];
        if (!(await confirmarRestaurar(`Os valores da aba ${nome}`))) return;
        V = await call('risk:reset', tab, areaSel);
        for (const p of V.schema) if (p.aba === tab) delete draft.valores[p.k];
        if (tab === 'poi') draft.poi = {};
        render(); toast(`${nome}: padrão da dissertação restaurado.`, 'ok');
      }
      if (act === 'reset-all') {
        if (!(await confirmarRestaurar('Os valores do mapa de risco (Ensemble, pontos de interesse, cobertura e critérios da Validação)'))) return;
        V = await call('risk:reset', null, areaSel);
        draft = { valores: {}, poi: {} };
        render(); toast('Mapa de risco de volta ao padrão da dissertação.', 'ok');
      }
      if (act === 'preview') {
        if (Object.keys(errs).length) { toast(Object.values(errs)[0], 'err'); return; }
        prev.res = null; renderPrev();
        await panel.run({ area: prev.area, mes: prev.tag.replace('_', '-'), previa: true, rascunho: draft });
        scrollToEl($('#r-run'));
      }
    } catch (err) { toast(err.message, 'err', 9000); }
  });

  const panel = mountRunPanel($('#r-run'), 'ensemble', {
    onState: () => renderPrev(),
    onEnd: async (st) => {
      if (st === 'ok') { try { prev.res = await call('risk:previa', prev.area, prev.tag); } catch { prev.res = null; } }
      renderPrev(); load();
    },
  });

  call('forecast:info').then((f) => { fi = f; renderPrev(); }).catch(() => renderPrev());
  load();
  return () => panel.unmount();
}
