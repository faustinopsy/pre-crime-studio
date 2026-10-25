// Animação de cada fase do pipeline (canvas). Mostra, em linguagem visual, o que a fase faz.
// Uso: <pc-phase-anim phase="clean"></pc-phase-anim>
// Atributo opcional progress="0..1": durante uma execução,
// a animação segue o progresso em vez de repetir em ciclo.
// Respeita prefers-reduced-motion (mostra um quadro parado) e pausa fora da tela.

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function palette() {
  return {
    bg: css('--surface-2'), line: css('--line-strong'), text: css('--text'), muted: css('--muted'), faint: css('--faint'),
    accent: css('--accent'), accent2: css('--accent-2'), ok: css('--ok'), err: css('--err'), warn: css('--warn'), stale: css('--stale'),
    high: css('--risk-high'), mid: css('--risk-mid'), surface: css('--surface'), s3: css('--surface-3'),
  };
}
function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
const seg = (p, a, b) => clamp((p - a) / (b - a));
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function label(ctx, txt, x, y, c, size = 12, align = 'center', weight = 600) {
  ctx.fillStyle = c; ctx.font = `${weight} ${size}px ${css('--font') || 'sans-serif'}`; ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.fillText(txt, x, y);
}
function alpha(hex, a) {
  if (!hex.startsWith('#')) return hex;
  const n = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1, 7);
  const i = parseInt(n, 16);
  return `rgba(${(i >> 16) & 255},${(i >> 8) & 255},${i & 255},${a})`;
}

// Malha de células usada por Filtragem, Previsão e Validação (mesma "área" em todas)
function makeArea(cols, rows, seed = 7) {
  const r = rng(seed), cells = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const nx = (i + 0.5) / cols - 0.5, ny = (j + 0.5) / rows - 0.5;
    const blob = Math.hypot(nx * 1.15, ny * 1.35) + (r() - 0.5) * 0.12;
    if (blob > 0.5) continue;
    const water = Math.hypot(nx - 0.2, ny - 0.22) < 0.17 + (r() - 0.5) * 0.06;
    const heat = Math.max(0, 1 - Math.hypot(nx + 0.12, ny + 0.08) * 2.6) + r() * 0.35;
    cells.push({ i, j, water, heat, score: clamp(heat * 0.8 + r() * 0.3), hits: 0 });
  }
  const land = cells.filter((c) => !c.water).sort((a, b) => b.score - a.score);
  land.forEach((c, k) => { c.rank = k / land.length; });
  return { cols, rows, cells, land };
}
function gridGeom(w, h, area, box) {
  const s = Math.min(box.w / area.cols, box.h / area.rows);
  const ox = box.x + (box.w - s * area.cols) / 2, oy = box.y + (box.h - s * area.rows) / 2;
  return { s, at: (c) => [ox + c.i * s, oy + c.j * s] };
}

// ── Cenas ─────────────────────────────────────────────────────────────────────
const SCENES = {
  ssp: {
    loop: 7, steps: ['Escolher as planilhas', 'Conferir cada arquivo', 'Copiar para a pasta de trabalho'],
    draw(ctx, w, h, p, C) {
      const fx = w * 0.78, fy = h * 0.5;
      // pasta destino
      ctx.fillStyle = alpha(C.accent, 0.15); rr(ctx, fx - 60, fy - 36, 120, 80, 10); ctx.fill();
      ctx.strokeStyle = C.accent; ctx.lineWidth = 2; rr(ctx, fx - 60, fy - 36, 120, 80, 10); ctx.stroke();
      ctx.fillStyle = C.accent; rr(ctx, fx - 60, fy - 46, 50, 14, 4); ctx.fill();
      label(ctx, 'dados_ssp', fx, fy + 4, C.text, 12);
      const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
      years.forEach((y, k) => {
        const t0 = k * 0.1, q = ease(seg(p, t0, t0 + 0.3));
        const sx = w * 0.06 + 30 + k * Math.min(64, w * 0.07), sy = h * 0.62;
        const x = sx + (fx - sx) * q, yy = sy + (fy - sy) * q - Math.sin(q * Math.PI) * 60;
        const checked = p > t0 + 0.12;
        if (q >= 1) return;
        ctx.fillStyle = C.surface; rr(ctx, x - 22, yy - 14, 44, 30, 4); ctx.fill();
        ctx.strokeStyle = checked ? C.ok : C.line; ctx.lineWidth = 1.5; rr(ctx, x - 22, yy - 14, 44, 30, 4); ctx.stroke();
        ctx.strokeStyle = alpha(C.ok, 0.6); ctx.lineWidth = 1;
        for (let r = 1; r < 3; r++) { ctx.beginPath(); ctx.moveTo(x - 18, yy - 14 + r * 9); ctx.lineTo(x + 18, yy - 14 + r * 9); ctx.stroke(); }
        if (q === 0) label(ctx, String(y), x, yy + 26, C.muted, 11);
        if (checked && q < 0.6) label(ctx, '✓', x + 20, yy - 16, C.ok, 13, 'center', 700);
      });
      label(ctx, 'planilhas escolhidas', w * 0.06 + 30 + 3 * Math.min(64, w * 0.07), h * 0.62 + 50, C.faint, 11, 'center', 500);
      const n = years.filter((_, k) => p >= k * 0.1 + 0.3).length;
      label(ctx, `${n} de ${years.length} planilhas copiadas`, fx, fy + 58, C.muted, 12, 'center', 500);
      return Math.min(2, Math.floor(p * 3));
    },
  },

  clean: {
    loop: 8, steps: ['Ler as planilhas', 'Filtrar cidade, ocorrência e veículo', 'Tirar datas inválidas', 'Tirar registros repetidos', 'Gravar a base unificada'],
    init() {
      const r = rng(11);
      return Array.from({ length: 70 }, (_, k) => {
        const x = r();
        const kind = x < 0.72 ? 'ok' : x < 0.84 ? 'fora' : x < 0.9 ? 'data' : 'dup';
        return { k, kind, off: r(), lane: r() * 2 - 1 };
      });
    },
    draw(ctx, w, h, p, C, parts) {
      const x0 = w * 0.06, xf = w * 0.5, x1 = w * 0.88, cy = h * 0.42;
      // funil
      ctx.fillStyle = alpha(C.accent, 0.08); ctx.strokeStyle = C.line; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(xf - 70, cy - 70); ctx.lineTo(xf - 8, cy - 14); ctx.lineTo(xf + 8, cy - 14); ctx.lineTo(xf + 70, cy - 70); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(xf - 70, cy + 70); ctx.lineTo(xf - 8, cy + 14); ctx.lineTo(xf + 8, cy + 14); ctx.lineTo(xf + 70, cy + 70); ctx.stroke();
      // base unificada
      ctx.fillStyle = alpha(C.ok, 0.12); ctx.strokeStyle = C.ok;
      ctx.beginPath(); ctx.ellipse(x1, cy - 26, 30, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1 - 30, cy - 26); ctx.lineTo(x1 - 30, cy + 26); ctx.ellipse(x1, cy + 26, 30, 9, 0, Math.PI, 0, true); ctx.lineTo(x1 + 30, cy - 26); ctx.stroke();
      label(ctx, 'base unificada', x1, cy + 52, C.muted, 11, 'center', 500);
      label(ctx, 'planilhas', x0 + 10, cy + 84, C.muted, 11, 'center', 500);
      const bins = { fora: [w * 0.38, 'outra cidade/tipo', C.warn], data: [w * 0.5, 'data inválida', C.err], dup: [w * 0.62, 'repetido', C.stale] };
      for (const [, [bx, txt, c]] of Object.entries(bins)) { label(ctx, txt, bx, h - 18, c, 11, 'center', 600); }
      const cnt = { lidos: 0, fora: 0, unicos: 0 };
      for (const q of parts) {
        const t = (p * 1.6 - q.off * 0.9);
        if (t < 0) continue;
        cnt.lidos++;
        let x, y, col = C.muted, a = 1;
        if (t < 0.5) { const u = t / 0.5; x = x0 + (xf - x0) * u; y = cy + q.lane * 60 * (1 - u * 0.85); }
        else if (q.kind !== 'ok') {
          const u = clamp((t - 0.5) / 0.35); const [bx, , c] = bins[q.kind];
          x = xf + (bx - xf) * u; y = cy + (h - 40 - cy) * ease(u); col = c; a = 1 - clamp((t - 0.85) / 0.3);
          if (u >= 0.2) cnt.fora++;
        } else {
          const u = clamp((t - 0.5) / 0.45); x = xf + (x1 - xf) * u; y = cy + q.lane * 8 * u; col = C.accent; a = u >= 1 ? 0 : 1;
          if (u >= 1) cnt.unicos++;
        }
        ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
      }
      label(ctx, `lidos ${cnt.lidos}   ·   descartados ${cnt.fora}   ·   gravados ${cnt.unicos}`, w * 0.5, 18, C.text, 12, 'center', 600);
      return p < 0.2 ? 0 : p < 0.38 ? 1 : p < 0.5 ? 2 : p < 0.65 ? 3 : 4;
    },
  },

  filter: {
    loop: 9, steps: ['Malha de células da área', 'Tirar células sem rua (água, mata)', 'Colocar cada crime na sua célula'],
    init() { const a = makeArea(26, 14, 7); const r = rng(5); a.drops = Array.from({ length: 90 }, () => { const c = a.land[Math.floor(Math.pow(r(), 2.2) * a.land.length)]; return { c, off: r() }; }); return a; },
    draw(ctx, w, h, p, C, A) {
      const g = gridGeom(w, h, A, { x: w * 0.05, y: 30, w: w * 0.9, h: h - 50 });
      const fade = ease(seg(p, 0.22, 0.42));
      const hits = new Map();
      for (const d of A.drops) { const t = seg(p, 0.48 + d.off * 0.42, 0.52 + d.off * 0.42); if (t >= 1) hits.set(d.c, (hits.get(d.c) || 0) + 1); }
      for (const c of A.cells) {
        const [x, y] = g.at(c);
        if (c.water) {
          ctx.globalAlpha = 1 - fade;
          ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.strokeRect(x + 1, y + 1, g.s - 2, g.s - 2);
          ctx.fillStyle = alpha('#3b82f6', 0.35 * fade + 0.1); ctx.fillRect(x + 1, y + 1, g.s - 2, g.s - 2);
          ctx.globalAlpha = 1; continue;
        }
        const n = hits.get(c) || 0;
        ctx.fillStyle = n ? alpha(C.accent, Math.min(0.85, 0.18 + n * 0.16)) : C.surface;
        ctx.fillRect(x + 1, y + 1, g.s - 2, g.s - 2);
        ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.strokeRect(x + 1, y + 1, g.s - 2, g.s - 2);
      }
      for (const d of A.drops) {
        const t = seg(p, 0.48 + d.off * 0.42, 0.52 + d.off * 0.42);
        if (t <= 0 || t >= 1) continue;
        const [x, y] = g.at(d.c);
        ctx.fillStyle = C.text; ctx.beginPath(); ctx.arc(x + g.s / 2, 10 + (y + g.s / 2 - 10) * ease(t), 3, 0, Math.PI * 2); ctx.fill();
      }
      const kept = A.land.length, gone = A.cells.length - kept;
      label(ctx, p < 0.22 ? `${A.cells.length} células` : `${kept} células mantidas · ${gone} sem rua removidas`, w / 2, 14, C.text, 12);
      return p < 0.22 ? 0 : p < 0.46 ? 1 : 2;
    },
  },

  features: {
    loop: 10, steps: ['Contar crimes por semana', 'Olhar as 24 semanas anteriores', 'Resumir as últimas 4 semanas', 'Somar os vizinhos', 'Alvo: haverá crime nas próximas 4?'],
    init() { const r = rng(3); return Array.from({ length: 40 }, (_, k) => Math.max(0, Math.round(1.6 + Math.sin(k / 3) * 1.2 + (r() - 0.5) * 2.4))); },
    draw(ctx, w, h, p, C, weeks) {
      const n = weeks.length, x0 = w * 0.04, bw = (w * 0.62) / n, base = h * 0.7, max = 5;
      const shift = Math.floor(ease(seg(p, 0.15, 0.9)) * 8);
      const end = 28 + shift; // semana "atual"
      // janela 24 lags e alvo 4
      const showLag = p > 0.15, showAgg = p > 0.38, showNb = p > 0.56, showT = p > 0.72;
      if (showLag) { ctx.fillStyle = alpha(C.accent, 0.1); ctx.fillRect(x0 + (end - 24) * bw, 26, 24 * bw, base - 22); label(ctx, '24 semanas anteriores', x0 + (end - 12) * bw, 18, C.accent, 11); }
      if (showT) { ctx.strokeStyle = C.warn; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.strokeRect(x0 + end * bw, 26, 4 * bw, base - 22); ctx.setLineDash([]); label(ctx, 'alvo', x0 + (end + 2) * bw, 18, C.warn, 11); }
      weeks.forEach((v, k) => {
        const grow = ease(seg(p, k * 0.004, 0.12 + k * 0.004));
        const bh = (v / max) * (base - 40) * grow;
        const inLag = showLag && k >= end - 24 && k < end, inAgg = showAgg && k >= end - 4 && k < end, inT = showT && k >= end && k < end + 4;
        ctx.fillStyle = inT ? alpha(C.warn, 0.7) : inAgg ? C.accent2 : inLag ? C.accent : C.s3;
        ctx.fillRect(x0 + k * bw + 1, base - bh, bw - 2, bh);
      });
      ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x0, base + 0.5); ctx.lineTo(x0 + n * bw, base + 0.5); ctx.stroke();
      label(ctx, 'semanas →', x0 + n * bw - 30, base + 14, C.muted, 10, 'center', 500);
      // painel lateral
      const px = w * 0.72, py = 30;
      if (showAgg) {
        const last = weeks.slice(end - 4, end), mean = last.reduce((a, b) => a + b, 0) / 4;
        [['média', mean.toFixed(1)], ['máximo', Math.max(...last)], ['tendência', (last[3] + last[2] - last[1] - last[0]) >= 0 ? '↑' : '↓']].forEach(([k, v], i) => {
          label(ctx, k, px, py + 8 + i * 22, C.muted, 11, 'left', 500); label(ctx, String(v), px + 90, py + 8 + i * 22, C.accent2, 13, 'left', 700);
        });
      }
      if (showNb) {
        const cx = px + 40, cy = h * 0.68, s = 16;
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const center = !a && !b; const pulse = center ? 1 : 0.35 + 0.35 * Math.sin(p * 40 + a * 2 + b);
          ctx.fillStyle = center ? C.accent : alpha(C.accent2, pulse); ctx.fillRect(cx + a * (s + 2) - s / 2, cy + b * (s + 2) - s / 2, s, s);
        }
        label(ctx, 'vizinhos', cx + 60, cy, C.muted, 11, 'left', 500);
      }
      return p < 0.15 ? 0 : p < 0.38 ? 1 : p < 0.56 ? 2 : p < 0.72 ? 3 : 4;
    },
  },

  train: {
    loop: 10, steps: ['Separar o histórico', 'Random Forest (árvores)', 'LSTM (memória da sequência)', 'Transformer (atenção)', 'Salvar os modelos'],
    draw(ctx, w, h, p, C) {
      const lanes = [['Random Forest', C.ok, 0.1, 0.55], ['LSTM', C.accent, 0.12, 0.85], ['Transformer', C.accent2, 0.14, 0.8]];
      const top = 22, lh = (h - 40) / 3;
      lanes.forEach(([name, col, a, b], i) => {
        const y = top + i * lh, q = seg(p, a, b);
        label(ctx, name, w * 0.03, y + lh / 2 - 6, C.text, 13, 'left', 700);
        label(ctx, q >= 1 ? 'salvo' : q > 0 ? 'treinando' : 'aguardando', w * 0.03, y + lh / 2 + 12, q >= 1 ? C.ok : C.muted, 11, 'left', 500);
        // 8 áreas
        const cx = w * 0.22, cw = (w * 0.42) / 8;
        for (let k = 0; k < 8; k++) {
          const f = clamp(q * 8 - k);
          ctx.fillStyle = C.s3; rr(ctx, cx + k * cw + 2, y + lh / 2 - 9, cw - 4, 18, 4); ctx.fill();
          if (f > 0) { ctx.fillStyle = col; rr(ctx, cx + k * cw + 2, y + lh / 2 - 9, (cw - 4) * f, 18, 4); ctx.fill(); }
          if (i === 0) label(ctx, `área ${k + 1}`, cx + k * cw + cw / 2, top - 10, C.faint, 9, 'center', 500);
        }
        // curva de perda
        const lx = w * 0.7, lw = w * 0.26, ly = y + 6, lhh = lh - 18;
        ctx.strokeStyle = C.line; ctx.strokeRect(lx, ly, lw, lhh);
        ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
        const pts = Math.floor(60 * q);
        for (let s = 0; s <= pts; s++) { const u = s / 60; const v = 0.15 + 0.75 * Math.exp(-u * 3.5) + 0.04 * Math.sin(u * 40 + i); const X = lx + u * lw, Y = ly + lhh - v * lhh; s ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }
        ctx.stroke(); ctx.lineWidth = 1;
        if (i === 0) label(ctx, 'erro caindo', lx + lw / 2, top - 10, C.faint, 9, 'center', 500);
      });
      return p < 0.1 ? 0 : p < 0.55 ? 1 : p < 0.75 ? 2 : p < 0.85 ? 3 : 4;
    },
  },

  predict: {
    loop: 9, steps: ['Cada modelo dá um score por célula', 'Combinar os três (ensemble)', 'Top 10% vermelho · próximos 10% amarelo'],
    init() { return makeArea(26, 14, 7); },
    draw(ctx, w, h, p, C, A) {
      const smallW = w * 0.2, gap = 10;
      const names = ['RF', 'LSTM', 'Transformer'];
      names.forEach((nm, k) => {
        const g = gridGeom(w, h, A, { x: w * 0.02, y: 18 + k * ((h - 24) / 3), w: smallW, h: (h - 24) / 3 - gap });
        const show = ease(seg(p, k * 0.08, 0.3 + k * 0.08));
        for (const c of A.land) { const [x, y] = g.at(c); const v = clamp(c.score + (Math.sin(c.i * 3 + k) * 0.15)); ctx.fillStyle = alpha(C.accent, 0.08 + v * 0.8 * show); ctx.fillRect(x, y, g.s - 0.5, g.s - 0.5); }
        label(ctx, nm, w * 0.02 + smallW + 6, 18 + k * ((h - 24) / 3) + 12, C.muted, 10, 'left', 600);
      });
      // setas
      const m = ease(seg(p, 0.35, 0.5));
      ctx.strokeStyle = alpha(C.accent, m); ctx.lineWidth = 2;
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.moveTo(w * 0.3, 18 + (k + 0.5) * ((h - 24) / 3)); ctx.lineTo(w * 0.36, h / 2); ctx.stroke(); }
      ctx.lineWidth = 1;
      const g = gridGeom(w, h, A, { x: w * 0.38, y: 22, w: w * 0.58, h: h - 30 });
      const cls = seg(p, 0.6, 0.8);
      for (const c of A.land) {
        const [x, y] = g.at(c);
        let fill = alpha(C.muted, 0.06 + c.score * 0.4 * m);
        if (cls > 0 && c.rank < 0.1) fill = alpha(C.high, 0.25 + 0.6 * cls);
        else if (cls > 0 && c.rank < 0.2) fill = alpha(C.mid, 0.25 + 0.55 * cls);
        ctx.fillStyle = fill; ctx.fillRect(x + 0.5, y + 0.5, g.s - 1, g.s - 1);
        ctx.strokeStyle = C.line; ctx.strokeRect(x + 0.5, y + 0.5, g.s - 1, g.s - 1);
      }
      label(ctx, 'Ensemble', w * 0.66, 12, C.text, 12);
      return p < 0.35 ? 0 : p < 0.6 ? 1 : 2;
    },
  },

  validate: {
    loop: 9, steps: ['Mapa previsto do mês', 'Chegam os crimes reais da SSP', 'Contar o que caiu nas zonas de alerta'],
    init() { const a = makeArea(26, 14, 7); const r = rng(21); a.drops = Array.from({ length: 70 }, () => ({ c: a.land[Math.floor(Math.pow(r(), 1.6) * a.land.length)], off: r() })); return a; },
    draw(ctx, w, h, p, C, A) {
      const g = gridGeom(w, h, A, { x: w * 0.04, y: 26, w: w * 0.62, h: h - 36 });
      for (const c of A.land) {
        const [x, y] = g.at(c);
        ctx.fillStyle = c.rank < 0.1 ? alpha(C.high, 0.75) : c.rank < 0.2 ? alpha(C.mid, 0.7) : C.surface;
        ctx.fillRect(x + 0.5, y + 0.5, g.s - 1, g.s - 1); ctx.strokeStyle = C.line; ctx.strokeRect(x + 0.5, y + 0.5, g.s - 1, g.s - 1);
      }
      let inZ = 0, out = 0;
      for (const d of A.drops) {
        const t = seg(p, 0.15 + d.off * 0.6, 0.2 + d.off * 0.6);
        if (t <= 0) continue;
        const [x, y] = g.at(d.c); const hit = d.c.rank < 0.2;
        const cx = x + g.s / 2, cy = 8 + (y + g.s / 2 - 8) * ease(t);
        if (t >= 1) hit ? inZ++ : out++;
        ctx.fillStyle = t < 1 ? C.text : hit ? C.ok : C.err;
        ctx.beginPath(); ctx.arc(cx, cy, t < 1 ? 3 : 3.4, 0, Math.PI * 2); ctx.fill();
      }
      const px = w * 0.72, tot = inZ + out || 1;
      label(ctx, 'nas zonas de alerta', px, h * 0.3, C.muted, 12, 'left', 500); label(ctx, String(inZ), px, h * 0.3 + 26, C.ok, 26, 'left', 700);
      label(ctx, 'fora das zonas', px, h * 0.62, C.muted, 12, 'left', 500); label(ctx, String(out), px, h * 0.62 + 26, C.err, 26, 'left', 700);
      label(ctx, `${Math.round((inZ / tot) * 100)}% capturados em 20% da área`, px, h - 16, C.text, 12, 'left', 600);
      return p < 0.15 ? 0 : p < 0.75 ? 1 : 2;
    },
  },

  publish: {
    loop: 8, steps: ['Escolher meses e áreas', 'Montar o pacote', 'Pré-visualizar', 'Enviar ao servidor'],
    draw(ctx, w, h, p, C) {
      const y = h / 2;
      const nodes = [[w * 0.14, 'Mapa e métricas'], [w * 0.42, 'Pacote'], [w * 0.66, 'Pré-visualização'], [w * 0.88, 'Servidor Node']];
      nodes.forEach(([x, txt], k) => {
        const on = p > k * 0.22;
        ctx.fillStyle = on ? alpha(C.accent, 0.15) : C.surface; ctx.strokeStyle = on ? C.accent : C.line; ctx.lineWidth = 2;
        rr(ctx, x - 46, y - 32, 92, 64, 10); ctx.fill(); ctx.stroke();
        label(ctx, txt, x, y + 48, on ? C.text : C.muted, 12);
        if (k === 0) { ctx.fillStyle = alpha(C.high, 0.8); ctx.fillRect(x - 26, y - 14, 14, 12); ctx.fillStyle = alpha(C.mid, 0.8); ctx.fillRect(x - 10, y - 2, 14, 12); ctx.fillStyle = C.s3; ctx.fillRect(x + 6, y - 14, 14, 12); }
        if (k === 1) { ctx.strokeStyle = on ? C.accent : C.line; ctx.beginPath(); ctx.moveTo(x - 20, y - 10); ctx.lineTo(x, y - 20); ctx.lineTo(x + 20, y - 10); ctx.lineTo(x + 20, y + 14); ctx.lineTo(x - 20, y + 14); ctx.closePath(); ctx.stroke(); }
        if (k === 2) { ctx.strokeStyle = on ? C.accent : C.line; ctx.beginPath(); ctx.ellipse(x, y, 22, 12, 0, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = on ? C.accent : C.line; ctx.fill(); }
        if (k === 3) { for (let r = 0; r < 3; r++) { ctx.strokeStyle = on ? C.accent : C.line; rr(ctx, x - 22, y - 20 + r * 14, 44, 10, 3); ctx.stroke(); ctx.fillStyle = on && Math.sin(p * 50 + r) > 0 ? C.ok : C.line; ctx.beginPath(); ctx.arc(x + 15, y - 15 + r * 14, 2, 0, Math.PI * 2); ctx.fill(); } }
        if (k < 3) {
          const t = seg(p, k * 0.22 + 0.05, k * 0.22 + 0.22);
          ctx.strokeStyle = C.line; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x + 50, y); ctx.lineTo(nodes[k + 1][0] - 50, y); ctx.stroke(); ctx.setLineDash([]);
          if (t > 0 && t < 1) { ctx.fillStyle = C.accent; ctx.beginPath(); ctx.arc(x + 50 + (nodes[k + 1][0] - 100 - x) * t, y, 4, 0, Math.PI * 2); ctx.fill(); }
        }
      });
      return Math.min(3, Math.floor(p / 0.22));
    },
  },
};

class PcPhaseAnim extends HTMLElement {
  static observedAttributes = ['progress'];
  #raf = 0; #t0 = 0; #state = null; #C = null; #visible = true; #io = null; #ro = null; #lastStep = -1;

  connectedCallback() {
    const id = this.getAttribute('phase');
    this.scene = SCENES[id];
    if (!this.scene) return;
    this.innerHTML = `<canvas role="img" aria-label="Animação: ${this.scene.steps.join(', ')}"></canvas><ol class="anim-steps">${this.scene.steps.map((s, i) => `<li data-i="${i}"><span>${i + 1}</span>${s}</li>`).join('')}</ol>`;
    this.canvas = this.querySelector('canvas');
    this.stepsEl = [...this.querySelectorAll('.anim-steps li')];
    this.#state = this.scene.init ? this.scene.init() : null;
    this.#C = palette();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#ro = new ResizeObserver(() => this.#resize()); this.#ro.observe(this);
    this.#io = new IntersectionObserver((e) => { this.#visible = e[0].isIntersecting; }); this.#io.observe(this);
    this.#themeObs = new MutationObserver(() => { this.#C = palette(); }); this.#themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.#resize();
    this.#t0 = performance.now();
    const loop = (now) => { this.#raf = requestAnimationFrame(loop); if (this.#visible && !document.hidden) this.#frame(now); };
    if (this.reduced) this.#frame(0, 0.98); else this.#raf = requestAnimationFrame(loop);
  }
  #themeObs = null;
  disconnectedCallback() { cancelAnimationFrame(this.#raf); this.#ro?.disconnect(); this.#io?.disconnect(); this.#themeObs?.disconnect(); }
  attributeChangedCallback() { if (this.reduced) this.#frame(0); }

  #resize() {
    if (!this.canvas) return;
    const w = this.clientWidth || 600, h = Number(this.getAttribute('height') || 220), dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.w = w; this.h = h; this.dpr = dpr;
    if (this.reduced) this.#frame(0, 0.98);
  }
  #frame(now, fixed) {
    const ctx = this.canvas.getContext('2d');
    const prog = this.getAttribute('progress');
    const p = fixed ?? (prog != null && prog !== '' ? clamp(Number(prog)) : ((now - this.#t0) / 1000 % this.scene.loop) / this.scene.loop);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const step = this.scene.draw(ctx, this.w, this.h, p, this.#C, this.#state) ?? 0;
    if (step !== this.#lastStep) { this.#lastStep = step; this.stepsEl.forEach((li, i) => { li.classList.toggle('on', i === step); li.classList.toggle('done', i < step); }); }
  }
}
customElements.define('pc-phase-anim', PcPhaseAnim);
