"""
Arquivo: src/step1_5_filter_grids.py
Descrição: FILTRO TOPOLÓGICO DE GRIDS (NOVO PASSO 1.5)
Objetivo: Intersectar a malha de grids bruta com a malha viária (ruas).
Lógica: Se um grid não toca em nenhuma rua, ele é descartado (é água, mata, ou vazio).
Isso limpa o mapa (Area 10/Represa) e acelera o treinamento em 40-50%.
"""

import geopandas as gpd
import pandas as pd
import os
import glob
import sys
import warnings

# Suprime avisos de projeção do GeoPandas para manter o log limpo
warnings.filterwarnings("ignore")

from pipeline import config
from pipeline.bridge import events

BASE_DIR = config.BASE_DIR
DIR_RAW_GRIDS = config.DIR_STREETS
DIR_OUTPUT_GRIDS = config.DIR_GRIDS 

def _celulas_da_grade(gdf_grid, dissolver=False):
    """
    Identifica a célula da grade regular (lado medido nas células inteiras) de cada
    linha da malha. Devolve (malha, nº de células únicas, nº de linhas sem área).
    dissolver=True junta as linhas de cada célula numa só geometria (união dos pedaços),
    com os atributos da linha de maior área, e descarta as linhas sem área.
    """
    import numpy as np
    m = gdf_grid.to_crs(config.CRS_METRIC)
    area = m.geometry.area
    sem_area = area < 10
    b = m.geometry.bounds
    lado_x = (b.maxx - b.minx)
    inteiras = (area > 0) & (abs(area - lado_x ** 2) / lado_x.clip(lower=1) ** 2 < 0.01)
    if inteiras.sum() < 10:
        # sem células inteiras suficientes para medir a grade: usa geometria idêntica
        chave = m.geometry.to_wkb()
    else:
        lado = float(np.median(lado_x[inteiras]))
        ox = float(np.median(b.minx[inteiras] % lado))
        oy = float(np.median(b.miny[inteiras] % lado))
        rp = m.geometry.representative_point()
        chave = (((rp.x - ox) // lado).astype('int64').astype(str) + '_' +
                 ((rp.y - oy) // lado).astype('int64').astype(str))
    n_celulas = int(chave[~sem_area].nunique())
    n_sem_area = int(sem_area.sum())
    if not dissolver:
        return gdf_grid, n_celulas, n_sem_area
    g = gdf_grid.loc[~sem_area.values].copy()
    g['_k'] = chave[~sem_area].values
    g['_a'] = area[~sem_area].values
    primeira = g.sort_values('_a', ascending=False).drop_duplicates('_k').set_index('_k')
    uniao = g[['_k', 'geometry']].dissolve(by='_k').geometry
    primeira['geometry'] = uniao.reindex(primeira.index).values
    out = gpd.GeoDataFrame(primeira.reset_index(drop=True).drop(columns=['_a']), geometry='geometry', crs=gdf_grid.crs)
    return out, n_celulas, n_sem_area


def filter_grid_by_streets(area_name):
    print(f"\n--- Filtrando Grid por Ruas: {area_name} ---")
    
    # 1. Caminhos dos Arquivos
    path_grid_raw = os.path.join(DIR_RAW_GRIDS, f"grids_{area_name}.geojson")
    path_streets = os.path.join(DIR_RAW_GRIDS, f"ruas_{area_name}.geojson")
    
    # Validação de Existência
    if not os.path.exists(path_grid_raw):
        print(f"   [PULAR] Grid bruto não encontrado: {path_grid_raw}")
        return
    
    if not os.path.exists(path_streets):
        # Fallback: Se não tem arquivo de ruas, COPIA o grid original sem filtrar
        print(f"   [AVISO] Arquivo de ruas não encontrado para {area_name}. Copiando grid original...")
        gdf_raw = gpd.read_file(path_grid_raw)
        out_path = os.path.join(DIR_OUTPUT_GRIDS, f"{area_name}.geojson")
        gdf_raw.to_file(out_path, driver='GeoJSON')
        return

    # 2. Carregamento
    print("   -> Carregando geometrias...")
    gdf_grid = gpd.read_file(path_grid_raw)
    gdf_streets = gpd.read_file(path_streets)
    
    initial_count = len(gdf_grid)

    # Células repetidas: a malha traz a mesma célula da grade de 200 m em mais de uma
    # linha (inteira e/ou recortada pelos limites de batalhão e distrito). Cada crime
    # nessas células é contado mais de uma vez.
    gdf_grid, n_celulas, n_sem_area = _celulas_da_grade(gdf_grid, dissolver=config.FILTER_PARAMS.get('REMOVER_CELULAS_REPETIDAS'))
    n_rep = initial_count - n_sem_area - n_celulas
    events.metric('filter', 'celulas_unicas', int(n_celulas), area=area_name)
    events.metric('filter', 'celulas_repetidas', int(n_rep), area=area_name)
    if config.FILTER_PARAMS.get('REMOVER_CELULAS_REPETIDAS'):
        print(f"   [MALHA] {initial_count} linhas -> {len(gdf_grid)} células únicas "
              f"({n_rep} repetidas juntadas, {n_sem_area} sem área descartadas).")
    elif n_rep:
        print(f"   [AVISO] A malha tem {initial_count} linhas para {n_celulas} células únicas: "
              f"{n_rep} são repetidas e os crimes nelas são contados mais de uma vez.")
    base_count = len(gdf_grid)
    
    # 3. Padronização de Projeção
    # Precisamos de um CRS métrico para precisão, ou garantir que ambos sejam iguais (ex: 4326)
    if gdf_grid.crs != gdf_streets.crs:
        print(f"   -> Ajustando projeções ({gdf_streets.crs.name} -> {gdf_grid.crs.name})...")
        gdf_streets = gdf_streets.to_crs(gdf_grid.crs)
        
    # 4. Operação de Spatial Join (A Mágica)
    # 'inner' = mantém apenas grids que interceptam ruas
    # predicate='intersects' = se toca ou cruza
    print("   -> Aplicando máscara viária (Spatial Join)...")
    # Usamos sjoin para filtrar. Queremos manter as linhas do GRID (left) que tocam RUAS (right)
    # Como sjoin pode duplicar linhas se um grid tocar 2 ruas, usamos drop_duplicates depois
    try:
        # Mantém apenas colunas do grid para evitar poluição
        columns_to_keep = gdf_grid.columns.tolist()
        
        gdf_filtered = gpd.sjoin(
            gdf_grid, 
            gdf_streets[['geometry']], # Só precisa da geometria da rua
            how="inner", 
            predicate="intersects"
        )
        
        # Remove duplicatas (um grid pode tocar várias ruas, gerando linhas repetidas)
        gdf_filtered = gdf_filtered[columns_to_keep].drop_duplicates(subset=['GRID_ID'])
        
    except Exception as e:
        print(f"   [ERRO] Falha no Spatial Join: {e}")
        return

    final_count = len(gdf_filtered)
    removed = base_count - final_count
    reduction_pct = (removed / base_count) * 100
    
    print(f"   [RESULTADO] Grids Originais: {initial_count} -> Filtrados: {final_count}")
    events.metric('filter', 'grids_malha', int(initial_count), area=area_name)
    events.metric('filter', 'grids_com_rua', int(final_count), area=area_name)
    print(f"   [EFICIÊNCIA] Removidos {removed} grids ({reduction_pct:.1f}%) de água/mata.")
    
    if final_count == 0:
        print("   [PERIGO] O filtro removeu TODOS os grids! Verifique se as projeções batem.")
        return

    # 5. Salvar Resultado (Para o Step 2 usar)
    out_path = os.path.join(DIR_OUTPUT_GRIDS, f"{area_name}.geojson")
    
    # Garante que a pasta de saída existe
    os.makedirs(DIR_OUTPUT_GRIDS, exist_ok=True)
    
    # Remove coluna index_right se sobrou
    if 'index_right' in gdf_filtered.columns:
        gdf_filtered = gdf_filtered.drop(columns=['index_right'])
        
    gdf_filtered.to_file(out_path, driver='GeoJSON')
    print(f"   -> Grid Otimizado Salvo: {out_path}")

def run_step1_5(target_area=None):
    print("=== PASSO 1.5: FILTRAGEM DE GRIDS POR MALHA VIÁRIA ===")
    print(f"Origem: {DIR_RAW_GRIDS}")
    print(f"Destino: {DIR_OUTPUT_GRIDS}")
    
    # Lista arquivos de grid na pasta streets
    pattern = os.path.join(DIR_RAW_GRIDS, "grids_area_*.geojson")
    files = glob.glob(pattern)
    
    if not files:
        print("[ERRO] Nenhum arquivo 'grids_area_*.geojson' encontrado na pasta streets.")
        return

    # Extrai nomes das áreas (ex: 'area_01')
    # O arquivo chama 'grids_area_01.geojson', então tiramos 'grids_' e '.geojson'
    all_areas = [os.path.basename(f).replace("grids_", "").replace(".geojson", "") for f in files]
    
    if target_area:
        if target_area in all_areas:
            filter_grid_by_streets(target_area)
        else:
            print(f"   [AVISO] Área {target_area} não encontrada nos arquivos brutos.")
    else:
        areas = sorted(all_areas)
        for i, area in enumerate(areas):
            events.progress('filter', i, len(areas), area=area, etapa='malha')
            filter_grid_by_streets(area)

if __name__ == "__main__":
    # Permite rodar via linha de comando: python src/step1_5_filter_grids.py --area area_10
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--area", type=str, help="Nome da área alvo (ex: area_10)")
    args = parser.parse_args()
    
    run_step1_5(args.area)