"""Gabarito da validação, independente do período do dataset.

A validação compara a previsão de cada semana com os crimes das 4 semanas seguintes a ela
(`target_month`, a mesma definição de step3_features). Até aqui esse alvo vinha de
dataset_full_<área>.csv, que é cortado pela data final do período (DATA_END). Isso prendia o
operador: para validar janeiro com o alvo de fevereiro, ele tinha de refazer as Features sem
corte, e com isso o treino da previsão de fevereiro passava a enxergar fevereiro.

Aqui o alvo é calculado direto dos crimes por área da Filtragem (processed/crimes, que guarda
todos os meses), com o mesmo pivô semanal (W-MON) e a mesma janela à frente do step3. O dataset
de treino continua cortado; só a validação enxerga os meses seguintes, como deve ser.
Sem corte no período, o resultado é idêntico ao alvo do dataset.

Saída: processed/validacao/gabarito_<área>_<AAAA_MM>.csv (GRID_ID, data, target_month)
"""
import os

import numpy as np
import pandas as pd

from pipeline import config

DIR_VALIDACAO = os.path.join(config.DATA_PROC, 'validacao')


def caminho(area, tag):
    return os.path.join(DIR_VALIDACAO, f'gabarito_{area}_{tag}.csv')


def _pivo(area):
    """Crimes por semana (W-MON) × célula, como no step3_features (sem o corte DATA_END)."""
    import geopandas as gpd
    path_crimes = os.path.join(config.DIR_CRIMES, f'crimes_{area}.csv')
    path_grid = os.path.join(config.DIR_GRIDS, f'{area}.geojson')
    if not os.path.exists(path_crimes) or not os.path.exists(path_grid):
        return None
    grid_ids = gpd.read_file(path_grid)['GRID_ID'].astype(int).unique()
    df = pd.read_csv(path_crimes)
    df['GRID_ID'] = df['GRID_ID'].astype(int)
    if 'qtd_crimes' not in df.columns:
        df['qtd_crimes'] = 1
    df['qtd_crimes'] = df['qtd_crimes'].fillna(0).astype(np.float32)
    df['DATA_OCORRENCIA_BO'] = pd.to_datetime(df['DATA_OCORRENCIA_BO'])
    df = df[df['DATA_OCORRENCIA_BO'] >= pd.to_datetime(config.DATE_START_DATA)]
    if df.empty:
        return None
    df = df.set_index('DATA_OCORRENCIA_BO')
    pivot = df.groupby('GRID_ID')['qtd_crimes'].resample('W-MON').sum().unstack(level=0).fillna(0)
    return pivot.reindex(columns=grid_ids, fill_value=0).astype(np.float32)


def gerar(area, semanas, tag):
    """Grava o gabarito das semanas previstas. Devolve (semanas com alvo conhecido, caminho) ou (None, None)."""
    pivot = _pivo(area)
    if pivot is None:
        return None, None
    indexer = pd.api.indexers.FixedForwardWindowIndexer(window_size=config.FORECAST_HORIZON)
    alvo = pivot.rolling(window=indexer).sum().shift(-1)
    semanas = [pd.Timestamp(s) for s in semanas]
    alvo = alvo.reindex(semanas)
    longo = alvo.melt(var_name='GRID_ID', value_name='target_month', ignore_index=False)
    longo.index.name = 'data'
    longo = longo.reset_index()
    conhecidas = sorted(longo.loc[longo['target_month'].notna(), 'data'].drop_duplicates())
    os.makedirs(DIR_VALIDACAO, exist_ok=True)
    p = caminho(area, tag)
    longo.dropna(subset=['target_month']).to_csv(p, index=False)
    return conhecidas, p


def ultimo_crime(area):
    """Data do último crime da área nos dados da Filtragem (para explicar o que falta)."""
    p = os.path.join(config.DIR_CRIMES, f'crimes_{area}.csv')
    if not os.path.exists(p):
        return None
    d = pd.read_csv(p, usecols=['DATA_OCORRENCIA_BO'])['DATA_OCORRENCIA_BO']
    return pd.to_datetime(d, errors='coerce').max()


def ler(area, tag):
    """Gabarito gravado por gerar() (ou None)."""
    p = caminho(area, tag)
    if not os.path.exists(p):
        return None
    df = pd.read_csv(p)
    df['data'] = pd.to_datetime(df['data'])
    return df
