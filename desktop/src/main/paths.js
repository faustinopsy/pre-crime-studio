// Caminhos do app.
//
// Código (somente leitura): pipeline/, server/, main.py e base/ (malhas das áreas e POIs).
//   desenvolvimento: raiz do repositório
//   produção:        resources/ do app instalado (extraResources do electron-builder)
//
// Dados do usuário (leitura e escrita): a PASTA DE TRABALHO escolhida na primeira
// abertura (sugestão: Documentos\Pre-Crime). Nada do usuário é gravado dentro do app.
const path = require('path');
const { app } = require('electron');

const REPO_ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..', '..');

module.exports = {
  REPO_ROOT,
  SERVER_JS: path.join(REPO_ROOT, 'server', 'server.js'),
  PIPELINE_DIR: path.join(REPO_ROOT, 'pipeline'),
  BASE_DIR: path.join(REPO_ROOT, 'base'),            // streets/ e pois/ que acompanham o app
  suggestedWorkspace: () => path.join(app.getPath('documents'), 'Pre-Crime'),
  userData: () => app.getPath('userData'),
  logsDir: () => path.join(app.getPath('userData'), 'logs'),
};
