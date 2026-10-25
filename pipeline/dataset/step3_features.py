"""
Arquivo: step2_matrix.py
Descrição: Gera matrizes com Target Acumulado (t+1 até t+4) usando MultiIndex
para garantir alinhamento perfeito e evitar o bug dos zeros.
"""
import pandas as pd
import geopandas as gpd
import numpy as np
import os
import glob
import gc
from pipeline import config
from pipeline.bridge import events

_AREA_POS = [0, 1]   # (índice, total) da área em processamento, só para o progresso


def generate_matrix_for_area(area_name):
    """
    Gera dataset tabular usando MultiIndex para garantir alinhamento perfeito.
    Target = Soma dos crimes das próximas 'FORECAST_HORIZON' semanas.
    """
    
    path_grid = os.path.join(config.DIR_GRIDS, f"{area_name}.geojson")
    path_crimes = os.path.join(config.DIR_CRIMES, f"crimes_{area_name}.csv")
    
    if not os.path.exists(path_crimes):
        print(f"   [PULAR] CSV não encontrado: {path_crimes}")
        return

    print(f"\n-> Gerando Matriz Científica (t+{config.FORECAST_HORIZON}): {area_name}")
    
    # 1. Carregar e Tipar
    gdf_grid = gpd.read_file(path_grid)
    df_crimes = pd.read_csv(path_crimes)
    
    # Força tipos INTEIROS no ID (Crucial para o match)
    gdf_grid['GRID_ID'] = gdf_grid['GRID_ID'].astype(int)
    df_crimes['GRID_ID'] = df_crimes['GRID_ID'].astype(int)
    
    if 'qtd_crimes' not in df_crimes.columns: df_crimes['qtd_crimes'] = 1
    
    df_crimes['qtd_crimes'] = df_crimes['qtd_crimes'].fillna(0).astype(np.float32)
    df_crimes['DATA_OCORRENCIA_BO'] = pd.to_datetime(df_crimes['DATA_OCORRENCIA_BO'])
    
    # Período do dataset (DATE_START_DATA .. DATA_END). O ETL já corta pelo mesmo
    # período quando roda junto (main.py --etl); aqui garante o corte também quando os
    # crimes por área foram gerados com um período mais largo (app desktop).
    inicio = pd.to_datetime(config.DATE_START_DATA)
    df_crimes = df_crimes[df_crimes['DATA_OCORRENCIA_BO'] >= inicio]
    if getattr(config, 'DATA_END', None):
        df_crimes = df_crimes[df_crimes['DATA_OCORRENCIA_BO'] <= pd.to_datetime(config.DATA_END)]
    if df_crimes.empty:
        print(f"   [ERRO] Nenhum crime no período {config.DATE_START_DATA} a {getattr(config, 'DATA_END', None) or 'fim'} nesta área.")
        return

    print(f"   Crimes Totais (CSV): {int(df_crimes['qtd_crimes'].sum())}")
    
    all_grid_ids = gdf_grid['GRID_ID'].unique()
    
    # 2. Pivotagem Segura (MultiIndex + Resample)
    # Define Data como índice para usar resample
    df_crimes.set_index('DATA_OCORRENCIA_BO', inplace=True)
    
    print("   Realizando Pivot e Resample (pode demorar)...")
    events.progress('features', _AREA_POS[0], _AREA_POS[1], area=area_name, etapa='matriz')
    # Agrupa por Grid e faz Resample Semanal
    # Isso preenche buracos de tempo automaticamente com 0
    pivot = df_crimes.groupby('GRID_ID')['qtd_crimes'].resample('W-MON').sum().unstack(level=0).fillna(0)
    
    # Garante que todos os Grids existam
    pivot = pivot.reindex(columns=all_grid_ids, fill_value=0).astype(np.float32)
    
    print(f"   Matriz Base: {pivot.shape} (Semanas x Grids)")
    print(f"   Crimes no Pivot: {int(pivot.sum().sum())}")
    
    if pivot.sum().sum() == 0:
        print("   [ERRO FATAL] Pivot zerado. Verifique os IDs.")
        return

    # 3. Engenharia de Features (Lags do Passado)
    # Lista de DataFrames para juntar pelo índice (Data)
    dfs_to_join = []
    
    # Lags (O passado que explica o futuro)
    for i in range(1, config.LAG_WEEKS + 1):
        # Shift positivo move os dados para frente (o dado de t-1 fica na linha t)
        lag_pivot = pivot.shift(i)
        
        # Melt e Indexação Robusta
        lag_df = lag_pivot.melt(var_name='GRID_ID', value_name=f'lag_{i}', ignore_index=False)
        lag_df.index.name = 'data'
        lag_df = lag_df.reset_index().set_index(['data', 'GRID_ID'])
        
        lag_df[f'lag_{i}'] = lag_df[f'lag_{i}'].astype(np.float32)
        dfs_to_join.append(lag_df)
        
        del lag_pivot
        gc.collect()

    # --- FEATURES AGREGADAS (janela de config.FORECAST_HORIZON semanas) ---
    # Calculadas sobre o pivot ORIGINAL (sem shift ainda) para capturar
    # padrões que lags individuais não conseguem:
    #   lag_mean_4w   → Atividade criminal média recente
    #   lag_max_4w    → Pico de intensidade (hotspots episódicos)
    #   lag_std_4w    → Volatilidade (crime irregular vs estável)
    #   lag_trend_4w  → Tendência (crime crescendo ou caindo?)
    window = config.FORECAST_HORIZON  # 4 semanas por padrão

    def _make_feature_df(series_pivot, col_name):
        """Helper: pivô → melt → MultiIndex. Mesmo padrão dos lags."""
        df = series_pivot.melt(var_name='GRID_ID', value_name=col_name, ignore_index=False)
        df.index.name = 'data'
        df = df.reset_index().set_index(['data', 'GRID_ID'])
        df[col_name] = df[col_name].astype(np.float32)
        return df

    # Shift(1): a janela termina em t-1 (sem incluir o passo atual → sem leakage)
    rolling = pivot.shift(1).rolling(window=window, min_periods=1)

    # 1. Média das últimas 4 semanas
    mean_df = _make_feature_df(rolling.mean(), 'lag_mean_4w')
    dfs_to_join.append(mean_df)

    # 2. Máximo das últimas 4 semanas
    max_df = _make_feature_df(rolling.max(), 'lag_max_4w')
    dfs_to_join.append(max_df)

    # 3. Desvio padrão (volatilidade) das últimas 4 semanas
    std_df = _make_feature_df(rolling.std().fillna(0), 'lag_std_4w')
    dfs_to_join.append(std_df)

    # 4. Tendência: diferença entre a média das últimas 2 semanas e as 2 anteriores
    #    Positivo = crime aumentando; Negativo = crime caindo
    half = max(window // 2, 1)
    recent   = pivot.shift(1).rolling(window=half, min_periods=1).mean()
    previous = pivot.shift(1 + half).rolling(window=half, min_periods=1).mean()
    trend_df = _make_feature_df((recent - previous).fillna(0), 'lag_trend_4w')
    dfs_to_join.append(trend_df)

    del mean_df, max_df, std_df, trend_df, rolling, recent, previous
    gc.collect()

    print(f"   Features geradas: {config.LAG_WEEKS} lags + 4 agregadas (mean, max, std, trend)")

    # --- FEATURES ESPACIAIS (Crimes nos Grids Vizinhos) ---
    # Controlado por config.ENABLE_SPATIAL_FEATURES
    # Captura o deslocamento espacial de crimes:
    #   neigh_crime_sum → Soma de crimes nos grids adjacentes (t-1)
    #   neigh_crime_max → Pico de crime entre os vizinhos (t-1)
    if config.ENABLE_SPATIAL_FEATURES:
        print("   Calculando features espaciais (adjacência Queen)...")
        try:
            # 1. Monta adjacência: sjoin de cada grid com os grids que ele TOCA
            #    'touches' = compartilha borda ou canto, mas não o interior (Queen 8 vizinhos)
            gdf_a = gdf_grid[['GRID_ID', 'geometry']].rename(columns={'GRID_ID': 'id_a'})
            gdf_b = gdf_grid[['GRID_ID', 'geometry']].rename(columns={'GRID_ID': 'id_b'})
            adj = gpd.sjoin(gdf_a, gdf_b, how='left', predicate='touches')

            # Dicionário: {grid_id: [ids dos vizinhos]}
            adjacency = adj.groupby('id_a')['id_b'].apply(list).to_dict()
            del gdf_a, gdf_b, adj
            gc.collect()

            n_com_viz = sum(1 for v in adjacency.values() if len(v) > 0)
            print(f"   Adjacência calculada: {n_com_viz}/{len(all_grid_ids)} grids com vizinhos.")

            # 2. Computa soma e máximo de crimes nos vizinhos, para cada semana
            neigh_sum_cols = {}
            neigh_max_cols = {}

            for grid_id in all_grid_ids:
                vizinhos = [n for n in adjacency.get(grid_id, []) if n in pivot.columns]
                if vizinhos:
                    neigh_sum_cols[grid_id] = pivot[vizinhos].sum(axis=1)
                    neigh_max_cols[grid_id] = pivot[vizinhos].max(axis=1)
                else:
                    zeros = pd.Series(0.0, index=pivot.index)
                    neigh_sum_cols[grid_id] = zeros
                    neigh_max_cols[grid_id] = zeros

            neigh_sum_pivot = pd.DataFrame(neigh_sum_cols).reindex(columns=all_grid_ids, fill_value=0)
            neigh_max_pivot = pd.DataFrame(neigh_max_cols).reindex(columns=all_grid_ids, fill_value=0)

            # Shift(1) → sem leakage (usa o estado dos vizinhos em t-1)
            neigh_sum_df = _make_feature_df(neigh_sum_pivot.shift(1).fillna(0), 'neigh_crime_sum')
            neigh_max_df = _make_feature_df(neigh_max_pivot.shift(1).fillna(0), 'neigh_crime_max')

            dfs_to_join.append(neigh_sum_df)
            dfs_to_join.append(neigh_max_df)

            del neigh_sum_cols, neigh_max_cols, neigh_sum_pivot, neigh_max_pivot
            del neigh_sum_df, neigh_max_df, adjacency
            gc.collect()

            print("   Features espaciais adicionadas: neigh_crime_sum, neigh_crime_max")

        except Exception as e:
            print(f"   [AVISO] Features espaciais falharam ({e}). Continuando sem elas.")

    # 4. Engenharia do Target (Futuro Acumulado t+4)
    # O Target na data 't' deve ser a soma das próximas 4 semanas
    # Usamos rolling reverso (FixedForwardWindowIndexer)
    indexer = pd.api.indexers.FixedForwardWindowIndexer(window_size=config.FORECAST_HORIZON)
    
    # .shift(-1) é crucial: O target da semana T é o que acontece DEPOIS dela.
    target_pivot = pivot.rolling(window=indexer).sum().shift(-1)
    
    target_df = target_pivot.melt(var_name='GRID_ID', value_name='target_month', ignore_index=False)
    target_df.index.name = 'data'
    target_df = target_df.reset_index().set_index(['data', 'GRID_ID'])
    target_df['target_month'] = target_df['target_month'].astype(np.float32)
    
    # Adiciona o target como o primeiro item da lista
    dfs_to_join.insert(0, target_df)

    print("   Consolidando DataFrame (Join pelo MultiIndex)...")
    events.progress('features', _AREA_POS[0], _AREA_POS[1], area=area_name, etapa='juntando')
    # Concatena alinhando pelo índice (Data, Grid). ISSO É SEGURO.
    df_final = pd.concat(dfs_to_join, axis=1)
    
    # Limpeza
    del dfs_to_join, pivot, target_df
    gc.collect()
    
    # Remove NaNs (início e fim da série temporal que ficaram sem lags/target)
    if getattr(config, 'DATA_END', None):
        # Mantém as linhas recentes (alvo ainda desconhecido) para a previsão;
        # o treino as exclui pelo embargo em loader.load_train_dataset.
        feat_cols_drop = [c for c in df_final.columns if c != 'target_month']
        df_final = df_final.dropna(subset=feat_cols_drop)
    else:
        df_final = df_final.dropna()
    
    # Volta o índice para colunas normais
    df_final = df_final.reset_index()
    
    # Validação
    total_targets = df_final['target_month'].sum()
    print(f"   Crimes Futuros no Dataset Final: {int(total_targets)}")
    
    if total_targets == 0:
        print("   [ERRO] Zero targets após processamento. Verifique se o Target Futuro não comeu todo o histórico.")
        return

    # 5. Salvar FULL (Sem divisão de treino/teste aqui)
    # O Validation Framework fará a divisão temporal correta.
    out_full = os.path.join(config.DIR_DATASETS, f"dataset_full_{area_name}.csv")
    events.progress('features', _AREA_POS[0], _AREA_POS[1], area=area_name, etapa='gravando')
    df_final.to_csv(out_full, index=False)
    events.metric('features', 'linhas', int(len(df_final)), area=area_name)
    events.metric('features', 'celulas', int(df_final['GRID_ID'].nunique()), area=area_name)
    events.metric('features', 'semanas', int(df_final['data'].nunique()), area=area_name)
    events.metric('features', 'crimes_futuros', int(total_targets), area=area_name)
    events.metric('features', 'primeira_semana', str(pd.to_datetime(df_final['data']).min().date()), area=area_name)
    events.metric('features', 'ultima_semana', str(pd.to_datetime(df_final['data']).max().date()), area=area_name)
    
    print(f"   -> Dataset Completo Salvo: {out_full}")
    print(f"   -> Linhas: {len(df_final)}")
    
    del df_final
    gc.collect()

def run_step2(target_area=None):
    print("=== PASSO 2: GERAÇÃO DE MATRIZES (MULTI-INDEX + T+4) ===")
    
    pattern = os.path.join(config.DIR_GRIDS, "*.geojson")
    grid_files = glob.glob(pattern)
    available_areas = [os.path.splitext(os.path.basename(f))[0] for f in grid_files]
    
    if not available_areas:
        print(f"[ERRO] Nenhuma área encontrada.")
        return

    # Filtro
    if target_area:
        if target_area in available_areas:
            print(f"   [FILTRO] Gerando matriz apenas para: {target_area}")
            _AREA_POS[:] = [0, 1]
            events.progress('features', 0, 1, area=target_area, etapa='lendo')
            generate_matrix_for_area(target_area)
        else:
            print(f"   [AVISO] Área {target_area} não encontrada.")
    else:
        print(f"Processando {len(available_areas)} áreas...")
        areas = sorted(available_areas)
        for i, area in enumerate(areas):
            _AREA_POS[:] = [i, len(areas)]
            events.progress('features', i, len(areas), area=area, etapa='lendo')
            generate_matrix_for_area(area)
            gc.collect()
            
    print("\n=== FIM DO PASSO 2 ===")

if __name__ == "__main__":
    run_step2()