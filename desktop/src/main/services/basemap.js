// Fundo do mapa: chave da CARTO (basemaps.cartocdn.com) do operador.
//
// A CARTO desenha e serve as imagens de ruas (a partir dos dados do OpenStreetMap) que ficam
// por baixo das células no mapa. Desde 25/09/2026 ela exige uma chave: sem ela, cada
// quadradinho vem com o aviso "API KEY REQUIRED". Sem chave, o mapa usa as ruas da área.
//
// A chave é do operador (não da pasta de trabalho): fica em <userData>/fundo-mapa.json,
// cifrada com o cofre do sistema (safeStorage: DPAPI no Windows) quando disponível. A
// interface nunca recebe a chave inteira, só os 4 últimos caracteres.
const fs = require('fs');
const path = require('path');

const ESTILOS = {
  light_all: 'Claro (Positron)',
  'rastertiles/voyager': 'Colorido (Voyager)',
  dark_all: 'Escuro (Dark Matter)',
};
const PAGINA_CHAVE = 'https://carto.com/basemaps/apikey/';
const PAGINA_TERMOS = 'https://carto.com/legal/basemap-terms/';
const KEY_RE = /^[A-Za-z0-9._~-]{8,200}$/;
// quadradinho de teste: centro de São Paulo, zoom 12
const TILE = (estilo, chave) => `https://a.basemaps.cartocdn.com/${estilo}/12/1517/2324.png${chave ? `?key=${encodeURIComponent(chave)}` : ''}`;

class Basemap {
  constructor({ dir, safeStorage, net, log }) {
    this.file = path.join(dir, 'fundo-mapa.json');
    Object.assign(this, { safeStorage, net, log });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  chave() {
    const c = this.data.chave;
    if (!c) return null;
    try {
      if (c.cifrada) return this.safeStorage.decryptString(Buffer.from(c.cifrada, 'base64'));
      return c.texto || null;
    } catch { return null; }
  }

  estilo() { return ESTILOS[this.data.estilo] ? this.data.estilo : 'light_all'; }

  /** O que a interface vê (sem a chave). */
  view() {
    const k = this.chave();
    return {
      temChave: !!k, final: k ? k.slice(-4) : null, cifrada: !!this.data.chave?.cifrada,
      estilo: this.estilo(), estilos: ESTILOS, teste: this.data.teste || null,
      paginaChave: PAGINA_CHAVE, paginaTermos: PAGINA_TERMOS,
    };
  }

  /** Para o servidor do mapa (PRECRIME_BASEMAP) e para o pacote de publicação. */
  forServer() {
    const k = this.chave();
    return k ? { provedor: 'carto', estilo: this.estilo(), chave: k } : { provedor: 'ruas' };
  }

  set({ chave, estilo } = {}) {
    if (estilo !== undefined) {
      if (!ESTILOS[estilo]) throw new Error('Estilo de mapa desconhecido.');
      this.data.estilo = estilo;
    }
    if (chave !== undefined) {
      const c = String(chave || '').trim();
      if (!c) { delete this.data.chave; delete this.data.teste; }
      else {
        if (!KEY_RE.test(c)) throw new Error('A chave tem caracteres inesperados. Copie só o código que a CARTO enviou por e-mail.');
        this.data.chave = this.safeStorage?.isEncryptionAvailable()
          ? { cifrada: this.safeStorage.encryptString(c).toString('base64') }
          : { texto: c };
        delete this.data.teste;
      }
    }
    this.data.atualizadoEm = new Date().toISOString();
    this.save();
    return this.view();
  }

  async fetchTile(url) {
    const r = await this.net.fetch(url, { cache: 'no-store' });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, tipo: r.headers.get('content-type') || '', buf };
  }

  /**
   * Testa a chave salva: baixa o mesmo quadradinho com e sem a chave. Sem chave a CARTO
   * devolve a imagem com o aviso; se a imagem com a chave for idêntica, a chave não valeu.
   */
  async test() {
    const k = this.chave();
    if (!k) throw new Error('Nenhuma chave salva.');
    const estilo = this.estilo();
    let res;
    try {
      const [com, sem] = await Promise.all([this.fetchTile(TILE(estilo, k)), this.fetchTile(TILE(estilo, null)).catch(() => null)]);
      if (com.status === 401 || com.status === 403) res = { ok: false, msg: `A CARTO recusou a chave (HTTP ${com.status}). Confira se copiou o código inteiro.` };
      else if (com.status !== 200 || !/image/.test(com.tipo)) res = { ok: false, msg: `A CARTO respondeu HTTP ${com.status}. Tente de novo mais tarde.` };
      else if (sem && sem.status === 200 && Buffer.compare(com.buf, sem.buf) === 0) res = { ok: false, msg: 'A imagem veio igual à de quem não tem chave (com o aviso "API KEY REQUIRED"): a CARTO não reconheceu a chave.' };
      else res = { ok: true, msg: 'Chave aceita: o mapa vai usar o fundo da CARTO.' };
    } catch (e) {
      res = { ok: null, msg: `Sem conexão com basemaps.cartocdn.com (${e.message}). Sem internet o mapa usa as ruas da área.` };
    }
    this.data.teste = { ...res, em: new Date().toISOString() };
    this.save();
    this.log[res.ok ? 'ok' : 'warn']('fundo do mapa', res.msg);
    return this.view();
  }
}

module.exports = { Basemap, ESTILOS, PAGINA_CHAVE };
