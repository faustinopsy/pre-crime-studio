// Estado central da interface: um objeto, set() para mudar e subscribe() para ouvir.
let state = {
  screen: 'home',
  settings: null,
  info: null,
  ws: null,        // resultado de workspace:status
  wsError: null,
  metrics: null,   // CPU/RAM
  python: null,    // situação do Python do pipeline (env:python)
  run: null,       // execução em andamento { runId, job, label, startedAt }
};
const listeners = new Set();

export const store = {
  get: () => state,
  set(partial, why = 'ui') {
    state = { ...state, ...partial };
    for (const fn of listeners) fn(state, why);
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

/** Chama o processo principal (window.pc) e mostra o erro em texto simples. */
export async function call(channel, ...args) {
  return window.pc.invoke(channel, ...args);
}

export async function refreshWorkspace() {
  try {
    const ws = await call('workspace:status');
    store.set({ ws, wsError: null }, 'ws');
    return ws;
  } catch (e) {
    store.set({ wsError: e.message }, 'ws');
    return null;
  }
}

/** Situação do Ambiente para o menu e o stepper: pronto quando o Python do app está completo. */
export function envStatus() {
  const py = state.python;
  return !py ? 'pending' : py.state === 'ready' ? 'done' : py.state === 'partial' && py.jobs?.clean ? 'partial' : py.state === 'missing' ? 'pending' : 'error';
}
