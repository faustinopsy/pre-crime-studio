"""
Arquivo: src/step7b_zhang_comparison.py
Descricao: Calcula metricas de Zhang et al. (HitRa, HitRn, HitEn) + PAI
           e gera tabela comparativa entre modelos.
Referencia: Zhang et al., IEEE Access, 2020 (DOI: 10.1109/ACCESS.2020.3028420)

Metricas (definicoes fieis ao artigo original):
  HitRa = a* / A          (eq. 8  - Grid Hit Rate: grids hotspot acertados / grids hotspot reais)
  HitRn = n  / N          (eq. 9  - Case Hit Rate: crimes capturados / total de crimes)
  HitEn = HitRn / (a / A) (eq. 10 - Hit Efficiency Index, onde:
                            a = numero de grids PREVISTOS como hotspot;
                            A = numero REAL de grids hotspot.
                           NAO e normalizado pela area total!)
  PAI   = HitRn / (a / A_total)  (Chainey & Ratcliffe, 2005 - Predictive Accuracy
                            Index: eficiencia por fracao da AREA TOTAL monitorada)


Relacao com o projeto Pre-Crime:
  HitRn -> equivalente ao Hit Rate (Foco)/100 do step7_metrics
  PAI   -> equivalente ao PAI do step7_metrics
"""

import pandas as pd
import numpy as np
import os
import glob as glob_module
import sys

# Garante que src/ esta no path ao rodar isolado
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from pipeline import config


def calculate_zhang_metrics(df_results, area_name, n_top=None, quantile=None):
    """
    Calcula as metricas de Zhang (+PAI) para um DataFrame de resultados.

    Parametros:
    -----------
    df_results : pd.DataFrame
        DataFrame com colunas: GRID_ID, probabilidade_risco, target_month
    area_name : str
        Nome da area (para logs)
    n_top : int, opcional
        Numero fixo de grids a marcar como hotspot.
        Se None, usa quantile.
    quantile : float, opcional
        Quantil para definir o threshold (ex: 0.90 = top 10%).
        Se None, usa config.METRICS_THRESHOLDS['HIGH_RISK_QUANTILE'].

    Retorna:
    --------
    dict com: HitRa, HitRn, HitEn (Zhang eq. 10), PAI, Area_Ratio,
              N_Predicted_Grids, N_Actual_Hotspots, N_Correct_Predictions,
              Total_Grids, Total_Crimes, Crimes_Captured, Threshold
    """
    if df_results is None or df_results.empty:
        return None

    # 1. Agrega por GRID_ID (media de risco, soma de crimes)
    risk = df_results.groupby('GRID_ID')['probabilidade_risco'].mean()

    col_target = 'target_month' if 'target_month' in df_results.columns else 'target'
    if col_target not in df_results.columns:
        return None

    crimes = df_results.groupby('GRID_ID')[col_target].sum()

    total_grids = len(risk)         # A_total (todos os grids)
    total_crimes = crimes.sum()     # N (total de crimes)

    if total_crimes == 0 or total_grids == 0:
        return None

    # 2. Define threshold de hotspot
    if n_top is not None:
        n_top = min(n_top, len(risk))
        predicted_hotspots = risk.nlargest(n_top).index
        threshold = risk.nlargest(n_top).iloc[-1]
    else:
        q = quantile if quantile is not None else config.METRICS_THRESHOLDS['HIGH_RISK_QUANTILE']
        threshold = risk.quantile(q)
        predicted_hotspots = risk[risk >= threshold].index

    n_predicted = len(predicted_hotspots)  # a (grids preditos como hotspot)

    # 3. Grids que realmente tiveram crime (ground truth)
    crime_threshold = config.METRICS_THRESHOLDS.get('REAL_CRIME_THRESHOLD', 0)
    actual_hotspots = crimes[crimes > crime_threshold].index
    n_actual = len(actual_hotspots)        # A (grids reais com crime)

    if n_actual == 0:
        return None

    # 4. Intersecao: grids preditos que realmente tiveram crime
    correct_hotspots = predicted_hotspots.intersection(actual_hotspots)
    n_correct = len(correct_hotspots)      # a* (preditos corretamente)

    # 5. Crimes dentro dos grids preditos
    crimes_in_predicted = crimes.loc[
        crimes.index.intersection(predicted_hotspots)
    ].sum()

    # 6. Calculo das metricas de Zhang
    # HitRa = a* / A  (Grid Hit Rate - Recall a nivel de grids)
    hit_ra = n_correct / n_actual if n_actual > 0 else 0.0

    # HitRn = n / N  (Case Hit Rate - proporcao de crimes capturados)
    hit_rn = float(crimes_in_predicted) / float(total_crimes) if total_crimes > 0 else 0.0

    # Area ratio = a / A_total  (fracao da area monitorada) - insumo do PAI
    area_ratio = n_predicted / total_grids if total_grids > 0 else 0.0

    # PAI = HitRn / (a / A_total)  (Chainey & Ratcliffe, 2005)
    pai = hit_rn / area_ratio if area_ratio > 0 else 0.0

    # HitEn = HitRn / (a / A)  - Zhang et al. (2020), eq. (10)
    #   a = grids PREVISTOS como hotspot | A = grids hotspot REAIS
    #   Diretamente comparavel as Tabelas 2-4 do artigo de Zhang.
    hit_en = hit_rn / (n_predicted / n_actual) if n_predicted > 0 else 0.0

    return {
        'HitRa':                round(hit_ra, 4),
        'HitRn':                round(hit_rn, 4),
        'HitEn':                round(hit_en, 4),
        'PAI':                  round(pai, 4),
        'Area_Ratio':           round(area_ratio, 4),
        'N_Predicted_Grids':    n_predicted,
        'N_Actual_Hotspots':    n_actual,
        'N_Correct_Predictions': n_correct,
        'Total_Grids':          total_grids,
        'Total_Crimes':         int(total_crimes),
        'Crimes_Captured':      int(crimes_in_predicted),
        'Threshold':            round(float(threshold), 6),
    }


def generate_model_comparison(area_name, quantiles=None, forecast_date=None, tag=None):
    """
    Gera tabela comparativa no estilo Zhang para todos os modelos disponiveis.

    Parametros:
    -----------
    area_name : str
        Nome da area (ex: 'area_01')
    quantiles : list[float], opcional
        Quantis a testar. Default: [0.80, 0.85, 0.90, 0.95]
    forecast_date : str, opcional
        Data de referencia para filtrar resultados.
    tag : str, opcional
        Tag YYYY_MM para localizar os arquivos de resultado.

    Retorna:
    --------
    pd.DataFrame com comparacao lado-a-lado (modelo x quantil x metricas)
    """
    if quantiles is None:
        quantiles = [0.80, 0.85, 0.90, 0.95]

    forecast_date = forecast_date or config.FORECAST_DATE
    tag = tag or config.get_forecast_tag(forecast_date)

    models = ['RF', 'LSTM', 'Transformer', 'Ensemble']
    results = []

    for model in models:
        p_file = os.path.join(
            config.DIR_RESULTS,
            f"results_{model.lower()}_{area_name}_{tag}.csv"
        )
        if not os.path.exists(p_file):
            continue

        try:
            df = pd.read_csv(p_file)
        except Exception as e:
            print(f"   [AVISO] Nao foi possivel ler {p_file}: {e}")
            continue

        # --- RECUPERACAO DE LABELS (TESTE CEGO) ---
        # Se os resultados vieram de uma previsao cega, eles nao tem target_month OU ele esta zerado.
        has_labels = 'target_month' in df.columns or 'target' in df.columns
        needs_recovery = not has_labels or (has_labels and df['target_month'].sum() == 0)

        if needs_recovery:
            path_ds = os.path.join(config.DIR_DATASETS, f"dataset_full_{area_name}.csv")
            # gabarito da validação (crimes da Filtragem, sem o corte do período), quando existe
            from pipeline.predict import gabarito as _gab
            if tag and os.path.exists(_gab.caminho(area_name, tag)):
                path_ds = _gab.caminho(area_name, tag)
            if os.path.exists(path_ds):
                try:
                    df_ds = pd.read_csv(path_ds, usecols=['GRID_ID', 'data', 'target_month'])
                    df_ds['data'] = pd.to_datetime(df_ds['data'])

                    # Filtra o dataset para o mes/ano da tag atual
                    target_dt = pd.to_datetime(forecast_date)
                    df_ds = df_ds[(df_ds['data'].dt.year == target_dt.year) & (df_ds['data'].dt.month == target_dt.month)]

                    # Agrupa crimes por GRID_ID para o mes inteiro (independente do dia da semana)
                    ground_truth = df_ds.groupby('GRID_ID')['target_month'].sum().reset_index()

                    # Remove a coluna zerada antiga se ela existir para nao duplicar no merge
                    if 'target_month' in df.columns:
                        df = df.drop(columns=['target_month'])
                    if 'target' in df.columns:
                        df = df.drop(columns=['target'])

                    # Merge nos resultados da aposta (apenas por GRID_ID)
                    df = df.merge(ground_truth, on='GRID_ID', how='left').fillna({'target_month': 0})
                except Exception as e:
                    print(f"      [AVISO] Erro ao buscar gabarito no dataset: {e}")

        # Filtra pelo periodo de previsao configurado
        if 'data' in df.columns:
            df['data'] = pd.to_datetime(df['data'], errors='coerce')
            # as mesmas 4 semanas da previsão e do gabarito (1ª segunda-feira do mês em diante)
            start_val = pd.to_datetime(forecast_date)
            start_val = start_val + pd.Timedelta(days=(7 - start_val.weekday()) % 7)
            end_val = start_val + pd.Timedelta(weeks=getattr(config, 'FORECAST_HORIZON', 4) - 1)
            df = df[(df['data'] >= start_val) & (df['data'] <= end_val)]

        if df.empty:
            continue

        for q in quantiles:
            metrics = calculate_zhang_metrics(df, area_name, quantile=q)
            if metrics:
                metrics['Model'] = model
                metrics['Quantile'] = q
                metrics['Area'] = area_name
                metrics['Tag'] = tag
                results.append(metrics)

    if results:
        return pd.DataFrame(results)
    return pd.DataFrame()


def run_step7b(target_area=None, forecast_date=None):
    """
    Executa o calculo de metricas Zhang e exporta CSVs comparativos.

    Saidas em data/processed/metrics/:
      - zhang_comparison.csv       (tabela completa)
      - zhang_hitra_pivot.csv      (HitRa: Area x Model, formato artigo)
      - zhang_hitrn_pivot.csv      (HitRn)
      - zhang_hiten_pivot.csv      (HitEn - eq. 10 de Zhang, comparavel ao artigo)
      - zhang_pai_pivot.csv        (PAI - Chainey & Ratcliffe, ex-'HitEn' do projeto)
    """
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = config.get_forecast_tag(forecast_date)
    print(f"=== PASSO 7B: METRICAS ZHANG (HitRa, HitRn, HitEn, PAI) | tag={tag} ===")

    os.makedirs(config.DIR_METRICS, exist_ok=True)

    # Descobre as areas disponiveis
    pattern = os.path.join(config.DIR_GRIDS, "*.geojson")
    all_areas = sorted([
        os.path.basename(f).replace(".geojson", "")
        for f in glob_module.glob(pattern)
    ])

    if not all_areas:
        print("[AVISO] Nenhum geojson encontrado em DIR_GRIDS. Abortando step7b.")
        return

    if target_area and target_area in all_areas:
        areas = [target_area]
    else:
        areas = all_areas

    all_comparisons = []

    for area in areas:
        print(f"\n--- {area} ---")
        df_comp = generate_model_comparison(area, forecast_date=forecast_date, tag=tag)

        if df_comp.empty:
            print(f"   [AVISO] Sem resultados para {area}. Verifique se os CSVs de resultados existem.")
            continue

        all_comparisons.append(df_comp)

        # Exibe resumo no terminal por quantil
        for q in sorted(df_comp['Quantile'].unique()):
            print(f"\n  Quantile = {q:.2f}  (Top {(1-q)*100:.0f}% dos grids):")
            subset = df_comp[df_comp['Quantile'] == q].sort_values('PAI', ascending=False)
            for _, row in subset.iterrows():
                print(
                    f"    [{row['Model']:12s}] "
                    f"HitRa={row['HitRa']:.3f}  "
                    f"HitRn={row['HitRn']:.3f}  "
                    f"HitEn={row['HitEn']:.3f}  "
                    f"PAI={row['PAI']:.3f}  "
                    f"(Crimes: {row['Crimes_Captured']}/{row['Total_Crimes']})"
                )

    if not all_comparisons:
        print("\n[AVISO] Nenhuma comparacao gerada. Verifique se o pipeline foi executado.")
        return pd.DataFrame()

    df_new = pd.concat(all_comparisons, ignore_index=True)

    # --- CSV completo ---
    csv_path = os.path.join(config.DIR_METRICS, "zhang_comparison.csv")

    if os.path.exists(csv_path):
        df_old = pd.read_csv(csv_path)
        if 'Tag' in df_old.columns and tag:
            # só as áreas processadas agora (com --area, as outras do mesmo mês ficam)
            velhas = df_old['Tag'].astype(str) == str(tag)
            if 'Area' in df_old.columns:
                velhas &= df_old['Area'].isin(areas)
            df_old = df_old[~velhas]
        df_final = pd.concat([df_old, df_new], ignore_index=True)
    else:
        df_final = df_new

    df_final.to_csv(csv_path, index=False)
    print(f"\n[OK] Comparacao completa salva em: {csv_path}")

    # --- Tabelas pivot por metrica (formato artigo) ---
    # Geramos os pivots a partir de df_final (TODAS as tags acumuladas, igual ao
    # zhang_comparison.csv) e incluimos 'Tag' no indice. Antes os pivots usavam
    # apenas df_new (a ultima rodada) e descartavam a Tag, fazendo o pivot refletir
    # so o ultimo mes - o que divergia do comparison para a mesma celula.
    for metric_name in ['HitRa', 'HitRn', 'HitEn', 'PAI']:
        try:
            pivot = df_final.pivot_table(
                index=['Tag', 'Area', 'Quantile'],
                columns='Model',
                values=metric_name,
                aggfunc='mean'
            )
            pivot_path = os.path.join(
                config.DIR_METRICS,
                f"zhang_{metric_name.lower()}_pivot.csv"
            )
            pivot.to_csv(pivot_path)
            print(f"[OK] Tabela {metric_name} salva em: {pivot_path}")
        except Exception as e:
            print(f"[AVISO] Nao foi possivel gerar pivot de {metric_name}: {e}")
    return df_new


if __name__ == "__main__":
    run_step7b()
