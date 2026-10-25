"""
Arquivo: src/step6_export_geojson.py
Descrição: Gera APENAS os arquivos GeoJSON (Previsões e Gabarito) para visualização.
ATUALIZAÇÃO: 
1. Suporte a target_area.
2. Visualização corrigida (Baixo = Transparente).
3. Todas funções originais preservadas.
"""

import pandas as pd
import geopandas as gpd
import os
import glob
from pipeline import config
from pipeline.predict import corte
from shapely.geometry import Point

# --- LÓGICA VISUAL (CORES E OPACIDADE) ---
def calcular_categoria_risco(val, q_med, q_high):
    """Define a cor base (Hex) e o rótulo."""
    # Proteção: Se o score for muito baixo, nunca é Alto Risco
    # Valor mínimo configurável em config.VISUALIZATION_CONFIG['SCORE_MIN_THRESHOLD']
    score_floor = config.VISUALIZATION_CONFIG['SCORE_MIN_THRESHOLD']
    if val < score_floor: return 'BAIXO', "transparent"

    if val >= q_high: return 'ALTO', "#ff0000"  # Vermelho
    if val >= q_med:  return 'MEDIO', "#ffff00"  # Amarelo
    return 'BAIXO', "transparent"

def calcular_opacidade_numerica(score, q_med, q_high, risco):
    """Define a opacidade baseada na intensidade dentro da categoria.
    
    Limites de opacidade configuráveis em:
        config.VISUALIZATION_CONFIG['OPACITY_MIN']  (padrão 0.30)
        config.VISUALIZATION_CONFIG['OPACITY_MAX']  (padrão 0.90)
    Guarda de divisão por zero:
        config.VISUALIZATION_CONFIG['ZERO_DIVISION_GUARD'] (padrão 0.0001)
    """
    risco = str(risco).strip().upper()
    if risco == 'BAIXO' or risco == 'TRANSPARENT': return 0.0

    viz = config.VISUALIZATION_CONFIG
    OP_MIN  = viz['OPACITY_MIN']
    OP_MAX  = viz['OPACITY_MAX']
    GUARD   = viz['ZERO_DIVISION_GUARD']
    RANGE   = OP_MAX - OP_MIN

    # Proteção contra divisão por zero se distribuição for achatada
    if risco == 'MEDIO':
        denom = (q_high - q_med)
        if denom <= GUARD: return OP_MIN
        ratio = (score - q_med) / denom
        val = OP_MIN + (ratio * RANGE)
        return round(max(OP_MIN, min(OP_MAX, val)), 2)

    elif risco == 'ALTO':
        denom = (1.0 - q_high)
        if denom <= GUARD: return OP_MAX
        ratio = (score - q_high) / denom
        val = OP_MIN + (ratio * RANGE)
        return round(max(OP_MIN, min(OP_MAX, val)), 2)

    return 0.0

def export_prediction_geojson(df, gdf_grid, model_name, area_name, tag=None, forecast_date=None):
    """Gera o GeoJSON com as manchas de calor (Hotspots)."""
    
    # Prepara datas para metadados
    # Período do mês previsto (antes usava config.FORECAST_DATE = próximo mês a partir de hoje)
    forecast_date = forecast_date or config.FORECAST_DATE
    start_date = pd.to_datetime(forecast_date)
    end_date = start_date + pd.DateOffset(weeks=config.FORECAST_HORIZON)
    end_date_str = end_date.strftime('%Y-%m-%d')
    start_date_str = start_date.strftime('%Y-%m-%d')
    
    # Agrega risco por Grid
    risk = df.groupby('GRID_ID')['probabilidade_risco'].mean().reset_index()
    risk.columns = ['GRID_ID','Score']
    
    # Garante tipos compatíveis para merge
    if 'GRID_ID' in gdf_grid.columns:
        gdf_grid['GRID_ID'] = gdf_grid['GRID_ID'].astype(int)
        risk['GRID_ID'] = risk['GRID_ID'].astype(int)
    
    # Merge com geometria
    gdf_out = gdf_grid.merge(risk, on='GRID_ID', how='left').fillna(0)

    # Define cortes de risco via config
    # Médio: config.VISUALIZATION_CONFIG['GEOJSON_MEDIUM_QUANTILE'] (padrão 0.50)
    # Alto:  config.HOTSPOT_QUANTILE (padrão 0.90)
    q_med  = gdf_out['Score'].quantile(config.VISUALIZATION_CONFIG['GEOJSON_MEDIUM_QUANTILE'])
    q_high = gdf_out['Score'].quantile(config.HOTSPOT_QUANTILE)
    if corte.exato():
        # top exato: as ceil(fração × células) de maior risco, por célula (GRID_ID)
        uni = gdf_out.drop_duplicates('GRID_ID').set_index('GRID_ID')['Score']
        alto = corte.top_exato(uni, corte.frac_alto())
        medio = corte.top_exato(uni, corte.frac_medio())
        if alto.any(): q_high = float(uni[alto].min())
        if medio.any(): q_med = float(uni[medio].min())

    # Proteção para distribuição achatada
    guard = config.VISUALIZATION_CONFIG['ZERO_DIVISION_GUARD']
    if q_high <= q_med: q_high = q_med + guard
    
    # 1. Define Categoria e Cor Base
    gdf_out[['Risco', 'fill']] = gdf_out['Score'].apply(
        lambda val: pd.Series(calcular_categoria_risco(val, q_med, q_high))
    )
    if corte.exato():
        floor = config.VISUALIZATION_CONFIG['SCORE_MIN_THRESHOLD']
        ids_alto, ids_medio = set(alto[alto].index), set(medio[medio].index)
        cat = gdf_out['GRID_ID'].map(lambda g: 'ALTO' if g in ids_alto else 'MEDIO' if g in ids_medio else 'BAIXO')
        cat[gdf_out['Score'] < floor] = 'BAIXO'
        gdf_out['Risco'] = cat
        gdf_out['fill'] = cat.map({'ALTO': '#ff0000', 'MEDIO': '#ffff00', 'BAIXO': 'transparent'})
    
    # 2. Define Opacidade Dinâmica
    gdf_out['fill-opacity'] = gdf_out.apply(
        lambda row: calcular_opacidade_numerica(row['Score'], q_med, q_high, row['Risco']), 
        axis=1
    )
    
    # Metadados finais
    gdf_out['marker-color'] = gdf_out['fill']
    gdf_out['Score'] = gdf_out['Score'].round(4)
    gdf_out['Modelo'] = model_name
    gdf_out['Area'] = area_name
    gdf_out['Periodo'] = f'{start_date_str} ate {end_date_str}'
    
    # Exporta
    tag = tag or config.FORECAST_TAG
    filename = f"hotspots_{model_name}_{area_name}_{tag}.geojson"
    out_path = os.path.join(config.DIR_RESULTS_GEOJSON, filename)
    
    cols = ['Modelo','GRID_ID', 'Area', 'Risco', 'Score', 'Periodo','fill', 'fill-opacity', 'geometry']
    # Filtra colunas para evitar erro de duplicidade
    valid_cols = [c for c in cols if c in gdf_out.columns]
    
    gdf_out[valid_cols].to_file(out_path, driver='GeoJSON')
    print(f"   -> [GEOJSON] Previsão {model_name}: {filename}")
    return out_path

# A base unificada é lida uma vez por processo (antes era relida para cada área).
_CRIMES_CACHE = {}


def _carregar_crimes():
    path = config.FILES['csv']
    try:
        chave = (path, os.path.getmtime(path))
    except OSError:
        return None
    if chave in _CRIMES_CACHE:
        return _CRIMES_CACHE[chave]
    try:
        cols = ['DATA_OCORRENCIA_BO', 'LATITUDE', 'LONGITUDE', 'HORA_OCORRENCIA', 'LOGRADOURO', 'DESCR_TIPO_VEICULO']
        # Tenta carregar colunas otimizadas
        try:
            df_crimes = pd.read_csv(path, usecols=cols, encoding='utf-8-sig')
        except Exception:
            df_crimes = pd.read_csv(path, usecols=cols, encoding='latin1')
    except Exception:
        return None
    df_crimes['DATA_OCORRENCIA_BO'] = pd.to_datetime(df_crimes['DATA_OCORRENCIA_BO'], errors='coerce')
    _CRIMES_CACHE.clear()
    _CRIMES_CACHE[chave] = df_crimes
    return df_crimes


def export_ground_truth_geojson(gdf_grid, area_name, forecast_date=None):
    """Gera o GeoJSON dos crimes reais (Pontos Pretos) para validação visual."""
    forecast_date = forecast_date or config.FORECAST_DATE
    start_date = pd.to_datetime(forecast_date)
    end_date = start_date + pd.DateOffset(weeks=config.FORECAST_HORIZON)
    
    df_crimes = _carregar_crimes()
    if df_crimes is None:
        return 0  # Falha silenciosa se não achar CSV
    
    # Filtro Temporal
    mask_time = (df_crimes['DATA_OCORRENCIA_BO'] >= start_date) & (df_crimes['DATA_OCORRENCIA_BO'] <= end_date)
    df_period = df_crimes[mask_time].copy()
    
    if df_period.empty: return 0

    # Filtro Espacial (BBox + Sjoin)
    if gdf_grid.crs != config.CRS_LATLON:
        gdf_grid = gdf_grid.to_crs(config.CRS_LATLON)
        
    xmin, ymin, xmax, ymax = gdf_grid.total_bounds
    
    df_period = df_period.dropna(subset=['LATITUDE', 'LONGITUDE'])
    if df_period['LATITUDE'].dtype == object:
        df_period['LATITUDE'] = df_period['LATITUDE'].astype(str).str.replace(',', '.').astype(float)
        df_period['LONGITUDE'] = df_period['LONGITUDE'].astype(str).str.replace(',', '.').astype(float)
    
    mask_bbox = (
        (df_period['LONGITUDE'] >= xmin) & (df_period['LONGITUDE'] <= xmax) &
        (df_period['LATITUDE'] >= ymin) & (df_period['LATITUDE'] <= ymax)
    )
    df_bbox = df_period[mask_bbox].copy()
    
    if df_bbox.empty: return 0

    geometry = [Point(xy) for xy in zip(df_bbox.LONGITUDE, df_bbox.LATITUDE)]
    gdf_crimes_bbox = gpd.GeoDataFrame(df_bbox, geometry=geometry, crs=config.CRS_LATLON)
    
    # Join Espacial Estrito (within)
    gdf_crimes_final = gpd.sjoin(gdf_crimes_bbox, gdf_grid[['geometry']], how='inner', predicate='within')
    
    if gdf_crimes_final.empty: return 0

    filename = f"crimes_reais_{area_name}_{forecast_date}.geojson"
    out_path = os.path.join(config.DIR_RESULTS_GEOJSON, filename)
    
    if 'index_right' in gdf_crimes_final.columns:
        gdf_crimes_final = gdf_crimes_final.drop(columns=['index_right'])
        
    gdf_crimes_final.to_file(out_path, driver='GeoJSON')
    print(f"   -> [GEOJSON] Crimes Reais (Gabarito): {filename} ({len(gdf_crimes_final)} eventos)")
    return len(gdf_crimes_final)

def process_area_export(area_name, forecast_date=None, tag=None, generate_predictions=True):
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = tag or config.get_forecast_tag(forecast_date)
    print(f"\n--- Exportando GeoJSONs: {area_name} | tag={tag} ---")
    p_grid = os.path.join(config.DIR_GRIDS, f"{area_name}.geojson")
    if not os.path.exists(p_grid): return {}
    saida = {}

    gdf_grid = gpd.read_file(p_grid)
    if 'GRID_ID' in gdf_grid.columns:
        gdf_grid['GRID_ID'] = gdf_grid['GRID_ID'].astype(int)

    # Exporta previsões para todos os modelos disponíveis (incluindo Ensemble)
    if generate_predictions:
        models = ['RF', 'LSTM', 'Transformer', 'Ensemble']
        for model in models:
            p_file = os.path.join(config.DIR_RESULTS, f"results_{model.lower()}_{area_name}_{tag}.csv")
            if os.path.exists(p_file):
                df = pd.read_csv(p_file)
                saida[model] = export_prediction_geojson(df, gdf_grid, model, area_name, tag=tag, forecast_date=forecast_date)

    # Exporta Gabarito apenas no modo validação (generate_predictions=False)
    if not generate_predictions:
        saida['gabarito'] = export_ground_truth_geojson(gdf_grid, area_name, forecast_date=forecast_date)
    return saida
    
def run_step6(target_area=None, forecast_date=None, generate_predictions=True):
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = config.get_forecast_tag(forecast_date)
    print(f"=== PASSO 6: EXPORTAÇÃO DE GEOJSONS (VISUALIZAÇÃO) | tag={tag} ===")
    os.makedirs(config.DIR_RESULTS_GEOJSON, exist_ok=True)

    pattern = os.path.join(config.DIR_GRIDS, "*.geojson")
    all_areas = [os.path.basename(f).replace(".geojson", "") for f in glob.glob(pattern)]

    # Filtro
    if target_area:
        if target_area in all_areas:
            final_areas = [target_area]
            print(f"   [FILTRO] Processando apenas: {target_area}")
        else:
            print(f"   [AVISO] Área alvo '{target_area}' não encontrada.")
            return
    else:
        final_areas = sorted(all_areas)

    for area in final_areas:
        process_area_export(area, forecast_date=forecast_date, tag=tag, generate_predictions=generate_predictions)

if __name__ == "__main__":
    run_step6()