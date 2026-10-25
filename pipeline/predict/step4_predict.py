"""
Arquivo: src/step9_predict.py
Descrição: Pipeline de PREVISÃO independente do treino.
           Carrega modelos já treinados (pkl / pth) e gera os CSVs de resultado
           com tag de mês/ano (ex: results_rf_area_01_2025_04.csv).

Uso via main.py:
    python main.py --predict                     # usa config.FORECAST_DATE
    python main.py --predict --month 2025-06     # sobrescreve o mês

Uso direto:
    python src/step9_predict.py
    python src/step9_predict.py --month 2025-06
"""

import os
import sys
import glob
import gc
import argparse

import numpy as np
import pandas as pd
import joblib

# Adiciona a raiz do projeto ao path para imports absolutos funcionarem
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from pipeline import config
from pipeline.predict import corte
from pipeline.train import params_io

# ── Helpers ───────────────────────────────────────────────────────────────────


def _marcar_alto(out, probs):
    """Coluna predicao_top10: alto risco pela cobertura e regra de corte escolhidas (padrão:
    top 10% por "maior ou igual ao quantil", como na dissertação). Com outra cobertura ou o top
    exato, grava também predicao_alto (o mesmo valor, com o nome que não depende dos 10%)."""
    probs = np.asarray(probs)
    if corte.exato():
        m = corte.top_exato_mask(probs, corte.frac_alto())
    else:
        m = probs >= np.quantile(probs, config.HOTSPOT_QUANTILE)
    out['predicao_top10'] = m.astype(int)
    if corte.exato() or not corte.cobertura_padrao():
        out['predicao_alto'] = out['predicao_top10']

def _needed_cols(path_full):
    """Retorna apenas as colunas necessárias para predição."""
    peek = pd.read_csv(path_full, nrows=0).columns.tolist()
    feat = [c for c in peek if 'lag_' in c or c in ('neigh_crime_sum', 'neigh_crime_max')]
    return feat, [c for c in feat + ['target_month', 'GRID_ID', 'data'] if c in peek]


def _forecast_rows(df, forecast_date):
    """
    Retorna as linhas do dataset que pertencem ao horizonte de previsão.
    Para previsão operacional, usamos as linhas onde 'data' está dentro do
    intervalo [forecast_date, forecast_date + FORECAST_HORIZON semanas].

    Modo retroativo (meses futuros sem dados no dataset):
    Pega a linha mais recente de cada grid e REPLICA uma cópia por semana do
    horizonte, sobrescrevendo 'data' com a data correta de cada semana.
    Isso garante que step4_ensemble encontre as previsões ao filtrar por data.
    """
    fd = pd.to_datetime(forecast_date)
    end = fd + pd.DateOffset(weeks=config.FORECAST_HORIZON)
    mask = (df['data'] >= fd) & (df['data'] < end)
    subset = df[mask]
    # Semanas do dataset são rotuladas na segunda-feira (resample W-MON):
    # alinha o início do horizonte à primeira segunda-feira >= fd.
    fd_mon = fd + pd.Timedelta(days=(7 - fd.weekday()) % 7)
    if getattr(config, 'DATA_END', None):
        # Replay: usa apenas a linha mais recente de cada célula (features até DATA_END)
        latest = df.sort_values('data').groupby('GRID_ID').last().reset_index()
        print(f"      [DATA_END] Features da semana {latest['data'].max().date()} replicadas a partir de {fd_mon.date()}")
        latest = latest.drop(columns=['target_month'], errors='ignore')
        return pd.concat([latest.assign(data=fd_mon + pd.Timedelta(weeks=i))
                          for i in range(config.FORECAST_HORIZON)], ignore_index=True)
    if len(subset) == 0:
        # Retroativo: replica a última linha de cada grid pelo horizonte completo.
        # Remove target_month — não há crimes reais para este mês, então step7_metrics
        # não produzirá métricas falsas baseadas em dados históricos copiados.
        df_sorted = df.sort_values('data')
        latest = df_sorted.groupby('GRID_ID').last().reset_index()
        latest = latest.drop(columns=['target_month'], errors='ignore')
        horizon = [
            latest.assign(data=fd_mon + pd.Timedelta(weeks=i))
            for i in range(config.FORECAST_HORIZON)
        ]
        return pd.concat(horizon, ignore_index=True)
    return subset


# ── RF ────────────────────────────────────────────────────────────────────────

def predict_rf_single_area(area_name, forecast_date, tag):
    print(f"   [RF] {area_name} → tag={tag}")
    model_path = os.path.join(config.DIR_MODELS, f'rf_{area_name}.pkl')
    if not os.path.exists(model_path):
        print(f"      [PULAR] Modelo não encontrado: {model_path}")
        return

    path_full = os.path.join(config.DIR_DATASETS, f'dataset_full_{area_name}.csv')
    if not os.path.exists(path_full):
        print(f"      [PULAR] Dataset não encontrado: {path_full}")
        return

    feat_cols, needed = _needed_cols(path_full)
    df = pd.read_csv(path_full, usecols=needed)
    df['data'] = pd.to_datetime(df['data'])

    df_pred = _forecast_rows(df, forecast_date)
    del df; gc.collect()

    rf = joblib.load(model_path)
    probs = rf.predict_proba(df_pred[feat_cols].values)[:, 1]
    del rf; gc.collect()

    out = df_pred[['GRID_ID', 'data']].copy()
    out['data'] = out['data'].dt.strftime('%Y-%m-%d')
    out['probabilidade_risco'] = probs
    _marcar_alto(out, probs)
    if 'target_month' in df_pred.columns:
        out['target_month'] = df_pred['target_month'].values

    path_out = os.path.join(config.DIR_RESULTS, f'results_rf_{area_name}_{tag}.csv')
    out.to_csv(path_out, index=False)
    print(f"      -> {path_out}")


# ── LSTM ──────────────────────────────────────────────────────────────────────

def predict_lstm_single_area(area_name, forecast_date, tag):
    print(f"   [LSTM] {area_name} → tag={tag}")
    try:
        import torch
        from torch.utils.data import DataLoader, TensorDataset
        from sklearn.preprocessing import MinMaxScaler
        from pipeline.train.train_lstm import CrimeLSTM, batch_inference
        DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    except ImportError as e:
        print(f"      [PULAR] Dependência ausente: {e}"); return

    model_path  = os.path.join(config.DIR_MODELS, f'lstm_{area_name}.pth')
    scaler_path = os.path.join(config.DIR_MODELS, f'scaler_lstm_{area_name}.pkl')
    if not os.path.exists(model_path) or not os.path.exists(scaler_path):
        print(f"      [PULAR] Modelo/scaler não encontrado para {area_name}"); return

    path_full = os.path.join(config.DIR_DATASETS, f'dataset_full_{area_name}.csv')
    if not os.path.exists(path_full): return

    feat_cols, needed = _needed_cols(path_full)
    df = pd.read_csv(path_full, usecols=needed)
    df['data'] = pd.to_datetime(df['data'])
    df_pred = _forecast_rows(df, forecast_date)
    del df; gc.collect()

    # arquitetura com que o modelo desta área foi treinado (params_lstm_<area>.json)
    params  = params_io.para_previsao('LSTM', area_name)
    scaler  = joblib.load(scaler_path)
    # Alinha feature count ao que o scaler foi treinado (dataset pode ter crescido)
    n_feat = getattr(scaler, 'n_features_in_', len(feat_cols))
    feat_cols = feat_cols[:n_feat]
    X_raw   = df_pred[feat_cols].values.astype(np.float32)
    X_sc    = scaler.transform(X_raw)
    X_3d    = X_sc.reshape((-1, len(feat_cols), 1))

    model = CrimeLSTM(
        input_dim=1,
        hidden_dim=params['hidden_dim'],
        layer_dim=params['layer_dim'],
        output_dim=1,
        dropout_prob=params['dropout_prob'],
    ).to(DEVICE)
    model.load_state_dict(torch.load(model_path, map_location=DEVICE))
    model.eval()

    probs = batch_inference(model, X_3d, params['batch_size'])
    del model, X_3d; torch.cuda.empty_cache(); gc.collect()

    out = df_pred[['GRID_ID', 'data']].copy()
    out['data'] = out['data'].dt.strftime('%Y-%m-%d')
    out['probabilidade_risco'] = probs
    _marcar_alto(out, probs)
    if 'target_month' in df_pred.columns:
        out['target_month'] = df_pred['target_month'].values

    path_out = os.path.join(config.DIR_RESULTS, f'results_lstm_{area_name}_{tag}.csv')
    out.to_csv(path_out, index=False)
    print(f"      -> {path_out}")


# ── Transformer ───────────────────────────────────────────────────────────────

def predict_transformer_single_area(area_name, forecast_date, tag):
    print(f"   [Transformer] {area_name} → tag={tag}")
    try:
        import torch
        from sklearn.preprocessing import MinMaxScaler
        from pipeline.train.train_transformer import CrimeTransformer, batch_inference
        DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    except ImportError as e:
        print(f"      [PULAR] Dependência ausente: {e}"); return

    model_path  = os.path.join(config.DIR_MODELS, f'transformer_{area_name}.pth')
    scaler_path = os.path.join(config.DIR_MODELS, f'scaler_transformer_{area_name}.pkl')
    if not os.path.exists(model_path) or not os.path.exists(scaler_path):
        print(f"      [PULAR] Modelo/scaler não encontrado para {area_name}"); return

    path_full = os.path.join(config.DIR_DATASETS, f'dataset_full_{area_name}.csv')
    if not os.path.exists(path_full): return

    feat_cols, needed = _needed_cols(path_full)
    df = pd.read_csv(path_full, usecols=needed)
    df['data'] = pd.to_datetime(df['data'])
    df_pred = _forecast_rows(df, forecast_date)
    del df; gc.collect()

    # arquitetura com que o modelo desta área foi treinado (params_transformer_<area>.json)
    params  = params_io.para_previsao('Transformer', area_name)
    scaler  = joblib.load(scaler_path)
    # Alinha feature count ao que o scaler foi treinado (dataset pode ter crescido)
    n_feat = getattr(scaler, 'n_features_in_', len(feat_cols))
    feat_cols = feat_cols[:n_feat]
    X_raw   = df_pred[feat_cols].values.astype(np.float32)
    X_sc    = scaler.transform(X_raw)
    X_3d    = X_sc.reshape((-1, len(feat_cols), 1))

    model = CrimeTransformer(
        input_dim=1,
        embed_dim=params['embed_dim'],
        num_heads=params['num_heads'],
        ff_dim=params['ff_dim'],
        num_layers=params['num_layers'],
        output_dim=1,
        dropout_prob=params['dropout_prob'],
    ).to(DEVICE)
    model.load_state_dict(torch.load(model_path, map_location=DEVICE))
    model.eval()

    probs = batch_inference(model, X_3d, params['batch_size'])
    del model, X_3d; torch.cuda.empty_cache(); gc.collect()

    out = df_pred[['GRID_ID', 'data']].copy()
    out['data'] = out['data'].dt.strftime('%Y-%m-%d')
    out['probabilidade_risco'] = probs
    _marcar_alto(out, probs)
    if 'target_month' in df_pred.columns:
        out['target_month'] = df_pred['target_month'].values

    path_out = os.path.join(config.DIR_RESULTS, f'results_transformer_{area_name}_{tag}.csv')
    out.to_csv(path_out, index=False)
    print(f"      -> {path_out}")


# ── Orquestrador do step ──────────────────────────────────────────────────────

def run_step9(target_area=None, forecast_date=None):
    """
    Gera previsões para todos os modelos (RF, LSTM, Transformer) e todas as áreas.
    Os CSVs são salvos com tag de mês/ano para coexistência de múltiplos meses.
    """
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = config.get_forecast_tag(forecast_date)

    print(f"=== PASSO 9: PREVISÃO (forecast_date={forecast_date}, tag={tag}) ===")

    datasets = sorted(glob.glob(os.path.join(config.DIR_DATASETS, 'dataset_full_*.csv')))
    areas = [os.path.basename(f).replace('dataset_full_', '').replace('.csv', '') for f in datasets]

    if target_area:
        areas = [a for a in areas if a == target_area]
        if not areas:
            print(f"   [ERRO] Área '{target_area}' não encontrada."); return

    for area in areas:
        print(f"\n--- {area} ---")
        predict_rf_single_area(area, forecast_date, tag)
        predict_lstm_single_area(area, forecast_date, tag)
        predict_transformer_single_area(area, forecast_date, tag)
        gc.collect()

    print(f"\n=== FIM DO PASSO 9 — CSVs salvos com tag '{tag}' ===")


# ── CLI standalone ────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description="Gera previsões a partir de modelos treinados.")
    parser.add_argument('--month',  type=str, default=None,
                        help="Mês de previsão: YYYY-MM (ex: 2025-06). Padrão: config.FORECAST_DATE")
    parser.add_argument('--area',   type=str, default=None,
                        help="Área específica (ex: area_01). Padrão: todas.")
    args = parser.parse_args()

    forecast_date = None
    if args.month:
        # aceita "2025-06" ou "2025-06-01"
        parts = args.month.split('-')
        forecast_date = f"{parts[0]}-{parts[1].zfill(2)}-01"

    run_step9(target_area=args.area, forecast_date=forecast_date)
