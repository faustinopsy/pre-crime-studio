import pandas as pd
import sys
import os

# Conta com o fato de que este arquivo esta em pipeline/train/loader.py
# Adiciona src (agora pipeline) ao path para importar config
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pipeline import config

def load_train_dataset(path_full: str, usecols=None) -> pd.DataFrame:
    """
    Carrega o dataset e aplica o filtro DATE_START_DATA unificado.
    Retorna o dataframe se valido, ou None se dataset for muito pequeno/invalido.
    """
    try:
        if usecols:
            df_full = pd.read_csv(path_full, usecols=usecols)
        else:
            df_full = pd.read_csv(path_full)
    except Exception as e:
        print(f"   [ERRO] Falha ao carregar {path_full}: {e}")
        return None

    if len(df_full) < 50:
        print("   [ERRO] Dataset muito pequeno bruto.")
        return None

    # Aplica corte temporal minimo: remove dados anteriores a DATE_START_DATA.
    if 'data' in df_full.columns and getattr(config, 'DATE_START_DATA', None):
        df_full['data'] = pd.to_datetime(df_full['data'], errors='coerce')
        cutoff = pd.to_datetime(config.DATE_START_DATA)
        before = len(df_full)
        df_full = df_full[df_full['data'] >= cutoff].copy()
        dropped = before - len(df_full)
        if dropped > 0:
            print(f"   [INFO] DATE_START_DATA: {dropped} linhas anteriores a {config.DATE_START_DATA} descartadas.")

    # Replay sem vazamento: só linhas cujo alvo (4 semanas seguintes) termina até DATA_END
    if 'data' in df_full.columns and getattr(config, 'DATA_END', None):
        end_date = pd.to_datetime(config.DATA_END)
        limite = df_full['data'] + pd.Timedelta(weeks=config.FORECAST_HORIZON)
        before = len(df_full)
        df_full = df_full[(limite <= end_date) & df_full['target_month'].notna()].copy()
        print(f"   [DATA_END] Treino com alvo completo até {config.DATA_END}: "
              f"{len(df_full)} linhas (removidas {before - len(df_full)}); "
              f"última data de treino: {df_full['data'].max()}")
        # prova de não vazamento no manifesto da execução (app desktop)
        try:
            from pipeline.bridge import events
            area = os.path.basename(path_full)[len('dataset_full_'):-len('.csv')]
            events.metric('train', 'ultima_semana_treino', str(pd.to_datetime(df_full['data'].max()).date()),
                          area=area, data_end=str(config.DATA_END))
        except Exception:
            pass

    if len(df_full) < 50:
        print("   [ERRO] Dataset ficou muito pequeno apos o filtro temporal.")
        return None

    return df_full
