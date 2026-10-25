// Ajuda "O que é GeoJSON?": o que é, o que o app precisa e onde conseguir ou desenhar um.
// Os links abrem no navegador (a janela do app nega a navegação e manda para o navegador).
import { icon } from '../lib/icons.js';

const FERRAMENTAS = [
  {
    nome: 'geojson.io', url: 'https://geojson.io', tag: 'Desenhar à mão · no navegador',
    txt: 'O jeito mais rápido para um bairro ou um trecho da cidade. Escolha a ferramenta de polígono, clique em volta da região e feche o desenho. Na tabela à direita, crie a propriedade "nome" (ex.: Pinheiros). Depois use Save → GeoJSON.',
  },
  {
    nome: 'IBGE: Malhas Territoriais', url: 'https://www.ibge.gov.br/geociencias/organizacao-do-territorio/malhas-territoriais.html', tag: 'Limites oficiais · municípios',
    txt: 'O contorno oficial dos municípios e de outras divisões do Brasil, para baixar por estado. Também existe a API de malhas (servicodados.ibge.gov.br/api/docs/malhas), que entrega um município direto em GeoJSON.',
  },
  {
    nome: 'GeoSampa (Prefeitura de São Paulo)', url: 'https://geosampa.prefeitura.sp.gov.br', tag: 'Capital · distritos e subprefeituras',
    txt: 'O mapa oficial da capital. Na área de download estão os distritos, as subprefeituras e outras divisões, em Shapefile. O app aceita o Shapefile compactado (.zip) direto.',
  },
  {
    nome: 'mapshaper', url: 'https://mapshaper.org', tag: 'Converter e simplificar · no navegador',
    txt: 'Abre Shapefile, KML, GeoPackage e outros. Use para converter para GeoJSON, simplificar contornos muito detalhados (Simplify) e conferir a projeção: em Console, "-proj wgs84" deixa em latitude e longitude.',
  },
  {
    nome: 'QGIS', url: 'https://qgis.org', tag: 'Programa completo · gratuito',
    txt: 'Para editar, recortar ou juntar polígonos. Para salvar: botão direito na camada → Exportar → Salvar feições como… → formato GeoJSON, SRC EPSG:4326.',
  },
  {
    nome: 'Overpass Turbo (OpenStreetMap)', url: 'https://overpass-turbo.eu', tag: 'Bairros do OpenStreetMap',
    txt: 'Busca limites cadastrados no OpenStreetMap (em muitas cidades os bairros são admin_level=10). Rode a consulta e use Exportar → GeoJSON. Confira o contorno: a cobertura varia de cidade para cidade.',
  },
  {
    nome: 'Google My Maps', url: 'https://www.google.com/mymaps', tag: 'Desenhar e exportar KML',
    txt: 'Desenhe a área numa camada e use Exportar para KML. O app aceita o .kml direto (use a opção de exportar como .kml, não .kmz).',
  },
];

export function openGeojsonHelp() {
  const antes = document.activeElement;
  const fundo = document.createElement('div');
  fundo.className = 'dlg-fundo';
  fundo.innerHTML = `<div class="dlg help-dlg" role="dialog" aria-modal="true" aria-labelledby="gh-t">
    <div class="help-corpo">
      <div class="help-top"><h2 id="gh-t">${icon('map')} O que é GeoJSON?</h2><button class="icon-btn" data-gh="fechar" aria-label="Fechar">${icon('x')}</button></div>
      <p><b>GeoJSON</b> é um arquivo de texto (<span class="mono">.geojson</span> ou <span class="mono">.json</span>) que guarda formas no mapa:
        pontos, linhas e <b>polígonos</b>, com coordenadas em longitude e latitude e, para cada forma, propriedades como o nome.
        É o formato aberto mais usado para trocar mapas e abre no navegador, no QGIS e em quase todo programa de mapa.</p>
      <pre class="help-code">{ "type": "FeatureCollection", "features": [{
    "type": "Feature",
    "properties": { "nome": "Pinheiros" },
    "geometry": { "type": "Polygon",
      "coordinates": [[[-46.70,-23.575], [-46.675,-23.572], [-46.668,-23.556], [-46.69,-23.552], [-46.70,-23.575]]] }
}]}</pre>
      <h3>O que o app precisa</h3>
      <ul class="help-list">
        <li>${icon('check')}<span><b>Polígonos</b> com o contorno de cada área (bairro, distrito, cidade). Pontos e linhas são ignorados.</span></li>
        <li>${icon('check')}<span>Coordenadas em <b>longitude e latitude (WGS84, EPSG:4326)</b>. Se o arquivo disser a projeção, o app converte sozinho.</span></li>
        <li>${icon('check')}<span>Uma <b>propriedade com o nome</b> (ex.: "nome", "NOME_BAIRRO"). Sem ela, o app chama de Polígono 1, 2…</span></li>
        <li>${icon('check')}<span>Também servem <b>KML</b>, <b>Shapefile compactado (.zip)</b> e <b>GeoPackage (.gpkg)</b>.</span></li>
        <li>${icon('info')}<span>Os crimes vêm das planilhas da <b>SSP-SP</b>: a área precisa estar no estado de São Paulo. Fora da capital, inclua a cidade na Limpeza.</span></li>
        <li>${icon('info')}<span>Bairro pequeno tem poucos crimes por célula. Se a área tiver poucos registros, use células maiores (300 a 500 m) ou junte bairros vizinhos numa área só.</span></li>
      </ul>
      <h3>Onde conseguir ou como criar</h3>
      <div class="help-tools">${FERRAMENTAS.map((f) => `<a class="help-tool" href="${f.url}" target="_blank" rel="noopener">
          <span class="ht-top"><b>${f.nome}</b>${icon('external')}</span><span class="ht-tag">${f.tag}</span><span class="ht-txt">${f.txt}</span></a>`).join('')}</div>
      <p class="muted small">Os links abrem no navegador. Os sites são de terceiros: confira os termos de uso e a licença dos dados (o OpenStreetMap pede o crédito "© colaboradores do OpenStreetMap").</p>
      <div class="dlg-acoes"><button class="btn primary" data-gh="fechar">Entendi</button></div>
    </div></div>`;
  document.body.append(fundo);
  fundo.querySelector('[data-gh="fechar"]').focus();
  const fechar = () => { document.removeEventListener('keydown', tecla, true); fundo.remove(); try { antes?.focus?.(); } catch { /* saiu */ } };
  const tecla = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(); } };
  document.addEventListener('keydown', tecla, true);
  fundo.addEventListener('click', (e) => { if (e.target.closest('[data-gh="fechar"]') || e.target === fundo) fechar(); });
}
