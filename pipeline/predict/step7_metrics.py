"""
Arquivo: src/step7_metrics.py
Descrição: Calcula Métricas separando 'Foco' (High Risk) de 'Cobertura' (Total Risk).
Resolve a inconsistência visual vs numérica.
"""

import pandas as pd
import matplotlib
matplotlib.use('Agg') 
import matplotlib.pyplot as plt
import seaborn as sns
import os
import glob
import numpy as np
from pipeline import config
from pipeline.predict import corte
from pipeline.train import validation as vf
from datetime import datetime

plt.style.use('ggplot')

def find_optimal_threshold(risk, crimes, crime_threshold=0, search_range=(0.70, 0.99, 30)):
    """
    Encontra o quantil de corte que MAXIMIZA o F1-Score para esta área específica.

    Cada área tem uma distribuição diferente de crimes:
    - Áreas densas (centro): threshold mais alto (0.95+) para evitar muitos FP
    - Áreas esparsas (periferia): threshold mais baixo (0.75-0.85) para não perder crimes raros

    Retorna: (quantil_ótimo, threshold_ótimo, f1_ótimo)
    """
    q_min, q_max, n_steps = search_range
    quantis = np.linspace(q_min, q_max, n_steps)

    best_q   = q_min
    best_thr = risk.quantile(q_min)
    best_f1  = -1.0

    has_crime = crimes > crime_threshold

    for q in quantis:
        thr = risk.quantile(q)
        is_positive = risk >= thr

        tp = (is_positive &  has_crime).sum()
        fp = (is_positive & ~has_crime).sum()
        fn = (~is_positive & has_crime).sum()

        precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall    = tp / (tp + fn) if (tp + fn) > 0 else 0
        f1        = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0

        if f1 > best_f1:
            best_f1  = f1
            best_q   = q
            best_thr = thr

    return best_q, best_thr, best_f1


def calculate_dual_metrics(df_results_filtered):
    """
    Calcula métricas em dois níveis:
    1. STRICT (Vermelho): Para medir eficiência operacional (PAI).
    2. BROAD (Vermelho + Amarelo): Para medir cobertura total de segurança.
    
    Agora usa config.METRICS_THRESHOLDS para todos os valores!
    """
    if df_results_filtered.empty:
        return {}

    # 1. Preparação dos Dados
    risk = df_results_filtered.groupby('GRID_ID')['probabilidade_risco'].mean()
    
    col_target = 'target_month' if 'target_month' in df_results_filtered.columns else 'target'
    if col_target not in df_results_filtered.columns: return {}

    crimes = df_results_filtered.groupby('GRID_ID')[col_target].sum()
    total_crimes_count = crimes.sum()

    # Sem crimes reais registrados neste período → não há como calcular métricas válidas.
    # Retorna vazio para que o CSV NÃO grave linhas com tudo zero (evita linhas vazias nas métricas).
    if total_crimes_count <= 0:
        return {}
    
    # 2. Carrega Thresholds do Config (CENTRALIZADO!)
    thresholds = config.METRICS_THRESHOLDS
    min_prob   = thresholds['ABSOLUTE_MIN_PROB']

    # --- THRESHOLD DINÂMICO OU FIXO ---
    if thresholds.get('DYNAMIC_THRESHOLD', False):
        # Busca o quantil que maximiza F1 para ESTA área específica
        search_range = thresholds.get('HIGH_RISK_SEARCH_RANGE', (0.70, 0.99, 30))
        opt_q, limit_red, opt_f1 = find_optimal_threshold(
            risk, crimes,
            crime_threshold=thresholds.get('REAL_CRIME_THRESHOLD', 0),
            search_range=search_range
        )
        threshold_mode = f'DYNAMIC(q={opt_q:.3f})'
    else:
        # Usa o quantil fixo do config (comportamento anterior)
        opt_q = thresholds['HIGH_RISK_QUANTILE']
        limit_red = risk.quantile(opt_q)
        threshold_mode = f'FIXED(q={opt_q:.2f})'

    # Amarelo (Médio Risco) — sempre fixo (usado apenas para cobertura visual)
    limit_yellow = risk.quantile(thresholds['MEDIUM_RISK_QUANTILE'])

    # Piso mínimo absoluto
    limit_red    = max(limit_red, min_prob)
    limit_yellow = max(limit_yellow, min_prob)

    # 3. Classificação
    if corte.exato() and not thresholds.get('DYNAMIC_THRESHOLD', False):
        # top exato: exatamente a fração escolhida, empates desempatados com a semente
        is_red = corte.top_exato(risk, 1 - thresholds['HIGH_RISK_QUANTILE'])
        is_broad = corte.top_exato(risk, 1 - thresholds['MEDIUM_RISK_QUANTILE'])
        threshold_mode = f"TOP_EXATO(q={thresholds['HIGH_RISK_QUANTILE']:.2f})"
        limit_red = float(risk[is_red].min()) if is_red.any() else limit_red
        limit_yellow = float(risk[is_broad].min()) if is_broad.any() else limit_yellow
    else:
        # Nível 1: Foco Cirúrgico (Só Vermelho)
        is_red = risk >= limit_red

        # Nível 2: Cobertura Ampla (Vermelho OU Amarelo)
        is_broad = risk >= limit_yellow
    
    # Tem crime? (Usa threshold do config se configurado)
    crime_threshold = thresholds.get('REAL_CRIME_THRESHOLD', 0)
    has_crime = crimes > crime_threshold

    # --- CÁLCULOS NÍVEL 1 (VERMELHO - STRICT) ---
    hotspots_red_idx = risk[is_red].index
    caught_red = crimes.loc[hotspots_red_idx].sum()
    
    hit_rate_strict = (caught_red / total_crimes_count) * 100 if total_crimes_count > 0 else 0
    area_perc_strict = (len(hotspots_red_idx) / len(risk)) * 100
    pai = hit_rate_strict / area_perc_strict if area_perc_strict > 0 else 0

    # Matriz Confusão (Strict - só vermelho)
    tp_strict = (is_red & has_crime).sum()
    fp_strict = (is_red & ~has_crime).sum()
    fn_strict = (~is_red & has_crime).sum()

    # --- CÁLCULOS NÍVEL 2 (AMPLO - BROAD) ---
    hotspots_broad_idx = risk[is_broad].index
    caught_broad = crimes.loc[hotspots_broad_idx].sum()
    
    hit_rate_broad = (caught_broad / total_crimes_count) * 100 if total_crimes_count > 0 else 0
    
    # Matriz Confusão (Broad - vermelho + amarelo)
    tp_broad = (is_broad & has_crime).sum()
    fn_broad = (~is_broad & has_crime).sum()
    fp_broad = (is_broad & ~has_crime).sum()

    # === DECISÃO: Qual modo usar para métricas principais? ===
    # Configura no config.METRICS_THRESHOLDS['CONFUSION_MATRIX_MODE']
    confusion_mode = thresholds.get('CONFUSION_MATRIX_MODE', 'HIGH_ONLY')
    
    if confusion_mode == 'HIGH_ONLY':
        # Usa apenas ALTO RISCO (vermelho) - Métricas rigorosas
        tp_main = tp_strict
        fp_main = fp_strict
        fn_main = fn_strict
        tn_main = (~is_red & ~has_crime).sum()
    else:  # 'HIGH_AND_MEDIUM'
        # Usa ALTO + MÉDIO (vermelho + amarelo) - Cobertura ampla
        tp_main = tp_broad
        fp_main = fp_broad
        fn_main = fn_broad
        tn_main = (~is_broad & ~has_crime).sum()
    
    # Precision/Recall/F1 usando o modo configurado
    precision = tp_main / (tp_main + fp_main) if (tp_main + fp_main) > 0 else 0
    recall = tp_main / (tp_main + fn_main) if (tp_main + fn_main) > 0 else 0
    f1_score = 2 * (precision * recall) / (precision + recall) if (precision + recall) > 0 else 0
    
    # Acurácia Global
    accuracy = (tp_main + tn_main) / len(risk)

    return {
        'Hit Rate (Foco)': hit_rate_strict,      # Ex: 40%
        'Hit Rate (Cobertura)': hit_rate_broad,  # Ex: 94%
        'PAI': pai,
        'F1-Score': f1_score,
        'Precision': precision,
        'Recall': recall,
        'Accuracy': accuracy,
        'TP (Red)': int(tp_strict),
        'TP (Broad)': int(tp_broad),
        'FN (Strict)': int(fn_strict),
        'FN (Real Miss)': int(fn_broad),
        # Matriz de confusão EFETIVA usada no F1/Precision/Recall (depende do
        # CONFUSION_MATRIX_MODE). Gravar estes valores garante que recalcular o
        # F1 a partir de TP/TN/FP/FN reproduza exatamente o campo F1-Score.
        'TP (Main)': int(tp_main),
        'FN (Main)': int(fn_main),
        'FP': int(fp_main),
        'TN': int(tn_main),
        'Area %': area_perc_strict,
        'Total Crimes': total_crimes_count,
        'Confusion Mode': confusion_mode,
        'Threshold Mode': threshold_mode,   # DYNAMIC ou FIXED + qual quantil usou
        'High Risk Quantile': round(opt_q, 4),  # Quantil efetivo usado (para auditoria)
        'High Risk Threshold': limit_red,
        'Medium Risk Threshold': limit_yellow
    }

def process_area_metrics(area_name, run_timestamp, forecast_date=None, tag=None):
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = tag or config.get_forecast_tag(forecast_date)
    print(f"--- Processando Métricas (Dual View): {area_name} | tag={tag} ---")
    models = ['RF', 'LSTM', 'Transformer', 'Ensemble']
    area_results = []

    # as mesmas 4 semanas da previsão e do gabarito: a partir da 1ª segunda-feira do mês
    start_val = pd.to_datetime(forecast_date)
    start_val = start_val + pd.Timedelta(days=(7 - start_val.weekday()) % 7)
    end_val = start_val + pd.Timedelta(weeks=config.FORECAST_HORIZON - 1)

    for model in models:
        p_file = os.path.join(config.DIR_RESULTS, f"results_{model.lower()}_{area_name}_{tag}.csv")
        if os.path.exists(p_file):
            df = pd.read_csv(p_file)
            if 'data' in df.columns:
                df['data'] = pd.to_datetime(df['data'])
                df_filtered = df[(df['data'] >= start_val) & (df['data'] <= end_val)]
            else:
                df_filtered = df
            
            # --- RECUPERAÇÃO DE LABELS (TESTE CEGO) ---
            has_labels = 'target_month' in df_filtered.columns
            needs_recovery = not has_labels or (has_labels and df_filtered['target_month'].sum() == 0)

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
                        
                        # Remove coluna zerada antiga se existir para evitar duplicidade no merge
                        if has_labels: df_filtered = df_filtered.drop(columns=['target_month'])
                        
                        df_filtered = df_filtered.merge(df_ds, on=['GRID_ID', 'data'], how='left')
                    except Exception as e:
                        print(f"      [ERRO] Falha ao recuperar labels do dataset: {e}")

            if df_filtered.empty: continue

            m = calculate_dual_metrics(df_filtered)
            if not m: continue
            
            row = {
                'Run_Timestamp': run_timestamp,
                'Tag': tag,
                'Area': area_name,
                'Modelo': model,
                'Hit Rate (Foco)': m['Hit Rate (Foco)'],
                'Hit Rate (Cobertura)': m['Hit Rate (Cobertura)'],
                'PAI': m['PAI'],
                'F1-Score': m['F1-Score'],
                'Precision': m['Precision'],
                'Recall': m['Recall'],
                'Accuracy': m['Accuracy'],
                'TP (Foco)': m['TP (Red)'],
                'TP (Total)': m['TP (Broad)'],
                'FN (Perdidos)': m['FN (Real Miss)'],
                # Matriz canônica TP/TN/FP/FN coerente com o F1-Score da linha.
                # (Antes 'FN' gravava o FN amplo (vermelho+amarelo) enquanto TP/FP
                #  eram estritos, tornando o F1 irreproduzível a partir da matriz.)
                'TP': m['TP (Main)'],
                'TN': m['TN'],
                'FP': m['FP'],
                'FN': m['FN (Main)'],
                'Crimes Totais': m['Total Crimes']
            }
            area_results.append(row)
            print(f"   [{model}] Foco (Red): {m['Hit Rate (Foco)']:.1f}% | Cobertura (Red+Yel): {m['Hit Rate (Cobertura)']:.1f}%")
            
                        # Removido render de PNG obsoleto.

    return area_results

def run_step7(target_area=None, forecast_date=None):
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = config.get_forecast_tag(forecast_date)
    run_timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"=== PASSO 7: CÁLCULO DE MÉTRICAS DUAL (FOCO vs COBERTURA) | tag={tag} ===")

    os.makedirs(config.DIR_METRICS, exist_ok=True)
    pattern = os.path.join(config.DIR_GRIDS, "*.geojson")
    all_areas = [os.path.basename(f).replace(".geojson", "") for f in glob.glob(pattern)]
    final_areas = [target_area] if target_area and target_area in all_areas else sorted(all_areas)

    all_metrics = []
    for area in final_areas:
        res = process_area_metrics(area, run_timestamp, forecast_date=forecast_date, tag=tag)
        all_metrics.extend(res)
        
    if all_metrics:
        df_new = pd.DataFrame(all_metrics)
        csv_path = os.path.join(config.DIR_RESULTS, "metrics_summary_all.csv")
        
        if os.path.exists(csv_path):
            df_old = pd.read_csv(csv_path)
            # Remove as linhas desta tag nas áreas processadas agora, para evitar duplicatas
            # e métricas obsoletas. Com --area, as outras áreas do mesmo mês ficam como estão
            # (antes eram apagadas).
            if 'Tag' in df_old.columns and tag:
                velhas = df_old['Tag'].astype(str) == str(tag)
                if 'Area' in df_old.columns:
                    velhas &= df_old['Area'].isin(final_areas)
                df_old = df_old[~velhas]
            df_final = pd.concat([df_old, df_new], ignore_index=True)
        else:
            df_final = df_new
            
        df_final.to_csv(csv_path, index=False)
        print(f"\nResumo salvo em: {csv_path}")
    return all_metrics

if __name__ == "__main__":
    run_step7()