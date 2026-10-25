// Textos das fases para o operador.
export const PHASE_INFO = {
  env: {
    title: 'Ambiente', icon: 'env', build: 1,
    what: 'Verifica se este computador consegue rodar o pipeline (memória, disco, placa de vídeo, Python e pacotes) e instala o que faltar.',
  },
  ssp: {
    title: 'Dados SSP', icon: 'ssp', build: 3,
    what: 'Traz para a pasta de trabalho as planilhas VeiculosSubtraidos_AAAA.xlsx da SSP-SP. Escolha os arquivos, a pasta onde eles estão ou arraste para cá.',
  },
  clean: {
    title: 'Limpeza', icon: 'clean', build: 4,
    what: 'Gera a base unificada: junta todas as planilhas e mantém só o que você escolher abaixo (tipo de ocorrência e tipos de veículo, na capital). Tira datas inválidas, registros sem localização e repetidos. Todos os meses ficam na base.',
  },
  filter: {
    title: 'Filtragem', icon: 'filter', build: 4,
    what: 'Descarta células do mapa sem ruas (água, mata, represa) e coloca cada crime na célula onde aconteceu.',
  },
  features: {
    title: 'Features', icon: 'features', build: 4,
    what: 'Escolha de quando a quando os modelos aprendem. Para cada célula e semana desse período, o app monta o histórico das 24 semanas anteriores, médias recentes e crimes nos vizinhos: é o que os modelos enxergam.',
  },
  train: {
    title: 'Treino', icon: 'train', build: 5,
    what: 'Treina Random Forest, LSTM e Transformer para cada área. O modo rápido leva perto de 50 minutos numa máquina com placa de vídeo.',
  },
  predict: {
    title: 'Previsão', icon: 'predict', build: 6,
    what: 'Gera o mapa de risco do mês escolhido: cada célula recebe um score e as de maior risco viram zona vermelha ou amarela.',
  },
  validate: {
    title: 'Validação', icon: 'validate', build: 6,
    what: 'Quando a SSP publica os crimes do mês, compara previsão e realidade: quantos crimes caíram nas zonas de alerta, PAI, precisão e recall.',
  },
  publish: {
    title: 'Publicação', icon: 'publish', build: 8,
    what: 'Leva os resultados para fora do app: o pacote do mapa para um servidor Node (montado, conferido e pré-visualizado antes de exportar), arquivos GeoJSON (abrem no geojson.io) e imagens PNG do mapa.',
  },
};

export const PIPELINE_ORDER = ['ssp', 'clean', 'filter', 'features', 'train', 'predict', 'validate', 'publish'];

/** Sugere a próxima ação a partir do estado das fases. */
export function nextAction(ws, python) {
  if (!ws) return null;
  if (ws.configured === false) return { title: 'Escolha a pasta de trabalho', text: 'É onde o app guarda planilhas, modelos e previsões.', screen: 'settings' };
  if (!ws.exists) return { title: 'A pasta de trabalho não foi encontrada', text: 'Ela pode ter sido movida ou o disco não está conectado.', screen: 'settings' };
  const by = Object.fromEntries(ws.phases.map((p) => [p.id, p]));
  if (by.ssp.status === 'pending') return { title: 'Importe as planilhas da SSP', text: 'Escolha os arquivos ou a pasta onde eles estão. Depois disso o app cria as pastas de cada etapa.', screen: 'ssp' };
  if (!ws.base.streets.ok) return { title: 'Faltam as malhas das áreas', text: 'A pasta streets da pasta de trabalho está incompleta. Feche e abra o app para ele copiar as malhas de novo.', screen: 'home' };
  if (python && !python.jobs?.clean) return { title: 'Prepare o ambiente Python', text: 'Um botão na tela Ambiente instala o Python e os pacotes do pipeline, sem mexer no Python do computador.', screen: 'env' };
  if (by.clean.status === 'pending' && !ws.cleanParams) return { title: 'Escolha os parâmetros da Limpeza', text: 'Furto, roubo ou recuperados, a cidade, os tipos de veículo e o período.', screen: 'clean' };
  for (const id of ['clean', 'filter', 'features', 'train']) {
    const p = by[id];
    if (p.status === 'stale') return { title: `${PHASE_INFO[id].title} desatualizada`, text: p.reason || 'Uma entrada mudou depois da última execução.', screen: id };
    if (p.status !== 'done') return { title: `Rode a fase ${PHASE_INFO[id].title}`, text: p.summary, screen: id };
  }
  if (by.predict.status === 'pending') return { title: 'Gere a primeira previsão', text: 'Os modelos estão prontos.', screen: 'predict' };
  if (by.validate.waiting?.length) {
    const [y, m] = by.validate.waiting[by.validate.waiting.length - 1].split('_');
    return { title: `Valide ${m}/${y} quando a SSP liberar os dados`, text: 'Importe a planilha atualizada e use o Ciclo mensal: ele refaz a base, valida e prevê o próximo mês.', screen: 'cycle' };
  }
  return { title: 'Tudo em dia', text: 'Quando a SSP publicar o próximo mês, importe a planilha e use o Ciclo mensal.', screen: 'cycle' };
}
