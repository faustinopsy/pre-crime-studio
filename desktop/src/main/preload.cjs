// Ponte mínima entre a interface e o processo principal (window.pc).
// Só os canais listados abaixo podem ser chamados ou ouvidos.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:info',
  'settings:get', 'settings:set',
  'workspace:status', 'workspace:suggest', 'workspace:browse', 'workspace:setup', 'workspace:open', 'workspace:reveal',
  'ssp:list', 'ssp:pickFiles', 'ssp:pickFolder', 'ssp:importPaths', 'ssp:remove', 'ssp:profile',
  'clean:view', 'clean:save', 'clean:reset', 'filter:get', 'filter:set',
  'dataset:view', 'dataset:save', 'dataset:reset',
  'env:hardware', 'env:python', 'env:install', 'env:installCancel', 'env:pickPython', 'env:openRoot',
  'run:start', 'run:cancel', 'run:status', 'run:list', 'run:verify', 'run:open', 'forecast:info',
  'areas:list', 'areas:pick', 'areas:inspectPath', 'areas:importBase', 'areas:importFiles', 'areas:importFonte', 'areas:drop', 'areas:remove',
  'train:params', 'train:paramsSet', 'train:paramsReset', 'train:seedSet',
  'risk:view', 'risk:set', 'risk:reset', 'risk:previa', 'defaults:summary', 'defaults:restoreAll', 'replay:export', 'replay:results',
  'pois:list', 'pois:catalog', 'pois:detail', 'pois:preview', 'pois:activate', 'pois:save', 'pois:remove', 'pois:pick', 'pois:inspectPath',
  'basemap:get', 'basemap:set', 'basemap:test', 'basemap:openKeyPage',
  'publish:geojsonList', 'publish:exportGeojson',
  'publish:options', 'publish:build', 'publish:cancel', 'publish:verify', 'publish:preview', 'publish:previewStop', 'publish:previewExternal',
  'publish:export', 'publish:history', 'publish:openDir', 'publish:latestStaged',
  'cycle:plan', 'replay:plan', 'replay:summary', 'seq:start', 'seq:cancel', 'seq:status', 'seq:list', 'run:get',
  'map:start', 'map:stop', 'map:status', 'map:openExternal',
  'logs:recent', 'logs:openDir', 'logs:fromRenderer',
]);
const EVENTS = new Set(['log:entry', 'sys:metrics', 'theme:changed', 'workspace:progress', 'ssp:progress', 'ssp:profile', 'download:done', 'env:python', 'env:install', 'run:event', 'publish:event', 'seq:event']);

contextBridge.exposeInMainWorld('pc', {
  /** Chama o processo principal. Devolve data ou lança Error com a mensagem. */
  async invoke(channel, ...args) {
    if (!INVOKE.has(channel)) throw new Error('canal não permitido: ' + channel);
    const r = await ipcRenderer.invoke(channel, ...args);
    if (!r || !r.ok) throw new Error((r && r.error) || 'erro desconhecido');
    return r.data;
  },
  /** Ouve um evento do processo principal. Devolve função para parar de ouvir. */
  on(event, fn) {
    if (!EVENTS.has(event)) throw new Error('evento não permitido: ' + event);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
  /** Caminho no disco de um arquivo arrastado para a janela. */
  pathForFile(file) {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
});
