"""
Arquivo: src/step1_etl.py
Descrição: ETL Otimizado - Carrega dados globais uma vez e distribui por área.
Evita picos de memória e recarrega desnecessária.
"""
import pandas as pd
import geopandas as gpd
import os
import gc
from pipeline import config
from pipeline.bridge import events

def carregar_crimes_globais():
    print("   [ETL] Carregando base global de crimes (pode demorar)...")
    try:
        cols = ['DATA_OCORRENCIA_BO', 'LATITUDE', 'LONGITUDE']
        # Tenta carregar otimizado
        df = pd.read_csv(config.FILES['csv'], encoding='utf-8-sig', usecols=cols)
    except:
        df = pd.read_csv(config.FILES['csv'], encoding='latin1', usecols=cols)

    df['DATA_OCORRENCIA_BO'] = pd.to_datetime(df['DATA_OCORRENCIA_BO'], errors='coerce')
    
    # Filtro Temporal Global (Remove histórico antigo inútil agora)
    start_date = pd.to_datetime(config.DATE_START_DATA)
    df = df[df['DATA_OCORRENCIA_BO'] >= start_date]

    # Replay sem vazamento: descarta o que ainda não era conhecido em DATA_END
    if getattr(config, 'DATA_END', None):
        end_date = pd.to_datetime(config.DATA_END)
        antes = len(df)
        df = df[df['DATA_OCORRENCIA_BO'] <= end_date]
        print(f"   [DATA_END] Ocorrências até {config.DATA_END}: {len(df)} (removidas {antes - len(df)})")
    
    # Limpeza de Coordenadas
    df = df.dropna(subset=['LATITUDE', 'LONGITUDE'])
    
    if df['LATITUDE'].dtype == object:
        df['LATITUDE'] = df['LATITUDE'].astype(str).str.replace(',', '.').astype(float)
        df['LONGITUDE'] = df['LONGITUDE'].astype(str).str.replace(',', '.').astype(float)
        
    print(f"   [ETL] Base carregada na memória: {len(df)} registros válidos.")
    return df

def process_single_area(path_grid_raw, df_crimes_global):
    filename = os.path.basename(path_grid_raw)
    area_name = os.path.splitext(filename)[0]
    print(f"\n--- Processando: {area_name} ---")

    # 1. Carregar Grid
    if not os.path.exists(path_grid_raw): return
    try:
        gdf_grid = gpd.read_file(path_grid_raw)
    except: return
    
    # Garante CRS
    if gdf_grid.crs is None: gdf_grid.set_crs(config.CRS_LATLON, inplace=True)
    
    # Converte para métrico para ter precisão, mas mantemos o ID
    gdf_grid_metric = gdf_grid.to_crs(config.CRS_METRIC)
    gdf_grid_metric['GRID_ID'] = gdf_grid_metric.index.astype(int)

    # 2. Pré-filtro Rápido (Bounding Box)
    # Corta o DataFrame global usando apenas Lat/Lon numéricos (muito rápido)
    bounds = gdf_grid.to_crs(config.CRS_LATLON).total_bounds # xmin, ymin, xmax, ymax
    margin = 0.005
    
    df_bbox = df_crimes_global[
        (df_crimes_global['LONGITUDE'] >= bounds[0] - margin) & 
        (df_crimes_global['LONGITUDE'] <= bounds[2] + margin) &
        (df_crimes_global['LATITUDE'] >= bounds[1] - margin) & 
        (df_crimes_global['LATITUDE'] <= bounds[3] + margin)
    ].copy()
    
    if df_bbox.empty:
        print("   [AVISO] Zero crimes no Bounding Box desta área.")
        return

    # 3. Spatial Join (Rigoroso)
    # Só agora convertemos para GeoDataFrame (apenas o pedaço pequeno)
    gdf_crimes = gpd.GeoDataFrame(
        df_bbox, 
        geometry=gpd.points_from_xy(df_bbox.LONGITUDE, df_bbox.LATITUDE), 
        crs=config.CRS_LATLON
    ).to_crs(config.CRS_METRIC)

    # Join espacial exato com os polígonos
    join = gpd.sjoin(gdf_crimes, gdf_grid_metric[['geometry', 'GRID_ID']], how="inner", predicate="intersects")
    
    # 4. Agregação e Salvamento
    df_agg = join.groupby(['DATA_OCORRENCIA_BO', 'GRID_ID']).size().reset_index(name='qtd_crimes')
    
    # Salva Grid Padronizado
    out_grid = os.path.join(config.DIR_GRIDS, f"{area_name}.geojson")
    gdf_grid_metric.to_crs(config.CRS_LATLON).to_file(out_grid, driver='GeoJSON')
    
    # Salva CSV de Crimes da Área
    out_csv = os.path.join(config.DIR_CRIMES, f"crimes_{area_name}.csv")
    df_agg.to_csv(out_csv, index=False)
    
    print(f"   -> Crimes Mapeados: {df_agg['qtd_crimes'].sum()} (em {len(gdf_grid)} grids)")
    events.metric('filter', 'crimes_mapeados', int(df_agg['qtd_crimes'].sum()), area=area_name)
    events.metric('filter', 'grids_com_crime', int(df_agg['GRID_ID'].nunique()), area=area_name)
    events.metric('filter', 'registros_na_area', int(join.index.nunique()), area=area_name)
    
    # Limpeza explícita de memória
    del gdf_crimes, join, df_bbox
    gc.collect()

def run_step1(target_area=None):
    print("=== PASSO 1: ETL OTIMIZADO (CARGA ÚNICA) ===")
    
    for d in [config.DIR_GRIDS, config.DIR_CRIMES, config.DIR_DATASETS]:
        os.makedirs(d, exist_ok=True)
    
    if not config.INPUT_GRIDS:
        print("[ERRO] INPUT_GRIDS vazio.")
        return

    # Filtro de Área
    if target_area:
        # Filtra a lista de grids de entrada
        filtered_grids = [p for p in config.INPUT_GRIDS if target_area in os.path.basename(p)]
        if not filtered_grids:
            print(f"   [AVISO] Grid para '{target_area}' não encontrado em INPUT_GRIDS.")
            return
        grids_to_process = filtered_grids
        print(f"   [FILTRO] Processando apenas: {target_area}")
    else:
        grids_to_process = config.INPUT_GRIDS

    # Carrega dados UMA VEZ (Só se tiver grid para processar)
    if grids_to_process:
        events.progress('filter', 0, len(grids_to_process), etapa='carregando')
        df_global = carregar_crimes_globais()
        events.metric('filter', 'crimes_base', int(len(df_global)))
        for i, path in enumerate(grids_to_process):
            events.progress('filter', i, len(grids_to_process), area=os.path.splitext(os.path.basename(path))[0], etapa='crimes')
            process_single_area(path, df_global)
        del df_global
        gc.collect()
        
    print("\n=== FIM DO PASSO 1 ===")

if __name__ == "__main__":
    run_step1()