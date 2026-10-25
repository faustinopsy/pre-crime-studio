# Pre-Crime Studio

Previsão mensal de hotspots de furto e roubo de veículos com um Ensemble Híbrido de Random Forest, LSTM e Transformer, operada por um aplicativo desktop. O código acompanha o artigo *Quando o ensemble híbrido compensa? Avaliação prospectiva e sem vazamento de Random Forest, LSTM e Transformer na previsão de hotspots de roubo e furto de veículos em São Paulo* e a dissertação de mestrado do autor no Programa de Pós-Graduação em Informática e Gestão do Conhecimento da Universidade Nove de Julho (UNINOVE).

| Pasta | Conteúdo |
|---|---|
| `pipeline/` + `main.py` | Pipeline Python: limpeza, filtragem viária, atributos, treino, previsão, validação e métricas científicas |
| `desktop/` | Aplicativo Electron (Pre-Crime Studio) |
| `server/` | Servidor do mapa em Node, sem dependências |
| `base/` | Malhas das áreas e pontos de interesse (fora do git; ver abaixo) |
| `data/` | Pasta de dados da linha de comando (fora do git) |

Os parâmetros da configuração final ficam em `pipeline/padroes_dissertacao.json`, lido pelo pipeline e pelo aplicativo.

## Configuração do Ensemble Híbrido

O risco de cada célula combina os três modelos: 0,7 × média ponderada (RF 0,1; LSTM 0,5; Transformer 0,4) + 0,3 × o maior dos três, multiplicado por (1 + 0,15 × escore de pontos de interesse). Células com no máximo um registro no histórico são zeradas. A suavização temporal fica **desligada** na configuração final. A variante `comsuav` (Modo científico) liga a suavização tal como foi usada nas simulações iniciais, com a média móvel calculada entre células de numeração vizinha, para reproduzir a comparação do artigo.

## Requisitos

- Windows 10 ou 11, 16 GB de RAM recomendados (8 GB funcionam treinando uma área por vez)
- Python: o aplicativo prepara o ambiente na tela **Ambiente** (uv, Python 3.12, pacotes de `requirements.lock` e PyTorch com CUDA ou CPU), sem alterar o Python do computador
- Node.js 20 ou superior, apenas para desenvolver o aplicativo
- Placa NVIDIA opcional (acelera LSTM e Transformer)

## Dados

- **Boletins de ocorrência:** planilhas de veículos subtraídos da Secretaria da Segurança Pública do Estado de São Paulo, disponíveis em https://www.ssp.sp.gov.br/estatistica/consultas. Importe-as na tela **Dados SSP**.
- **Malhas e pontos de interesse (`base/`):** não estão no repositório (cerca de 180 MB). As áreas podem ser criadas no aplicativo a partir de um contorno em GeoJSON, com malha de células e ruas do OpenStreetMap, e os pontos de interesse podem ser baixados na tela **Pontos de interesse**. As malhas das oito áreas usadas no artigo podem ser solicitadas ao autor.

## Rodar o aplicativo

```powershell
cd desktop
npm install
npm start
```

Na primeira abertura, o aplicativo pede a pasta de trabalho e prepara o ambiente Python.

## Gerar o instalador (Windows)

```powershell
cd desktop
npm install
npm run dist
```

O `postdist` executa `tools/check_package.js`, que interrompe o build se o pacote estiver incompleto. A verificação exige a pasta `base/` completa.

## Linha de comando

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu   # ou a versão CUDA

python main.py --ingest --etl --train --fast --predict --month 2026-03
python main.py --validate --month 2026-02
```

A variável `PRECRIME_DATA_DIR` aponta para outra pasta de dados.

## Reproduzir o artigo

Use a tela **Modo científico** (menu Pesquisa):

1. **Reprodução de três meses:** meses de dezembro de 2025 a fevereiro de 2026, treino só no início, sementes 42 a 46, variantes do Ensemble e, se desejar, a comparação com vazamento.
2. **Origem móvel:** meses de janeiro de 2025 a março de 2026, retreino a cada 3 meses, semente 42, variantes do Ensemble.

Cada sequência fica registrada em `runs/_sequencias/`, e a exportação reúne as métricas (PAI, F1-Score, HitEn, PEI, Brier, ECE), os testes de Wilcoxon com correção de Holm e as variantes. As métricas são calculadas em `pipeline/science/metricas.py`, com seleção exata do topo e desempate pela semente.

## Ver o mapa sem o aplicativo

```powershell
node server/server.js                               # lê data/processed, http://127.0.0.1:8080
node server/tools/smoke.js --data data/processed    # verifica todas as rotas
```

## Licença e créditos

Código sob a licença MIT (`LICENSE`). Dados, mapas e bibliotecas de terceiros estão listados em `CREDITS.md`. Para citar, veja `CITATION.cff`.
