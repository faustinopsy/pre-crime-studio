"""
Arquivo: step4_download_aux.py
Descrição: Baixa dados auxiliares (Ruas e POIs) para todas as áreas processadas.
"""

import os
import glob
import geopandas as gpd
from pipeline import config
import warnings

try:
    import osmnx as ox
    HAS_OSMNX = True
except ImportError:
    HAS_OSMNX = False

warnings.filterwarnings("ignore")

def download_for_area(area_name):
    print(f"\n--- Preparando Infraestrutura: {area_name} ---")
    
    path_grid = os.path.join(config.DIR_GRIDS, f"{area_name}.geojson")
    if not os.path.exists(path_grid):
        print(f"   [PULAR] Grid não encontrado.")
        return

    # Carrega limite da área
    gdf_grid = gpd.read_file(path_grid)
    if gdf_grid.crs != config.CRS_LATLON:
        gdf_grid = gdf_grid.to_crs(config.CRS_LATLON)
    polygon = gdf_grid.unary_union

    # 1. Ruas
    path_streets = os.path.join(config.DIR_STREETS, f"ruas_{area_name}.geojson")
    if not os.path.exists(path_streets) and HAS_OSMNX:
        print("   [OSM] Baixando Ruas...")
        try:
            G = ox.graph_from_polygon(polygon, network_type='drive')
            gdf_ruas = ox.graph_to_gdfs(G, nodes=False, edges=True)
            cols = ['osmid', 'name', 'highway', 'geometry']
            gdf_ruas[[c for c in cols if c in gdf_ruas.columns]].to_file(path_streets, driver='GeoJSON')
        except Exception as e:
            print(f"   [ERRO] Falha ruas: {e}")

    # 2. POIs (Pontos de Interesse)
    path_pois = os.path.join(config.DIR_POIS, f"pois_{area_name}.geojson")
    if not os.path.exists(path_pois) and HAS_OSMNX:
        print("   [OSM] Baixando POIs...")
        try:
            tags = {
                "amenity": ["bar", "pub", "nightclub", "restaurant", "bank", "police", "bus_station"],
                "shop": True, "leisure": ["park", "stadium"]
            }
            pois = ox.features.features_from_polygon(polygon, tags)
            if not pois.empty:
                pois = pois.reset_index()
                pois['geometry'] = pois['geometry'].centroid # Converte para ponto
                cols = ['osmid', 'amenity', 'shop', 'name', 'geometry']
                pois[[c for c in cols if c in pois.columns]].to_file(path_pois, driver='GeoJSON')
        except Exception as e:
            print(f"   [ERRO] Falha POIs: {e}")

def run_step4():
    if not HAS_OSMNX:
        print("[AVISO] OSMnx não instalado. Pule este passo.")
        return

    os.makedirs(config.DIR_STREETS, exist_ok=True)
    os.makedirs(config.DIR_POIS, exist_ok=True)
    
    # Identifica áreas
    pattern = os.path.join(config.DIR_GRIDS, "*.geojson")
    files = glob.glob(pattern)
    areas = [os.path.splitext(os.path.basename(f))[0] for f in files]
    
    for area in sorted(areas):
        download_for_area(area)

if __name__ == "__main__":
    run_step4()