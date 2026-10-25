# Pasta de dados

Fica fora do git. É a pasta padrão da **linha de comando** (`python main.py ...`). O app desktop não usa esta pasta: ele usa a pasta de trabalho escolhida pelo usuário, que tem a mesma estrutura. Para a linha de comando usar outra pasta: `PRECRIME_DATA_DIR`.

As malhas (`streets/`) e os POIs (`pois/`) ficam em `base/` na raiz do repositório; copie para cá se for rodar pela linha de comando.

```
data/
├── dados_ssp/      VeiculosSubtraidos_AAAA.xlsx (SSP-SP)            entrada
├── streets/        grids_area_XX.geojson + ruas_area_XX.geojson     entrada (malhas fixas)
├── pois/           pois_area_XX.geojson                             entrada (pontos de interesse)
├── raw/            dados_unificados.csv                             gerado pela Limpeza
├── processed/
│   ├── grids/      área filtrada pela malha viária                  Filtragem
│   ├── crimes/     crimes por grid e data                           Filtragem
│   ├── datasets/   dataset_full_area_XX.csv (24 lags, alvo t+4)     Features
│   ├── models/     rf_*.pkl, lstm_*.pth, transformer_*.pth          Treino
│   ├── results/    results_*_AAAA_MM.csv, grid_history_*, metrics_summary_all.csv
│   ├── results_geojson/  hotspots_*_AAAA_MM.geojson, crimes_reais_*.geojson
│   └── metrics/    zhang_comparison.csv (captura por quantil)
├── runs/           registro de cada execução
├── publish/
│   ├── geojson/AAAA-MM/   GeoJSON exportados (abrem no geojson.io)
│   ├── imagens/           PNG das previsões (botão do mapa)
│   └── pacotes/           pacote para servidor Node
└── parametros.json parâmetros da Limpeza escolhidos no app
```

As planilhas da SSP estão em https://www.ssp.sp.gov.br/estatistica/consultas
