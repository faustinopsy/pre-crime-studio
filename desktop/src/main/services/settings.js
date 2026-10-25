// Preferências do app em <userData>/settings.json.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  dataDir: null,      // pasta de dados (dados_ssp, streets, pois, processed...). null = <repo>/data
  theme: 'system',    // system | dark | light
  zoom: 1,
  sidebarCollapsed: false,
  pythonPath: null,   // Python escolhido pelo operador (quando não usa o ambiente do app)
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* primeiro uso */ }
  }
  get() { return { ...this.data }; }
  set(partial) {
    for (const [k, v] of Object.entries(partial || {})) if (k in DEFAULTS) this.data[k] = v;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    return this.get();
  }
}

module.exports = { Settings, DEFAULTS };
