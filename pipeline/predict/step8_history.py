"""
step8b_grid_history.py — Gera JSON compacto com histórico semanal de crimes por grid.

Para cada mês de previsão (tag), filtra o dataset por data <= forecast_date e pega
a linha mais recente de cada GRID_ID. Assim o histórico de s1..s24 é relativo ao
mês pedido, não estático.

Saída: data/processed/results/grid_history_{area}_{tag}.json
Formato: { "area": ..., "tag": ..., "n_weeks": 24, "max_total": N,
           "grids": {"GRID_ID": [w1,w2,...,w24]} }
"""
import os
import json
import glob
import pandas as pd
from pipeline import config

N_LAG_WEEKS = 24


def generate_grid_history(area_name: str, forecast_date: str = None) -> str | None:
    ds_path = os.path.join(config.DIR_DATASETS, f'dataset_full_{area_name}.csv')
    if not os.path.exists(ds_path):
        print(f"  [SKIP] {area_name}: dataset não encontrado")
        return None

    # Só as colunas usadas (GRID_ID, data e lag_N): o dataset tem dezenas de colunas e
    # centenas de MB; o resultado é o mesmo.
    cabecalho = pd.read_csv(ds_path, nrows=0).columns
    lag_cols = sorted(
        [c for c in cabecalho if c.startswith('lag_') and c.split('_')[1].isdigit()],
        key=lambda c: int(c.split('_')[1])
    )[:N_LAG_WEEKS]
    df = pd.read_csv(ds_path, usecols=[c for c in cabecalho if c in ('GRID_ID', 'data') or c in lag_cols])

    if not lag_cols:
        print(f"  [SKIP] {area_name}: sem colunas lag_N")
        return None

    # Filtra por data <= forecast_date para que o histórico seja relativo ao mês
    if forecast_date and 'data' in df.columns:
        df['data'] = pd.to_datetime(df['data'], errors='coerce')
        cutoff = pd.to_datetime(forecast_date)
        df = df[df['data'] <= cutoff]
        if df.empty:
            print(f"  [SKIP] {area_name}: sem dados até {forecast_date}")
            return None

    if 'data' in df.columns:
        df = df.sort_values('data')

    # Linha mais recente por GRID_ID (dentro do corte temporal)
    latest = df.groupby('GRID_ID').last().reset_index()

    # Calcula o deslocamento temporal: semanas entre o último dado real e forecast_date.
    # Quando o dataset não tem dados para meses futuros (08-10), os lags são os mesmos
    # para todos esses meses. Deslocar o array insere zeros nas semanas sem dados
    # (topo do cilindro), tornando cada mês visualmente distinto e temporalmente correto.
    shift = 0
    if forecast_date and 'data' in latest.columns:
        max_data_date = pd.to_datetime(latest['data']).max()
        fd = pd.to_datetime(forecast_date)
        if pd.notna(max_data_date) and fd > max_data_date:
            shift = int((fd - max_data_date).days / 7)
            shift = max(0, min(shift, N_LAG_WEEKS))

    grids = {}
    for _, row in latest.iterrows():
        grid_id = str(row['GRID_ID'])
        raw = [int(round(float(row.get(c, 0) or 0))) for c in lag_cols]
        if shift > 0:
            # Prepend zeros (semanas recentes sem dados) e corta pelo comprimento máximo
            weeks = ([0] * shift + raw)[:N_LAG_WEEKS]
        else:
            weeks = raw
        grids[grid_id] = weeks

    max_total = max((sum(v) for v in grids.values()), default=1)
    tag = config.get_forecast_tag(forecast_date) if forecast_date else 'latest'

    out = {
        'area':      area_name,
        'tag':       tag,
        'n_weeks':   len(lag_cols),
        'max_total': int(max_total),
        'grids':     grids,
    }

    out_path = os.path.join(config.DIR_RESULTS, f'grid_history_{area_name}_{tag}.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))

    shift_info = f" | shift={shift}sem" if shift > 0 else ""
    print(f"  -> {area_name} [{tag}]: {len(grids)} grids × {len(lag_cols)} semanas | max_total={max_total}{shift_info}")
    return out_path


def run_step8b(target_area=None, forecast_date=None, **_kwargs):
    forecast_date = forecast_date or config.FORECAST_DATE
    print(f"=== PASSO 8B: HISTÓRICO DE GRIDS (JSON) | {forecast_date} ===")

    pattern = os.path.join(config.DIR_DATASETS, 'dataset_full_*.csv')
    all_areas = [
        os.path.basename(f).replace('dataset_full_', '').replace('.csv', '')
        for f in glob.glob(pattern)
    ]
    final_areas = [target_area] if target_area and target_area in all_areas else sorted(all_areas)

    for area in final_areas:
        generate_grid_history(area, forecast_date=forecast_date)


if __name__ == '__main__':
    import sys
    fd = sys.argv[1] if len(sys.argv) > 1 else None
    run_step8b(forecast_date=fd)
