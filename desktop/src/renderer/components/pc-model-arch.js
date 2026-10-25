// Arquitetura dos modelos em 3D, animada: Random Forest, LSTM, Transformer e Ensemble.
// Uso: <pc-model-arch></pc-model-arch>
//   atributo model="rf|lstm|transformer|ensemble" escolhe a aba;
//   atributos active, epoch, epochs, loss mostram o treino em andamento por cima.
// Desenho em canvas 2D com projeção em perspectiva (sem bibliotecas). Arraste para girar.
// Os números das legendas são os hiperparâmetros de pipeline/config.py (ML_CONFIG e
// ENSEMBLE_CONFIG). Respeita prefers-reduced-motion e pausa fora da tela.

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const palette = () => ({
  bg: css('--bg-2'), line: css('--line-strong'), text: css('--text'), muted: css('--muted'), faint: css('--faint'),
  accent: css('--accent'), accent2: css('--accent-2'), ok: css('--ok'), err: css('--err'), warn: css('--warn'),
  high: css('--risk-high') || css('--err'), mid: css('--risk-mid') || css('--warn'), surface: css('--surface'), s3: css('--surface-3'),
  dark: document.documentElement.dataset.theme === 'dark',
});
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const ease = (x) => { x = clamp(x); return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; };
const seg = (p, a, b) => clamp((p - a) / (b - a));
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function rgba(hex, a) {
  if (!hex || !hex.startsWith('#')) return hex;
  const n = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1, 7);
  const i = parseInt(n, 16);
  return `rgba(${(i >> 16) & 255},${(i >> 8) & 255},${i & 255},${a})`;
}
function shade(hex, f) { // f<1 escurece, f>1 clareia
  if (!hex || !hex.startsWith('#')) return hex;
  const n = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1, 7);
  const i = parseInt(n, 16);
  const ch = (v) => Math.round(clamp(f < 1 ? v * f : v + (255 - v) * (f - 1), 0, 255));
  return `rgb(${ch((i >> 16) & 255)},${ch((i >> 8) & 255)},${ch(i & 255)})`;
}
const nf2 = (v) => v.toFixed(2).replace('.', ',');
const nfx = (v) => String(v).replace('.', ',');
const nfi = (v) => Number(v).toLocaleString('pt-BR');
// Legendas com os hiperparâmetros em uso (os da tela Treino); sem setParams, os recomendados.
const PARAMS_FN = {
  rf: (p) => [['Árvores', `${nfi(p.n_estimators)} (5 no desenho)`], ['Profundidade', p.max_depth == null ? 'sem limite' : `até ${p.max_depth}`], ['Entradas', '24 semanas + vizinhos'], ['Classes', 'balanceadas'], ['Roda em', 'processador']],
  lstm: (p) => [['Memória', `${p.hidden_dim} unidades, ${p.layer_dim} camada${p.layer_dim > 1 ? 's' : ''}`], ['Dropout', nfx(p.dropout_prob)], ['Épocas', String(p.epochs)], ['Lote', `${nfi(p.batch_size)} linhas`], ['Peso dos positivos', nfx(p.pos_weight)], ['Roda em', 'placa de vídeo (CUDA) ou processador']],
  transformer: (p) => [['Embedding', String(p.embed_dim)], ['Cabeças de atenção', String(p.num_heads)], ['Feed-forward', String(p.ff_dim)], ['Camadas', String(p.num_layers)], ['Dropout', nfx(p.dropout_prob)], ['Épocas', String(p.epochs)], ['Lote', `${nfi(p.batch_size)} linhas`]],
};
const HP_KEY = { rf: 'RF', lstm: 'LSTM', transformer: 'Transformer' };

// ── Motor 3D mínimo ───────────────────────────────────────────────────────────
class Scene3D {
  constructor(ctx, w, h, cam, C) { this.ctx = ctx; this.w = w; this.h = h; this.cam = cam; this.C = C; this.items = []; }
  P(p) {
    const { yaw, pitch, dist, zoom, cx = 0, cy: ty = 0 } = this.cam;
    const px = p[0] - cx, py = p[1] - ty;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const x = px * cy - p[2] * sy, z = px * sy + p[2] * cy;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const y = py * cp - z * sp, zz = py * sp + z * cp + dist;
    const s = (Math.min(this.w, this.h * 1.9) * zoom) / Math.max(0.5, zz);
    return { x: this.w / 2 + x * s, y: this.h * 0.54 - y * s, z: zz, s };
  }
  sphere(p, r, color, { glow = 0, alpha = 1 } = {}) {
    const q = this.P(p);
    this.items.push({ z: q.z, d: (ctx) => {
      const R = Math.max(1.2, r * q.s);
      if (glow > 0) { ctx.fillStyle = rgba(color, 0.18 * glow * alpha); ctx.beginPath(); ctx.arc(q.x, q.y, R * 2.4, 0, 7); ctx.fill(); }
      const g = ctx.createRadialGradient(q.x - R * 0.35, q.y - R * 0.35, R * 0.1, q.x, q.y, R);
      g.addColorStop(0, shade(color, 1.45)); g.addColorStop(1, shade(color, 0.75));
      ctx.globalAlpha = alpha; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.x, q.y, R, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    } });
  }
  line(a, b, color, { width = 1, alpha = 1, dash = null } = {}) {
    const p = this.P(a), q = this.P(b);
    this.items.push({ z: (p.z + q.z) / 2 + 0.01, d: (ctx) => {
      ctx.strokeStyle = rgba(color, alpha); ctx.lineWidth = Math.max(0.5, width * (p.s + q.s) / 2 / 60);
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]);
    } });
  }
  curve(a, ctl, b, color, { width = 1, alpha = 1, n = 16 } = {}) {
    let prev = a;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const p = [u * u * a[0] + 2 * u * t * ctl[0] + t * t * b[0], u * u * a[1] + 2 * u * t * ctl[1] + t * t * b[1], u * u * a[2] + 2 * u * t * ctl[2] + t * t * b[2]];
      this.line(prev, p, color, { width, alpha }); prev = p;
    }
  }
  box(c, [w, h, d], color, { alpha = 1, edge = null, glow = 0 } = {}) {
    const [x, y, z] = c, hw = w / 2, hh = h / 2, hd = d / 2;
    const V = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]].map(([a, b, e]) => this.P([x + a * hw, y + b * hh, z + e * hd]));
    const faces = [[0, 1, 2, 3, 0.85], [5, 4, 7, 6, 0.8], [4, 0, 3, 7, 0.7], [1, 5, 6, 2, 0.75], [3, 2, 6, 7, 1.15], [4, 5, 1, 0, 0.55]];
    for (const [a, b, e, f, light] of faces) {
      const pa = V[a], pb = V[b], pc = V[e];
      const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
      if (cross > 0) continue; // face de costas
      const zf = (V[a].z + V[b].z + V[e].z + V[f].z) / 4;
      this.items.push({ z: zf, d: (ctx) => {
        ctx.globalAlpha = alpha;
        if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 14 * glow; }
        ctx.fillStyle = shade(color, light);
        ctx.beginPath(); ctx.moveTo(V[a].x, V[a].y); ctx.lineTo(V[b].x, V[b].y); ctx.lineTo(V[e].x, V[e].y); ctx.lineTo(V[f].x, V[f].y); ctx.closePath(); ctx.fill();
        ctx.shadowBlur = 0;
        if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = 0.8; ctx.stroke(); }
        ctx.globalAlpha = 1;
      } });
    }
  }
  text(p, txt, color, { size = 12, weight = 600, align = 'center', bg = null } = {}) {
    const q = this.P(p);
    this.items.push({ z: -1e6 + q.z * 1e-3, d: (ctx) => {
      ctx.font = `${weight} ${size}px ${css('--font') || 'sans-serif'}`; ctx.textAlign = align; ctx.textBaseline = 'middle';
      if (bg) {
        const w = ctx.measureText(txt).width + 10, x0 = align === 'center' ? q.x - w / 2 : align === 'right' ? q.x - w : q.x - 5;
        ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x0, q.y - size * 0.8, w, size * 1.6, 5); ctx.fill();
      }
      ctx.fillStyle = color; ctx.fillText(txt, q.x, q.y);
    } });
  }
  flush() { this.items.sort((a, b) => b.z - a.z); for (const it of this.items) it.d(this.ctx); this.items = []; }
}

// ── Cenas ─────────────────────────────────────────────────────────────────────
const SCENES = {
  rf: {
    title: 'Random Forest', loop: 9, cam: { yaw: -0.3, pitch: 0.32, dist: 14, zoom: 0.8, cy: 0.45 },
    captions: [[0, 'O histórico da célula (24 semanas e vizinhos) entra em cada árvore'], [0.2, 'Cada árvore faz perguntas: "houve crime 3 semanas atrás?", "os vizinhos tiveram mais de 2?"'],
      [0.65, 'Cada árvore vota: crime ou não crime'], [0.85, 'A proporção de votos vira a probabilidade da célula']],
    params: [['Árvores', '150 (5 no desenho)'], ['Profundidade', 'até 20'], ['Entradas', '24 semanas + vizinhos'], ['Classes', 'balanceadas'], ['Roda em', 'processador']],
    init() {
      const r = rng(11);
      return { paths: Array.from({ length: 5 }, () => [0, 1, 2].map(() => (r() > 0.5 ? 1 : 0))), bars: Array.from({ length: 24 }, () => r()) };
    },
    draw(S, p, C, st) {
      const node = (k, L, i) => { const tx = -4.8 + k * 2.4, tz = Math.pow(k - 2, 2) * 0.45; return [tx + ((i + 0.5) / 2 ** L - 0.5) * 1.75, 2.0 - L * 1.05, tz]; };
      // entrada
      st.bars.forEach((b, i) => S.box([-2.9 + i * 0.25, 3.15 + b * 0.25, -1.6], [0.17, 0.1 + b * 0.5, 0.17], i > 20 ? C.accent : C.accent2, { alpha: 0.9 }));
      S.text([-3.6, 3.3, -1.6], 'histórico da célula', C.muted, { size: 11, align: 'right' });
      const votes = [];
      for (let k = 0; k < 5; k++) {
        const path = st.paths[k];
        let idx = [0];
        for (let L = 1; L <= 3; L++) idx.push(idx[L - 1] * 2 + path[L - 1]);
        for (let L = 0; L <= 3; L++) for (let i = 0; i < 2 ** L; i++) {
          const pos = node(k, L, i);
          if (L < 3) for (const c of [0, 1]) {
            const on = idx[L] === i && idx[L + 1] === i * 2 + c && p > 0.2 + (L + 1) * 0.15;
            S.line(pos, node(k, L + 1, i * 2 + c), on ? C.accent : C.line, { width: on ? 3 : 1.2, alpha: on ? 1 : 0.6 });
          }
          const visited = idx[L] === i && p > 0.2 + L * 0.15;
          const leaf = L === 3;
          const vote = leaf && visited && (k + i) % 3 !== 0;
          if (leaf && visited) votes.push(vote);
          S.sphere(pos, leaf ? 0.14 : 0.17, leaf && visited ? (vote ? C.high : C.ok) : visited ? C.accent : C.s3 || C.line, { glow: visited ? 0.6 : 0 });
        }
        if (k === 2 && p > 0.2 && p < 0.65) S.text([node(k, 0, 0)[0], 2.65, node(k, 0, 0)[2]], 'semana −3 > 0 ?', C.text, { size: 11, bg: rgba(C.surface, 0.9) });
        if (k === 0 && p > 0.35 && p < 0.65) S.text([node(k, 1, idx[1])[0] - 0.2, 1.55, node(k, 1, 0)[2]], 'vizinhos > 2 ?', C.text, { size: 11, bg: rgba(C.surface, 0.9) });
        // amostra descendo
        const q1 = seg(p, 0.02, 0.2);
        if (q1 > 0 && q1 < 1) S.sphere(lerp3([0, 3.2, -1.6], node(k, 0, 0), ease(q1)), 0.16, C.accent, { glow: 1 });
        for (let L = 0; L < 3; L++) {
          const q = seg(p, 0.2 + L * 0.15, 0.2 + (L + 1) * 0.15);
          if (q > 0 && q < 1) S.sphere(lerp3(node(k, L, idx[L]), node(k, L + 1, idx[L + 1]), ease(q)), 0.14, C.accent, { glow: 1 });
        }
        // voto voando para a urna
        const qv = seg(p, 0.68, 0.85);
        if (qv > 0 && qv < 1) S.sphere(lerp3(node(k, 3, idx[3]), [0, -2.6, -0.5], ease(qv)), 0.13, (k + idx[3]) % 3 !== 0 ? C.high : C.ok, { glow: 1 });
      }
      S.box([0, -2.6, -0.5], [2.6, 0.6, 1.2], C.surface, { edge: C.line });
      const yes = votes.filter(Boolean).length;
      if (p > 0.85) S.text([0, -2.55, -1.15], `${yes} de 5 votos "crime" → probabilidade ${nf2(yes / 5)}`, C.text, { size: 12, weight: 700 });
      else S.text([0, -2.55, -1.15], 'votação', C.muted, { size: 11 });
      return p < 0.2 ? 0 : p < 0.65 ? 1 : p < 0.85 ? 2 : 3;
    },
  },

  lstm: {
    title: 'LSTM', loop: 10, cam: { yaw: -0.55, pitch: 0.34, dist: 13, zoom: 0.78, cx: 1.6, cy: -0.2 },
    captions: [[0, 'A LSTM lê as 24 semanas da célula em ordem, uma por vez'], [0.12, 'Em cada semana, três portas decidem: esquecer (f), guardar (i) e mostrar (o)'],
      [0.75, 'A memória final (64 números) passa por duas camadas densas'], [0.9, 'A saída vira a probabilidade de crime nas próximas 4 semanas']],
    params: [['Memória', '64 unidades, 1 camada'], ['Dropout', '0,2'], ['Épocas', '10'], ['Lote', '2.048 linhas'], ['Peso dos positivos', '10'], ['Roda em', 'placa de vídeo (CUDA) ou processador']],
    init() { const r = rng(5); return { bars: Array.from({ length: 24 }, () => r()), c: Array.from({ length: 24 }, () => 0.35 + r() * 0.65) }; },
    draw(S, p, C, st) {
      const X = (k) => -5.75 + k * 0.5;
      const k = Math.floor(seg(p, 0, 0.75) * 24 - 1e-6);
      // estado da célula (tubo) e ligações
      for (let i = 0; i < 23; i++) {
        const done = i < k;
        S.line([X(i), 0.62, 0], [X(i + 1), 0.62, 0], done ? C.accent2 : C.line, { width: done ? 2 + st.c[i] * 5 : 1.5, alpha: done ? 0.9 : 0.5 });
        S.line([X(i) + 0.17, 0, 0], [X(i + 1) - 0.17, 0, 0], done ? C.accent : C.line, { width: done ? 2 : 1, alpha: 0.8 });
      }
      for (let i = 0; i < 24; i++) {
        const active = i === k && p < 0.75, done = i < k || p >= 0.75;
        S.box([X(i), -1.25 + st.bars[i] * 0.4, 0], [0.22, 0.1 + st.bars[i] * 0.8, 0.22], active ? C.warn : rgba(C.accent2, 1), { alpha: done || active ? 1 : 0.45 });
        S.box([X(i), 0, 0], [0.34, 0.34, 0.34], active ? C.accent : done ? shade(C.accent, 0.85) : (C.s3 || C.line), { glow: active ? 1 : 0, edge: rgba(C.line, 0.6) });
        if (active) {
          const pul = 0.5 + 0.5 * Math.sin(p * 120);
          [['f', C.err, -0.22], ['i', C.ok, 0], ['o', C.accent2, 0.22]].forEach(([g, col, dx], j) => {
            S.sphere([X(i) + dx, 1.05 + 0.08 * Math.sin(p * 90 + j), 0], 0.1 + 0.03 * pul, col, { glow: 1 });
            S.text([X(i) + dx, 1.4, 0], g, C.text, { size: 11, weight: 700 });
          });
          // entrada subindo
          const qi = (seg(p, 0, 0.75) * 24) % 1;
          S.sphere(lerp3([X(i), -0.9, 0], [X(i), -0.2, 0], qi), 0.08, C.warn, { glow: 1 });
        }
        if (i % 6 === 0 || i === 23) S.text([X(i), -1.95, 0], i === 23 ? 'sem. −1' : `−${24 - i}`, C.faint, { size: 10, weight: 500 });
      }
      S.text([0, 1.9, 0], 'memória (estado da célula)', C.muted, { size: 11 });
      S.text([0, -2.4, 0], 'crimes por semana na célula', C.muted, { size: 11 });
      // camadas densas
      const q = seg(p, 0.75, 0.92);
      S.box([7.0, 0, 0], [0.18, 2.4, 1.6], q > 0 ? C.accent : (C.s3 || C.line), { alpha: 0.85, edge: rgba(C.line, 0.6) });
      S.box([8.0, 0, 0], [0.18, 1.4, 1.0], q > 0.5 ? C.accent : (C.s3 || C.line), { alpha: 0.85, edge: rgba(C.line, 0.6) });
      S.text([7.0, 1.6, 0], '64', C.muted, { size: 10 }); S.text([8.0, 1.1, 0], '32', C.muted, { size: 10 });
      if (q > 0 && q < 1) S.sphere(lerp3([X(23), 0, 0], [8.9, 0, 0], ease(q)), 0.13, C.accent, { glow: 1 });
      S.sphere([9.0, 0, 0], 0.26, p > 0.92 ? C.high : (C.s3 || C.line), { glow: p > 0.92 ? 1 : 0 });
      if (p > 0.92) S.text([9.0, 0.75, 0], 'probabilidade 0,73', C.text, { size: 12, weight: 700, bg: rgba(C.surface, 0.9) });
      return p < 0.12 ? 0 : p < 0.75 ? 1 : p < 0.9 ? 2 : 3;
    },
  },

  transformer: {
    title: 'Transformer', loop: 11, cam: { yaw: -0.45, pitch: 0.42, dist: 13, zoom: 0.8, cx: 1.2, cy: 0.2 },
    captions: [[0, 'Cada semana vira um vetor de 32 números (embedding) com a sua posição no tempo'], [0.22, 'Atenção: cada semana "olha" para todas as outras e pesa as mais parecidas (2 cabeças)'],
      [0.66, 'Uma camada feed-forward refina cada semana'], [0.8, 'A média de todas as semanas vira a probabilidade da célula']],
    params: [['Embedding', '32'], ['Cabeças de atenção', '2'], ['Feed-forward', '32'], ['Camadas', '1'], ['Dropout', '0,1'], ['Épocas', '5'], ['Lote', '2.048 linhas']],
    init() {
      const r = rng(23);
      const bars = Array.from({ length: 24 }, () => r());
      const att = Array.from({ length: 24 }, (_, q) => {
        const raw = bars.map((b, j) => Math.exp(-Math.abs(b - bars[q]) * 4 + (j > q - 3 && j <= q ? 0.8 : 0) + r() * 0.3));
        const s = raw.reduce((a, b) => a + b, 0); return raw.map((x) => x / s);
      });
      return { bars, att };
    },
    draw(S, p, C, st) {
      const X = (k) => -5.75 + k * 0.5;
      const qe = ease(seg(p, 0.02, 0.2));
      for (let i = 0; i < 24; i++) {
        const b = st.bars[i];
        S.box([X(i), -1.3 + b * 0.35, 0], [0.22, 0.1 + b * 0.7, 0.22], C.warn, { alpha: 1 - qe * 0.6 });
        // vetor do embedding (6 cubos representam 32 números)
        const pulse = p > 0.66 && p < 0.8 ? Math.max(0, 1 - Math.abs(seg(p, 0.66, 0.8) * 24 - i) / 2) : 0;
        for (let d = 0; d < 6; d++) {
          const show = qe > d / 6;
          if (!show) continue;
          const v = 0.4 + 0.6 * Math.abs(Math.sin(i * 0.7 + d * 1.3 + b * 3));
          S.box([X(i), 0.05 + d * 0.22, 0], [0.26, 0.18, 0.26], pulse > 0 ? C.ok : d % 2 ? C.accent : C.accent2, { alpha: 0.35 + v * 0.6, glow: pulse });
        }
      }
      // codificação de posição (onda)
      if (p > 0.1) for (let i = 0; i < 23; i++) S.line([X(i), 1.6 + Math.sin(i * 0.55) * 0.12, 0], [X(i + 1), 1.6 + Math.sin((i + 1) * 0.55) * 0.12, 0], C.faint, { width: 1.5, alpha: seg(p, 0.1, 0.2) });
      if (p > 0.1 && p < 0.22) S.text([0, 1.95, 0], 'posição no tempo', C.muted, { size: 11 });
      // atenção
      const qa = seg(p, 0.22, 0.66);
      if (qa > 0 && qa < 1) {
        const q = Math.min(23, Math.floor(qa * 24));
        S.box([X(q), 0.6, 0], [0.34, 1.5, 0.34], C.accent, { alpha: 0.25, glow: 1 });
        st.att[q].forEach((w, j) => {
          if (j === q || w < 0.025) return;
          const a = [X(q), 1.45, 0], b = [X(j), 1.45, 0], mid = (X(q) + X(j)) / 2, dist = Math.abs(j - q) * 0.5;
          S.curve(a, [mid, 1.45 + dist * 0.55, 0], b, C.accent, { width: 1 + w * 22, alpha: clamp(w * 6, 0.15, 0.95), n: 12 });
          S.curve([X(q), 0.3, 0.15], [mid, 0.3, 0.2 + dist * 0.5], [X(j), 0.3, 0.15], C.accent2, { width: 1 + w * 16, alpha: clamp(w * 5, 0.1, 0.8), n: 12 });
        });
        S.text([X(q), 2.6 + 0.3, 0], `semana ${q - 24}`, C.text, { size: 11, weight: 700, bg: rgba(C.surface, 0.9) });
      }
      // pooling e saída
      const qp = seg(p, 0.8, 0.94);
      if (qp > 0) for (let i = 0; i < 24; i += 2) S.sphere(lerp3([X(i), 0.6, 0], [7.2, 0.4, 0], ease(qp)), 0.09, C.accent, { glow: 1, alpha: 1 - qp * 0.3 });
      S.box([7.6, 0.4, 0], [0.18, 1.2, 1.0], qp > 0.6 ? C.accent : (C.s3 || C.line), { alpha: 0.85, edge: rgba(C.line, 0.6) });
      S.text([7.6, 1.2, 0], '20', C.muted, { size: 10 });
      S.sphere([8.6, 0.4, 0], 0.26, p > 0.94 ? C.high : (C.s3 || C.line), { glow: p > 0.94 ? 1 : 0 });
      if (p > 0.94) S.text([8.6, 1.15, 0], 'probabilidade 0,68', C.text, { size: 12, weight: 700, bg: rgba(C.surface, 0.9) });
      return p < 0.22 ? 0 : p < 0.66 ? 1 : p < 0.8 ? 2 : 3;
    },
  },

  ensemble: {
    title: 'Ensemble', loop: 10, cam: { yaw: -0.35, pitch: 0.45, dist: 14, zoom: 0.88, cx: 0.4 },
    captions: [[0, 'Os três modelos dão um score para a mesma célula'], [0.2, 'Média ponderada (RF 0,1 · LSTM 0,5 · Transformer 0,4) e o maior dos três'],
      [0.5, 'Mistura: 70% da média + 30% do máximo; pontos de interesse ajustam até 15%'], [0.75, 'As 10% células de maior score viram zona vermelha; as 10% seguintes, amarela']],
    params: [['Pesos', 'RF 0,1 · LSTM 0,5 · Transformer 0,4'], ['Fórmula', '0,7 × média + 0,3 × máximo'], ['Pontos de interesse', 'até +15% (bares, baladas; delegacias reduzem)'], ['Suavização', 'janela 2, α 0,7'], ['Alerta', 'top 10% vermelho, 10–20% amarelo']],
    init() { const r = rng(3); return { cells: Array.from({ length: 49 }, (_, i) => ({ i: i % 7, j: Math.floor(i / 7), s: r() })) }; },
    draw(S, p, C, st) {
      const models = [['RF', 0.42, 0.1, -2.8], ['LSTM', 0.81, 0.5, 0], ['Transformer', 0.67, 0.4, 2.8]];
      const mean = models.reduce((s, m) => s + m[1] * m[2], 0), mx = Math.max(...models.map((m) => m[1]));
      const hyb = 0.7 * mean + 0.3 * mx, fin = Math.min(1, hyb * 1.06);
      const meanN = [-1.2, 1.1, 0], maxN = [-1.2, -1.1, 0], hybN = [1.0, 0, 0], poiN = [2.6, 0, 0];
      models.forEach(([n, s, w, z], k) => {
        const pos = [-4.4, 0, z];
        S.box(pos, [1.1, 0.7, 0.7], [C.ok, C.accent, C.accent2][k], { glow: p < 0.2 ? 0.6 : 0, edge: rgba(C.line, 0.5) });
        S.text([-4.4, 0.75, z], `${n}  ${nf2(s)}`, C.text, { size: 11, weight: 700, bg: rgba(C.surface, 0.85) });
        const q = seg(p, 0.2, 0.5);
        S.line(pos, meanN, [C.ok, C.accent, C.accent2][k], { width: 1 + w * 14, alpha: 0.25 + q * 0.6 });
        S.line(pos, maxN, C.line, { width: 1.2, alpha: 0.5 });
        for (let f = 0; f < 3; f++) {
          const t = ((p * 3 + f / 3 + k * 0.1) % 1);
          if (q > 0) S.sphere(lerp3(pos, meanN, t), 0.06 + w * 0.12, [C.ok, C.accent, C.accent2][k], { glow: 1, alpha: q });
        }
      });
      S.sphere(meanN, 0.32, C.accent, { glow: p > 0.3 ? 0.8 : 0 }); S.text([meanN[0], 1.65, 0], `média ${nf2(mean)}`, C.text, { size: 11, bg: rgba(C.surface, 0.85) });
      S.sphere(maxN, 0.28, C.warn, { glow: p > 0.3 ? 0.8 : 0 }); S.text([maxN[0], -1.65, 0], `máximo ${nf2(mx)}`, C.text, { size: 11, bg: rgba(C.surface, 0.85) });
      const q2 = seg(p, 0.5, 0.65);
      S.line(meanN, hybN, C.accent, { width: 5, alpha: 0.3 + q2 * 0.6 }); S.line(maxN, hybN, C.warn, { width: 2.5, alpha: 0.3 + q2 * 0.6 });
      S.sphere(hybN, 0.34, C.accent2, { glow: q2 });
      if (q2 > 0.5) S.text([hybN[0], 0.75, 0], `0,7 × ${nf2(mean)} + 0,3 × ${nf2(mx)} = ${nf2(hyb)}`, C.text, { size: 11, weight: 700, bg: rgba(C.surface, 0.9) });
      const q3 = seg(p, 0.6, 0.75);
      S.line(hybN, poiN, C.accent2, { width: 3, alpha: 0.3 + q3 * 0.6 });
      S.box(poiN, [0.7, 0.7, 0.7], C.mid, { glow: q3, alpha: 0.9 });
      if (q3 > 0.5) S.text([poiN[0], -0.85, 0], `+6% (2 bares por perto) → ${nf2(fin)}`, C.text, { size: 11, bg: rgba(C.surface, 0.9) });
      // mapa final
      const sorted = [...st.cells].sort((a, b) => b.s - a.s);
      const q4 = seg(p, 0.75, 0.9);
      st.cells.forEach((c) => {
        const rank = sorted.indexOf(c) / sorted.length;
        const target = c.i === 3 && c.j === 3;
        const col = q4 > 0 ? (target || rank < 0.1 ? C.high : rank < 0.2 ? C.mid : (C.s3 || C.line)) : (C.s3 || C.line);
        const hgt = 0.06 + (q4 > 0 ? (target ? fin : c.s) * 0.9 * q4 : 0);
        S.box([4.4 + (c.i - 3) * 0.42, -0.6 + hgt / 2, (c.j - 3) * 0.42], [0.36, hgt, 0.36], col, { alpha: 0.95, glow: target && q4 > 0.5 ? 1 : 0 });
      });
      S.line(poiN, [4.4, 0, 0], C.mid, { width: 2, alpha: q4 * 0.8, dash: [4, 4] });
      S.text([4.4, -1.35, 1.8], 'mapa da área', C.muted, { size: 11 });
      return p < 0.2 ? 0 : p < 0.5 ? 1 : p < 0.75 ? 2 : 3;
    },
  },
};
const TABS = [['rf', 'Random Forest'], ['lstm', 'LSTM'], ['transformer', 'Transformer'], ['ensemble', 'Ensemble']];

class PcModelArch extends HTMLElement {
  static observedAttributes = ['model', 'active', 'epoch', 'epochs', 'loss', 'area'];
  #raf = 0; #t0 = 0; #st = {}; #C = null; #visible = true; #io = null; #ro = null; #mo = null;
  #cam = null; #drag = null; #userRot = { yaw: 0, pitch: 0 };

  connectedCallback() {
    this.model = this.getAttribute('model') || 'rf';
    this.innerHTML = `
      <div class="arch-tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" data-k="${k}">${l}<i class="arch-live" hidden></i></button>`).join('')}</div>
      <div class="arch-stage"><canvas role="img"></canvas>
        <div class="arch-hud"><b class="arch-title"></b><span class="arch-cap"></span></div>
        <div class="arch-train" hidden></div>
        <span class="arch-hint">arraste para girar</span></div>
      <dl class="arch-params"></dl>`;
    this.canvas = this.querySelector('canvas');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.#C = palette();
    this.querySelector('.arch-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      this.setAttribute('model', b.dataset.k);
      this.dispatchEvent(new CustomEvent('model-change', { detail: b.dataset.k, bubbles: true }));
    });
    this.canvas.addEventListener('pointerdown', (e) => { this.#drag = { x: e.clientX, y: e.clientY, ...this.#userRot }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.#drag) return;
      this.#userRot.yaw = this.#drag.yaw + (e.clientX - this.#drag.x) * 0.008;
      this.#userRot.pitch = clamp(this.#drag.pitch + (e.clientY - this.#drag.y) * 0.006, -0.3, 0.8);
      if (this.reduced) this.#frame(0);
    });
    this.canvas.addEventListener('pointerup', () => { this.#drag = null; });
    this.#ro = new ResizeObserver(() => this.#resize()); this.#ro.observe(this);
    this.#io = new IntersectionObserver((e) => { this.#visible = e[0].isIntersecting; }); this.#io.observe(this);
    this.#mo = new MutationObserver(() => { this.#C = palette(); }); this.#mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.#select();
    this.#resize();
    this.#t0 = performance.now();
    const loop = (now) => { this.#raf = requestAnimationFrame(loop); if (this.#visible && !document.hidden) this.#frame(now); };
    if (this.reduced) this.#frame(0); else this.#raf = requestAnimationFrame(loop);
  }
  disconnectedCallback() { cancelAnimationFrame(this.#raf); this.#ro?.disconnect(); this.#io?.disconnect(); this.#mo?.disconnect(); }
  attributeChangedCallback(name) {
    if (!this.canvas) return;
    if (name === 'model') { this.model = this.getAttribute('model') || 'rf'; this.#select(); }
    this.#hud();
    if (this.reduced) this.#frame(0);
  }

  #select() {
    const sc = SCENES[this.model] || SCENES.rf;
    this.scene = sc;
    this.#cam = { ...sc.cam };
    this.#userRot = { yaw: 0, pitch: 0 };
    this.#st[this.model] = this.#st[this.model] || sc.init();
    this.#t0 = performance.now();
    this.querySelectorAll('.arch-tabs [data-k]').forEach((b) => { b.classList.toggle('on', b.dataset.k === this.model); b.setAttribute('aria-selected', b.dataset.k === this.model); });
    this.querySelector('.arch-title').textContent = sc.title;
    this.#paramsHtml();
    this.canvas.setAttribute('aria-label', `Arquitetura do ${sc.title}: ${sc.captions.map((c) => c[1]).join('. ')}`);
    this.#hud();
  }
  /** Hiperparâmetros em uso: { RF: {...}, LSTM: {...}, Transformer: {...} } (atualiza a legenda). */
  setParams(hp) { this.hp = hp || null; if (this.canvas) this.#paramsHtml(); }
  #paramsHtml() {
    const sc = SCENES[this.model] || SCENES.rf;
    const hp = this.hp?.[HP_KEY[this.model]];
    const list = hp && PARAMS_FN[this.model] ? PARAMS_FN[this.model](hp) : sc.params;
    this.querySelector('.arch-params').innerHTML = list.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }
  #hud() {
    const active = (this.getAttribute('active') || '').toLowerCase();
    this.querySelectorAll('.arch-tabs [data-k]').forEach((b) => { b.querySelector('.arch-live').hidden = !active.split(',').includes(b.dataset.k); });
    const box = this.querySelector('.arch-train');
    const here = active.split(',').includes(this.model);
    box.hidden = !here;
    if (here) {
      const ep = this.getAttribute('epoch'), eps = this.getAttribute('epochs'), loss = this.getAttribute('loss'), area = this.getAttribute('area');
      box.innerHTML = `<i class="spin"></i> Treinando agora${area ? ` · ${this.getAttribute('area-label') || area.replace('area_', 'Área ')}` : ''}${ep ? ` · época ${ep}${eps ? ` de ${eps}` : ''}` : ''}${loss ? ` · perda ${Number(loss).toFixed(3).replace('.', ',')}` : ''}`;
    }
  }
  #resize() {
    const w = this.querySelector('.arch-stage').clientWidth || 700, h = Number(this.getAttribute('height') || 380), dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.w = w; this.h = h; this.dpr = dpr;
    if (this.reduced) this.#frame(0);
  }
  #frame(now) {
    const sc = this.scene; if (!sc) return;
    const ctx = this.canvas.getContext('2d');
    const t = this.reduced ? 0 : (now - this.#t0) / 1000;
    const p = this.reduced ? 0.6 : (t % sc.loop) / sc.loop;
    const cam = {
      ...this.#cam,
      yaw: this.#cam.yaw + this.#userRot.yaw + (this.#drag || this.reduced ? 0 : Math.sin(t * 0.25) * 0.22),
      pitch: this.#cam.pitch + this.#userRot.pitch,
    };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    // chão
    const S = new Scene3D(ctx, this.w, this.h, cam, this.#C);
    for (let i = -6; i <= 6; i += 1.5) { S.line([i * 1.5, -2.9, -4], [i * 1.5, -2.9, 4], this.#C.line, { width: 0.8, alpha: 0.25 }); }
    for (let j = -4; j <= 4; j += 2) { S.line([-9, -2.9, j], [9, -2.9, j], this.#C.line, { width: 0.8, alpha: 0.25 }); }
    const step = sc.draw(S, p, this.#C, this.#st[this.model]);
    S.flush();
    const cap = sc.captions.filter((c) => p >= c[0]).pop()?.[1] || '';
    const capEl = this.querySelector('.arch-cap');
    if (capEl.textContent !== cap) capEl.textContent = cap;
    this.dataset.step = step;
  }
}
customElements.define('pc-model-arch', PcModelArch);
