// npm start / npm run dev no Windows: troca o ícone e o nome do electron.exe de desenvolvimento
// (node_modules/electron/dist) pelos do Pre-Crime Studio, para a barra de tarefas, a bandeja,
// as notificações e o Gerenciador de Tarefas não mostrarem o Electron. O app instalado já sai
// com o ícone certo (electron-builder); isto vale só para quem roda pelo código.
// Usa o rcedit (devDependency, mesmo utilitário do electron-builder). Nunca impede o app de abrir.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

function main() {
  if (process.platform !== 'win32') return;
  let exe;
  try { exe = require('electron'); } catch { return; }
  if (typeof exe !== 'string' || !fs.existsSync(exe)) return;
  const ico = path.join(__dirname, '..', 'build', 'icon.ico');
  const rcedit = path.join(path.dirname(require.resolve('rcedit/package.json')), 'bin', process.arch === 'ia32' ? 'rcedit.exe' : 'rcedit-x64.exe');
  if (!fs.existsSync(ico) || !fs.existsSync(rcedit)) return;
  const marca = path.join(path.dirname(exe), '.precrime-icone');
  const versao = require('electron/package.json').version;
  const assinatura = `${versao}:${crypto.createHash('sha256').update(fs.readFileSync(ico)).digest('hex')}`;
  try { if (fs.readFileSync(marca, 'utf8') === assinatura) return; } catch { /* primeira vez */ }
  execFileSync(rcedit, [exe,
    '--set-icon', ico,
    '--set-version-string', 'FileDescription', 'Pre-Crime Studio',
    '--set-version-string', 'ProductName', 'Pre-Crime Studio',
  ], { stdio: 'ignore', timeout: 60000 });
  fs.writeFileSync(marca, assinatura);
  console.log('[dev-icon] electron.exe de desenvolvimento com o ícone do Pre-Crime Studio.');
}

try { main(); } catch (e) {
  console.warn(`[dev-icon] não troquei o ícone do electron.exe (${e.message}). O app abre normalmente.`);
}
