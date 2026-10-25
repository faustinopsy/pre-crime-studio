// O que roda de novo quando entra uma planilha nova da SSP. Usado em Dados SSP, Limpeza e
// Validação, para o operador saber que a Limpeza junta todas as planilhas (as antigas saem do
// cache, rápido), que Filtragem e Features refazem as áreas, e que o Treino não é preciso
// para validar uma previsão já feita.
import { icon } from '../lib/icons.js';
import { esc } from '../lib/dom.js';

const names = (xs) => xs.map((n) => `<span class="mono">${esc(n)}</span>`).join(', ');

/** Resumo das planilhas: { total, novas, cache, excel } a partir do status da pasta de trabalho. */
export function sheetsSummary(ws) {
  const ssp = ws?.phases?.find((p) => p.id === 'ssp');
  const files = ssp?.files || [];
  return {
    total: files.length,
    novas: ssp?.novas || [],
    cache: files.filter((f) => f.cache).map((f) => f.name),
    excel: files.filter((f) => !f.cache).map((f) => f.name),
    temBase: ws?.phases?.find((p) => p.id === 'clean')?.status !== 'pending',
  };
}

/** Uma linha para perto do botão da Limpeza. */
export function cleanLine(ws) {
  const s = sheetsSummary(ws);
  if (!s.total) return '';
  const partes = [];
  if (s.cache.length) partes.push(`${s.cache.length} já lida${s.cache.length > 1 ? 's' : ''} antes (sai${s.cache.length > 1 ? 'em' : ''} do cache em segundos)`);
  if (s.excel.length) partes.push(`${s.excel.length === 1 ? '1 lida' : `${s.excel.length} lidas`} do Excel agora: ${names(s.excel)} (de 30 segundos a 2 minutos cada)`);
  return `Junta <b>todas as ${s.total} planilhas</b> na base unificada: ${partes.join('; ')}. O resultado é o mesmo que ler tudo de novo.`;
}

/**
 * Quadro "Planilha nova: o que roda de novo". Só aparece quando há planilha mais nova que a
 * base unificada (ou quando force=true).
 */
export function newSheetBox(ws, { force = false, cta = true } = {}) {
  const s = sheetsSummary(ws);
  if (!s.total || (!s.novas.length && !force) || !s.temBase) return '';
  const velhas = s.total - s.novas.length;
  return `<div class="newsheet">
    <p class="ns-title">${icon('info')}<span>${s.novas.length ? `Planilha nova ou atualizada (${names(s.novas)}): o que roda de novo` : 'Com uma planilha nova, o que roda de novo'}</span></p>
    <ol class="ns-steps">
      <li><b>Limpeza: todas as planilhas, mas rápido.</b> A base unificada é refeita com as ${s.total} planilhas, porque ela é um arquivo só.
        ${velhas === 1 ? 'A que já estava na base não é lida do Excel de novo: sai do cache em segundos.' : velhas ? `As ${velhas} que já estavam na base não são lidas do Excel de novo: saem do cache em segundos.` : ''}
        Só ${s.novas.length > 1 ? 'as novas são lidas' : 'a nova é lida'} do Excel (de 30 segundos a 2 minutos${s.novas.length > 1 ? ' cada' : ''}).</li>
      <li><b>Filtragem: todas as áreas.</b> Coloca os crimes dos meses novos em cada área. É o que a Validação usa: depois dela, os meses que já têm previsão ficam prontos para validar.</li>
      <li><b>Features: só para as próximas previsões.</b> Montam o dataset de treino respeitando a data final do período; não são necessárias para validar.</li>
    </ol>
    <p class="ns-note">${icon('check')}<span><b>Para validar não precisa de Features, Treino nem Previsão:</b> a validação compara a previsão já feita com os crimes reais da Filtragem.
      Treine de novo só se quiser que os modelos aprendam os meses novos para as <b>próximas</b> previsões.</span></p>
    ${cta ? `<div class="btn-row"><button class="btn primary" data-go="clean">${icon('clean')} Ir para Limpeza</button></div>` : ''}
  </div>`;
}
