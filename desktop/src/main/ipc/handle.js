// Envelope das respostas IPC ({ok,data} | {ok:false,error}) e verificação do remetente:
// só a página principal do app (arquivo local renderer/index.html, quadro principal)
// pode chamar o processo principal. Mesmo padrão do FastMind (IA-Cebrebro).
const { ipcMain } = require('electron');

function trustedSender(ev) {
  const f = ev.senderFrame;
  if (!f || f.parent) return false;
  return /^file:\/\/.*\/renderer\/index\.html(?:[?#].*)?$/.test(f.url || '');
}

function makeHandle(log) {
  return (channel, fn) => ipcMain.handle(channel, async (ev, ...args) => {
    if (!trustedSender(ev)) {
      log.error('ipc', `chamada recusada em ${channel} vinda de ${ev.senderFrame?.url || '?'}`);
      return { ok: false, error: 'ipc:forbidden' };
    }
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      log.error('ipc:' + channel, e.message || String(e));
      return { ok: false, error: e.message || String(e) };
    }
  });
}

module.exports = { makeHandle, trustedSender };
