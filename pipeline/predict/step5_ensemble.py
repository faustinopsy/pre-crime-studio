"""
Arquivo: src/step4_ensemble.py
Descrição: Gera Ensemble Híbrido (Média + Max) para maximizar a captura de crimes.
CORREÇÕES: 
1. Lógica de "Sensitivity Boost": Usa (Mean + Max)/2 para evitar diluição do sinal.
2. Loop Temporal Completo (todas as semanas).
3. Preservação rigorosa do Target Real.
"""
import pandas as pd
import geopandas as gpd
import os
import glob
from pipeline import config
from pipeline.predict import corte
from sklearn.preprocessing import MinMaxScaler
import numpy as np

def _aviso_poi(area_name, motivo):
    print(f"   [AVISO] Ajuste por pontos de interesse desligado em {area_name}: {motivo}")
    try:
        from pipeline.bridge import events
        events.metric('ensemble', 'poi_desligado', motivo, area=area_name)
    except Exception:
        pass


def pesos_poi(join, poi_weights):
    """Peso de cada linha (célula × POI) pelos tipos configurados.

    Chaves: '_padrao' (tipos não listados; 1.0 na dissertação), 'shop:<tipo>' (lojas, campo
    shop), 'amenity:<tipo>' e o nome simples ('bar', 'police'…), que vale como amenity.
    Ordem: padrão → shop → amenity (nome simples) → 'amenity:'; o último que casar vale.
    Conjuntos novos (pipeline/pois/conjuntos.py) trazem a coluna 'categoria': o peso é o da chave igual
    à categoria ('amenity:bar', 'arquivo:delegacia'…; o nome simples 'bar' vale como 'amenity:bar').
    '(sem categoria)' pesa os pontos sem amenity nem shop (ou com a categoria vazia).
    """
    peso = pd.Series(float(poi_weights.get('_padrao', 1.0)), index=join.index)
    if 'categoria' in join.columns:
        cat = join['categoria'].astype(str)
        chave = lambda k: k if (':' in k or k.startswith('(')) else f'amenity:{k}'  # noqa: E731
        simples = {chave(k): w for k, w in poi_weights.items() if isinstance(k, str) and not k.startswith('_') and ':' not in k}
        explicitos = {k: w for k, w in poi_weights.items() if isinstance(k, str) and (':' in k or k.startswith('('))}
        for k, w in {**simples, **explicitos}.items():
            peso[cat == k] = w
        return peso
    sem = poi_weights.get('(sem categoria)')
    if sem is not None:
        vazio = pd.Series(True, index=join.index)
        for c in ('amenity', 'shop'):
            if c in join.columns:
                vazio &= join[c].isna()
        peso[vazio] = sem
    if 'shop' in join.columns:
        for k, w in poi_weights.items():
            if isinstance(k, str) and k.startswith('shop:'):
                peso[join['shop'] == k[5:]] = w
    if 'amenity' in join.columns:
        for k, w in poi_weights.items():
            if isinstance(k, str) and not k.startswith(('shop:', 'amenity:', '_')):
                peso[join['amenity'] == k] = w
        for k, w in poi_weights.items():
            if isinstance(k, str) and k.startswith('amenity:'):
                peso[join['amenity'] == k[8:]] = w
    return peso


def calculate_poi_score(gdf_grid, area_name, data_ref=None):
    """
    Escore de POI de cada célula (0 a 1), com os pesos de config.ENSEMBLE_CONFIG['POI_WEIGHTS'].
    Normalização (POI_NORMALIZACAO): 'com_poi' (dissertação) faz o MinMax só entre as células que
    têm POI (as outras ficam 0); 'todas' inclui as células sem POI (soma 0) no MinMax.
    Se o arquivo de POI faltar ou der erro, o escore fica 0 e o app recebe o aviso 'poi_desligado'.
    """
    cfg = config.ENSEMBLE_CONFIG
    zeros = pd.Series(0.0, index=gdf_grid['GRID_ID'])
    if not cfg.get('POI_BOOST_FACTOR'):
        return zeros
    try:
        from pipeline.pois import conjuntos
        path_pois = conjuntos.caminho_pois(config, area_name)

        if not os.path.exists(path_pois):
            _aviso_poi(area_name, f'sem o arquivo pois_{area_name}.geojson'
                       + (f' no conjunto {os.path.basename(config.POI_SET_DIR)}' if getattr(config, 'POI_SET_DIR', None) else ''))
            return zeros

        # a junção célula × ponto não depende dos pesos: guardada para as variantes do Ensemble
        chave = (path_pois, os.path.getmtime(path_pois), area_name, len(gdf_grid), str(data_ref)[:10])
        join = _JUNCOES.get(chave)
        if join is None:
            pois_gdf = gpd.read_file(path_pois)
            # pontos com data de abertura/fechamento: só os abertos na data de referência (DATA_END do passo)
            pois_gdf, fechados = conjuntos.filtrar_por_data(pois_gdf, data_ref)
            if fechados:
                print(f"   [POI] {fechados} ponto(s) fora do período (abertos depois de {str(data_ref)[:10]} ou já fechados)")
            if gdf_grid.crs != pois_gdf.crs:
                pois_gdf = pois_gdf.to_crs(gdf_grid.crs)
            join = gpd.sjoin(gdf_grid, pois_gdf, how="inner", predicate="intersects")
            if len(_JUNCOES) > 8:
                _JUNCOES.clear()
            _JUNCOES[chave] = join
        join = join.copy()
        join['peso'] = pesos_poi(join, cfg['POI_WEIGHTS'])

        scores = join.groupby('GRID_ID')['peso'].sum()
        if scores.empty:
            return zeros
        if cfg.get('POI_NORMALIZACAO', 'com_poi') == 'todas':
            ids = pd.Index(gdf_grid['GRID_ID']).unique()
            scores = scores.reindex(ids.union(scores.index)).fillna(0.0)

        scaler = MinMaxScaler()
        return pd.Series(scaler.fit_transform(scores.values.reshape(-1, 1)).flatten(), index=scores.index)
    except Exception as e:  # noqa: BLE001 — o Ensemble continua, sem o ajuste
        _aviso_poi(area_name, f'erro ao ler os pontos de interesse ({type(e).__name__}: {e})'[:300])
        return zeros


# Os arquivos dos modelos são lidos uma vez por área (antes: uma vez por semana).
_LEITURAS = {}
_JUNCOES = {}
_CACHE = {}


def _ler_membro(p_file):
    chave = (p_file, os.path.getmtime(p_file))
    if chave not in _LEITURAS:
        df = pd.read_csv(p_file)
        if 'data' in df.columns:
            df['data'] = pd.to_datetime(df['data'])
        _LEITURAS[chave] = df
    return _LEITURAS[chave]


def process_week_ensemble(gdf_grid, valid_grids_mask, area_name, target_date, weights, poi_scores, tag=None, results_dir=None):
    dfs = {}
    valid_models = []
    truth_df = None

    tag_suffix = f"_{tag}" if tag else ""
    results_dir = results_dir or config.DIR_RESULTS

    # 1. Carrega Modelos para a data específica (peso 0 = o modelo não entra)
    for model in weights.keys():
        if not weights[model]:
            continue
        p_file = os.path.join(results_dir, f"results_{model.lower()}_{area_name}{tag_suffix}.csv")
        if os.path.exists(p_file):
            try:
                df_temp = _ler_membro(p_file)
                if 'data' in df_temp.columns:
                    df_temp = df_temp[
                        (df_temp['data'] >= target_date) & 
                        (df_temp['data'] < target_date + pd.Timedelta(days=7))
                    ].copy()
                
                if not df_temp.empty:
                    if truth_df is None and 'target_month' in df_temp.columns:
                        truth_df = df_temp[['GRID_ID', 'target_month']].groupby('GRID_ID').max().reset_index()

                    df_temp = df_temp.groupby('GRID_ID', as_index=False)['probabilidade_risco'].mean()
                    dfs[model] = df_temp
                    valid_models.append(model)
            except: pass

    if not valid_models: return None

    # 2. Prepara Base
    base_df = pd.DataFrame({'GRID_ID': gdf_grid['GRID_ID']})
    
    # Matriz para guardar as probabilidades individuais (para calcular o MAX)
    prob_matrix = pd.DataFrame(index=base_df.index)
    
    # 3. Média Ponderada
    weighted_sum = np.zeros(len(base_df))
    current_weights = {m: weights[m] for m in valid_models}
    total_weight = sum(current_weights.values())
    if total_weight == 0: total_weight = 1

    postos = config.ENSEMBLE_CONFIG.get('COMBINACAO', 'probabilidades') == 'postos'
    for model in valid_models:
        w = current_weights[model] / total_weight
        merged = base_df.merge(dfs[model], on='GRID_ID', how='left')
        probs = merged['probabilidade_risco'].fillna(0).values
        if postos:
            # posto (percentil) da célula entre as células da área, de 0 a 1
            probs = pd.Series(probs).rank(pct=True, method='average').values
        
        # Guarda para cálculo do Max
        prob_matrix[model] = probs
        # Soma para cálculo da Média
        weighted_sum += probs * w

    # --- ENSEMBLE HÍBRIDO (USA CONFIG!) ---
    # Usa configuração centralizada do config.py
    ensemble_cfg = config.ENSEMBLE_CONFIG
    
    mean_probs = weighted_sum
    max_probs = prob_matrix.max(axis=1).values
    
    # Fórmula híbrida configurável
    mean_weight = ensemble_cfg['HYBRID_FORMULA']['MEAN_WEIGHT']
    max_weight = ensemble_cfg['HYBRID_FORMULA']['MAX_WEIGHT']
    
    base_df['probabilidade_risco'] = (mean_probs * mean_weight) + (max_probs * max_weight)

    # 4. Regras de Negócio (POI boost configurável)
    poi_factor = base_df['GRID_ID'].map(poi_scores).fillna(0)
    poi_boost = ensemble_cfg['POI_BOOST_FACTOR']
    
    base_df['probabilidade_risco'] *= (1 + (poi_boost * poi_factor))
    
    mask_inativos = ~base_df['GRID_ID'].isin(valid_grids_mask)
    if mask_inativos.sum() > 0:
        base_df.loc[mask_inativos, 'probabilidade_risco'] = 0.0

    base_df['probabilidade_risco'] = base_df['probabilidade_risco'].clip(0, 1)
    
    # 5. Alto risco (top 10% na dissertação: COBERTURA e CORTE em config)
    base_df['predicao_top10'] = 0
    if base_df['probabilidade_risco'].sum() > 0:
        pos = base_df['probabilidade_risco'] > 0
        if corte.exato():
            sel = corte.top_exato(base_df.loc[pos, 'probabilidade_risco'], corte.frac_alto())
            base_df.loc[sel[sel].index, 'predicao_top10'] = 1
        else:
            limit = base_df[pos]['probabilidade_risco'].quantile(config.HOTSPOT_QUANTILE)
            base_df.loc[base_df['probabilidade_risco'] >= limit, 'predicao_top10'] = 1

    # 6. Finalização
    base_df['data'] = target_date
    if truth_df is not None:
        base_df = base_df.merge(truth_df, on='GRID_ID', how='left')
        base_df['target_month'] = base_df['target_month'].fillna(0).astype(int)
    else:
        base_df['target_month'] = 0
        
    return base_df

def process_ensemble_area(area_name, forecast_date=None, tag=None, results_dir=None, sufixo='', out_dir=None):
    """Ensemble da área no mês. results_dir: onde estão os resultados dos membros (padrão:
    processed/results). sufixo: variante (ex.: '-sempoi' grava results_ensemble-sempoi_...);
    out_dir: onde gravar (padrão: results_dir). Devolve o caminho gravado (ou None)."""
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = tag or config.get_forecast_tag(forecast_date)
    results_dir = results_dir or config.DIR_RESULTS
    out_dir = out_dir or results_dir
    if _LEITURAS and not any(area_name in k[0] for k in _LEITURAS):
        _LEITURAS.clear()   # outra área: libera a memória (a chave inclui a data do arquivo)
    if len(_CACHE) > 6:
        _CACHE.clear()
    print(f"--- Processando Ensemble{sufixo and f' ({sufixo[1:]})'} (Sensitivity Boost): {area_name} | tag={tag} ---")

    p_grid = os.path.join(config.DIR_GRIDS, f"{area_name}.geojson")
    if not os.path.exists(p_grid): return
    # malha e histórico lidos uma vez por arquivo (as variantes do Ensemble recalculam a mesma área várias vezes)
    ck = ('grid', p_grid, os.path.getmtime(p_grid))
    if ck not in _CACHE:
        g = gpd.read_file(p_grid)
        if 'GRID_ID' in g.columns: g['GRID_ID'] = g['GRID_ID'].astype(int)
        _CACHE[ck] = g
    gdf_grid = _CACHE[ck].copy()

    p_dataset_full = os.path.join(config.DIR_DATASETS, f"dataset_full_{area_name}.csv")
    valid_grids_mask = set(gdf_grid['GRID_ID'])
    if os.path.exists(p_dataset_full):
        try:
            ck = ('hist', p_dataset_full, os.path.getmtime(p_dataset_full))
            if ck not in _CACHE:
                df_full = pd.read_csv(p_dataset_full, usecols=['GRID_ID', 'target_month'])
                _CACHE[ck] = df_full.groupby('GRID_ID')['target_month'].sum()
            hist_sum = _CACHE[ck]

            # células com até MIN_HISTORICAL_CRIMES crimes no histórico são zeradas (None = sem filtro)
            min_crimes = config.ENSEMBLE_CONFIG['MIN_HISTORICAL_CRIMES']
            if min_crimes is not None:
                valid_grids_mask = set(hist_sum[hist_sum > min_crimes].index.astype(int))
        except: pass

    # Pesos vêm do config agora!
    weights = config.ENSEMBLE_CONFIG['MODEL_WEIGHTS']
    # data de referência dos pontos de interesse com abertura/fechamento: o que se sabia na previsão
    data_ref = getattr(config, 'DATA_END', None) or (pd.to_datetime(forecast_date) - pd.Timedelta(days=1))
    poi_scores = calculate_poi_score(gdf_grid, area_name, data_ref=data_ref)

    start_date = pd.to_datetime(forecast_date)
    # Alinha à primeira segunda-feira >= início do mês (semanas W-MON do dataset)
    start_date = start_date + pd.Timedelta(days=(7 - start_date.weekday()) % 7)
    weeks_to_process = config.FORECAST_HORIZON

    all_weeks_results = []

    for i in range(weeks_to_process):
        current_date = start_date + pd.Timedelta(weeks=i)
        df_week = process_week_ensemble(gdf_grid, valid_grids_mask, area_name, current_date, weights, poi_scores, tag=tag, results_dir=results_dir)
        if df_week is not None:
            all_weeks_results.append(df_week)
            
    if all_weeks_results:
        final_df = pd.concat(all_weeks_results, ignore_index=True)

        # --- FILTRO DE CONSISTÊNCIA TEMPORAL ---
        # Configurado em config.ENSEMBLE_CONFIG['TEMPORAL_SMOOTHING']
        # Suaviza spikes isolados: um grid com alto risco apenas em 1 semana
        # não deve dominar a predição final
        smoothing_cfg = config.ENSEMBLE_CONFIG.get('TEMPORAL_SMOOTHING', {})
        if smoothing_cfg.get('ENABLED', False) and len(all_weeks_results) > 1:
            try:
                window = smoothing_cfg.get('WINDOW', 2)
                alpha  = smoothing_cfg.get('ALPHA', 0.7)

                # Pivota: linhas = semanas, colunas = GRID_ID
                pivot_prob = final_df.pivot_table(
                    index='data', columns='GRID_ID',
                    values='probabilidade_risco', aggfunc='mean'
                ).sort_index()

                if smoothing_cfg.get('EIXO', 'grids') == 'semanas':
                    # média móvel entre semanas consecutivas de cada célula
                    smoothed = pivot_prob.rolling(window=window, min_periods=1, center=False).mean()
                else:
                    # Dissertação: a média móvel corre nas linhas de pivot_prob.T, que são os
                    # GRID_IDs (cada célula com a vizinha na numeração), não as semanas.
                    smoothed = pivot_prob.T.rolling(
                        window=window, min_periods=1, center=False
                    ).mean().T

                # Blend: alpha x suavizado + (1-alpha) x bruto
                blended = (alpha * smoothed) + ((1 - alpha) * pivot_prob)

                # Reconstrói a coluna no DataFrame long
                blended_long = blended.stack().reset_index()
                blended_long.columns = ['data', 'GRID_ID', 'prob_smooth']
                blended_long['data'] = pd.to_datetime(blended_long['data'])

                final_df = final_df.merge(blended_long, on=['data', 'GRID_ID'], how='left')
                final_df['probabilidade_risco'] = final_df['prob_smooth'].fillna(
                    final_df['probabilidade_risco']
                ).clip(0, 1)
                final_df.drop(columns=['prob_smooth'], inplace=True)

                print(f"   [SMOOTHING] Aplicado: janela={window}, alpha={alpha}")
            except Exception as e:
                print(f"   [AVISO] Filtro temporal falhou ({e}). Usando probabilidades brutas.")

        if corte.exato() or not corte.cobertura_padrao():
            final_df['predicao_alto'] = final_df['predicao_top10']
        out_ens = os.path.join(out_dir, f"results_ensemble{sufixo}_{area_name}_{tag}.csv")
        final_df.to_csv(out_ens, index=False)
        print(f"   -> Ensemble Salvo: {len(final_df)} linhas | Crimes Reais: {final_df['target_month'].sum()} | tag={tag}")
        return out_ens
    return None


def run_step4_ensemble(target_area=None, forecast_date=None):
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = config.get_forecast_tag(forecast_date)
    print(f"=== PASSO 4: ENSEMBLE (SENSITIVITY BOOST) | tag={tag} ===")
    pattern = os.path.join(config.DIR_GRIDS, "*.geojson")
    all_areas = [os.path.basename(f).replace(".geojson", "") for f in glob.glob(pattern)]

    if target_area:
        if target_area in all_areas:
            process_ensemble_area(target_area, forecast_date=forecast_date, tag=tag)
    else:
        for area in sorted(all_areas):
            process_ensemble_area(area, forecast_date=forecast_date, tag=tag)

if __name__ == "__main__":
    run_step4_ensemble()