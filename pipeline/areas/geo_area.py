"""Áreas de estudo escolhidas pelo operador (GeoJSON, KML, Shapefile .zip ou GeoPackage).

  python -m pipeline.areas.geo_area inspecionar <arquivo>   → imprime "@@AREA {json}" (para a tela)
  job 'areas' (pipeline/bridge/run.py)                     → criar(spec): grade, ruas, POIs e registro

Para cada área nova o app grava, na pasta de trabalho, os mesmos arquivos que as 8 áreas da
dissertação já têm:
  streets/grids_area_NN.geojson   grade de células quadradas recortada pelo polígono (GRID_ID estável)
  streets/ruas_area_NN.geojson    ruas do OpenStreetMap (opcional; sem elas a Filtragem mantém todas as células)
  pois/pois_area_NN.geojson       pontos de interesse do OpenStreetMap (opcional)
  areas/contornos/area_NN.geojson o polígono escolhido
  areas/areas.json                nome de exibição e dados de cada área criada pelo operador
O identificador continua sendo area_NN (12 a 99): o pipeline, o app e o servidor já aceitam esse
formato; o nome que o operador vê vem do registro.
"""
import json
import math
import os
import sys
from datetime import datetime

# quadro aproximado do município de São Paulo (as planilhas da Limpeza padrão são só da capital)
_CAPITAL_BBOX = (-46.83, -24.01, -46.36, -23.35)
CAMPOS_NOME = ['nome', 'name', 'nm_bairro', 'nome_bairro', 'bairro', 'nm_mun', 'nm_municip', 'nome_munic', 'municipio',
               'ds_nome', 'nm_distrit', 'nome_distr', 'distrito', 'nm_subpref', 'label', 'titulo', 'description']


class AreaErro(Exception):
    pass


def ler_geometrias(caminho):
    """Lê GeoJSON, KML, Shapefile (.zip ou .shp) ou GeoPackage em WGS84 (EPSG:4326), com as geometrias
    consertadas (make_valid) e sem as vazias. Usado pelas áreas (só polígonos, em _ler) e pelos pontos de
    interesse (pipeline/pois/conjuntos.py). Devolve (gdf, projeção de origem, feições sem geometria)."""
    import geopandas as gpd
    from shapely import make_valid

    ext = os.path.splitext(caminho)[1].lower()
    if ext not in ('.geojson', '.json', '.kml', '.zip', '.gpkg', '.shp'):
        raise AreaErro('Formato não reconhecido. Use GeoJSON (.geojson ou .json), KML, Shapefile compactado (.zip) ou GeoPackage (.gpkg).')
    alvo = f'zip://{caminho}' if ext == '.zip' else caminho
    try:
        gdf = gpd.read_file(alvo)
    except Exception as e:  # noqa: BLE001
        raise AreaErro(f'Não consegui ler o arquivo ({str(e)[:200]}). Confira se ele abre no geojson.io ou no QGIS.')
    if gdf.empty:
        raise AreaErro('O arquivo não tem nenhuma feição.')
    if gdf.crs is None:
        x0, y0, x1, y1 = gdf.total_bounds
        if not (-180 <= x0 <= 180 and -180 <= x1 <= 180 and -90 <= y0 <= 90 and -90 <= y1 <= 90):
            raise AreaErro('As coordenadas não estão em graus (longitude/latitude) e o arquivo não diz a projeção. '
                           'Exporte em WGS84 (EPSG:4326): no mapshaper use "-proj wgs84"; no QGIS escolha EPSG:4326 ao salvar.')
        gdf = gdf.set_crs(4326)
    origem = gdf.crs.to_string()
    gdf = gdf.to_crs(4326)
    n0 = len(gdf)
    gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()
    invalidas = ~gdf.geometry.is_valid
    if invalidas.any():
        gdf.loc[invalidas, 'geometry'] = gdf.loc[invalidas, 'geometry'].apply(make_valid)
    return gdf.reset_index(drop=True), origem, n0 - len(gdf)


def _ler(caminho):
    """Lê o arquivo, deixa só polígonos válidos em WGS84 (EPSG:4326)."""
    from shapely import make_valid
    from shapely.geometry import GeometryCollection, MultiPolygon, Polygon

    gdf, origem, vazias = ler_geometrias(caminho)

    def so_poligonos(g):
        if g is None or g.is_empty:
            return None
        if not g.is_valid:
            g = make_valid(g)
        if isinstance(g, (Polygon, MultiPolygon)):
            return g
        if isinstance(g, GeometryCollection):
            partes = [p for p in g.geoms if isinstance(p, (Polygon, MultiPolygon))]
            if not partes:
                return None
            from shapely.ops import unary_union
            return unary_union(partes)
        return None

    n0 = len(gdf)
    gdf['geometry'] = gdf.geometry.apply(so_poligonos)
    gdf = gdf[gdf.geometry.notna()].reset_index(drop=True)
    if gdf.empty:
        raise AreaErro('O arquivo não tem polígonos (só pontos ou linhas). A área precisa ser um polígono: desenhe o contorno do bairro ou da cidade.')
    return gdf, origem, n0 - len(gdf) + vazias


def _km2(gdf):
    utm = gdf.estimate_utm_crs()
    return gdf.to_crs(utm).area / 1e6


def _campo_nome(gdf):
    cols = [c for c in gdf.columns if c != 'geometry']
    low = {c.lower(): c for c in cols}
    for k in CAMPOS_NOME:
        if k in low and gdf[low[k]].astype(str).str.strip().ne('').any():
            return low[k]
    for c in cols:  # primeiro campo de texto com valores variados
        if gdf[c].dtype == object and gdf[c].nunique(dropna=True) >= min(len(gdf), 2):
            return c
    return None


def inspecionar(caminho):
    gdf, origem, ignoradas = _ler(caminho)
    km2 = _km2(gdf)
    x0, y0, x1, y1 = gdf.total_bounds
    tol = max(x1 - x0, y1 - y0) / 400  # contorno simplificado só para o desenho na tela
    campos = []
    for c in [c for c in gdf.columns if c != 'geometry'][:40]:
        vals = gdf[c].dropna().astype(str).str.strip()
        vals = vals[vals != '']
        campos.append({'nome': c, 'exemplos': vals.head(4).tolist(), 'unicos': int(vals.nunique())})
    sug = _campo_nome(gdf)
    feicoes = []
    for i, row in gdf.iterrows():
        g = row.geometry.simplify(tol, preserve_topology=True)
        polys = list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
        aneis = [[[round(x, 5), round(y, 5)] for x, y in p.exterior.coords] for p in polys if not p.is_empty]
        props = {c: (None if row[c] is None else str(row[c])[:80]) for c in [c['nome'] for c in campos[:12]]}
        fx0, fy0, fx1, fy1 = row.geometry.bounds
        cx0, cy0, cx1, cy1 = _CAPITAL_BBOX
        fora = bool(fx1 < cx0 or fx0 > cx1 or fy1 < cy0 or fy0 > cy1)
        feicoes.append({'i': int(i), 'km2': round(float(km2.iloc[i]), 3), 'props': props, 'aneis': aneis, 'foraDaCapital': fora})
    cx0, cy0, cx1, cy1 = _CAPITAL_BBOX
    return {
        'arquivo': os.path.basename(caminho), 'n': len(gdf), 'ignoradas': int(ignoradas), 'crs': origem,
        'bbox': [round(float(v), 5) for v in (x0, y0, x1, y1)], 'campos': campos, 'campoSugerido': sug,
        'km2Total': round(float(km2.sum()), 3),
        'foraDaCapital': any(f['foraDaCapital'] for f in feicoes),
        'feicoes': feicoes,
    }


# ── criação ────────────────────────────────────────────────────────────────────

def _registro_path(data_dir):
    return os.path.join(data_dir, 'areas', 'areas.json')


def ler_registro(data_dir):
    try:
        with open(_registro_path(data_dir), encoding='utf-8') as f:
            r = json.load(f)
        return r if isinstance(r.get('areas'), dict) else {'versao': 1, 'areas': {}}
    except (OSError, ValueError):
        return {'versao': 1, 'areas': {}}


def _gravar_registro(data_dir, reg):
    os.makedirs(os.path.dirname(_registro_path(data_dir)), exist_ok=True)
    tmp = _registro_path(data_dir) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, _registro_path(data_dir))


def _proximos_ids(dir_streets, reg, n):
    import glob
    usados = {os.path.basename(f)[len('grids_'):-len('.geojson')] for f in glob.glob(os.path.join(dir_streets, 'grids_area_*.geojson'))}
    usados |= set(reg['areas'].keys())
    livres = [f'area_{k:02d}' for k in range(12, 100) if f'area_{k:02d}' not in usados]
    if len(livres) < n:
        raise AreaErro('Não há mais identificadores livres para áreas novas (máximo de 88). Remova áreas que não usa.')
    return livres[:n]


def gerar_grade(geom, celula, max_celulas=60000):
    """Células quadradas de `celula` metros alinhadas a múltiplos do tamanho (grade estável),
    recortadas pelo polígono, numa projeção UTM escolhida pelo centro da área. Devolve GeoDataFrame em 4326."""
    import geopandas as gpd
    import numpy as np
    import shapely

    g4326 = gpd.GeoSeries([geom], crs=4326)
    utm = g4326.estimate_utm_crs()
    gm = g4326.to_crs(utm).iloc[0]
    x0, y0, x1, y1 = gm.bounds
    s = float(celula)
    i0, j0 = math.floor(x0 / s), math.floor(y0 / s)
    i1, j1 = math.ceil(x1 / s), math.ceil(y1 / s)
    ncol, nlin = i1 - i0, j1 - j0
    if ncol * nlin > max_celulas * 4:
        raise AreaErro(f'A área é grande demais para células de {int(s)} m ({ncol * nlin:,} células no retângulo). '
                       'Escolha células maiores ou um polígono menor.'.replace(',', '.'))
    cols, lins = np.meshgrid(np.arange(ncol), np.arange(nlin))
    cols, lins = cols.ravel(), lins.ravel()
    xs, ys = (i0 + cols) * s, (j0 + lins) * s
    caixas = shapely.box(xs, ys, xs + s, ys + s)
    shapely.prepare(gm)
    dentro = shapely.intersects(gm, caixas)
    caixas, cols, lins = caixas[dentro], cols[dentro], lins[dentro]
    recortes = shapely.intersection(caixas, gm)
    areas = shapely.area(recortes)
    ok = areas >= 0.02 * s * s  # descarta lascas na borda (menos de 2% da célula)
    recortes, cols, lins = recortes[ok], cols[ok], lins[ok]
    if len(recortes) > max_celulas:
        raise AreaErro(f'A área teria {len(recortes):,} células de {int(s)} m (máximo {max_celulas:,}). '
                       'Escolha células maiores ou um polígono menor.'.replace(',', '.'))
    if len(recortes) == 0:
        raise AreaErro('O polígono é menor que uma célula. Escolha células menores.')
    grade = gpd.GeoDataFrame({'GRID_ID': (lins * ncol + cols).astype(int), 'LINHA': lins.astype(int), 'COLUNA': cols.astype(int)},
                             geometry=recortes, crs=utm)
    grade = grade.explode(index_parts=False)  # recorte que vira dois pedaços: fica o maior de cada célula
    grade['_a'] = grade.area
    grade = grade.sort_values('_a', ascending=False).drop_duplicates('GRID_ID').drop(columns='_a')
    return grade.sort_values('GRID_ID').to_crs(4326).reset_index(drop=True), str(utm)


def _osm(geom, area, dir_streets, dir_pois, progresso, so_falta=False):
    """Ruas (rede viária) e pontos de interesse do OpenStreetMap. Falhas não param a criação."""
    res = {'ruas': False, 'pois': False, 'avisos': []}
    try:
        import osmnx as ox
    except Exception:  # noqa: BLE001
        res['avisos'].append('O pacote osmnx não está instalado: sem ruas e pontos de interesse do OpenStreetMap.')
        return res
    # teste rápido de acesso: sem internet (ou com bloqueio), o osmnx insistiria por minutos
    try:
        import requests
        requests.get(ox.settings.overpass_url.rstrip('/') + '/status', timeout=10)
    except Exception as e:  # noqa: BLE001
        res['avisos'].append(f'Sem acesso ao OpenStreetMap ({type(e).__name__}): a área fica sem ruas e pontos de interesse. '
                             'Dá para baixar depois com o botão "Baixar ruas e pontos de interesse".')
        return res
    ox.settings.requests_timeout = 120
    ox.settings.use_cache = True

    def limpa(gdf, cols):
        gdf = gdf[[c for c in cols if c in gdf.columns] + ['geometry']].copy()
        for c in gdf.columns:
            if c != 'geometry':
                gdf[c] = gdf[c].apply(lambda v: v if v is None or isinstance(v, (str, int, float)) else str(v))
        return gdf

    p_ruas, p_pois = os.path.join(dir_streets, f'ruas_{area}.geojson'), os.path.join(dir_pois, f'pois_{area}.geojson')
    try:
        if so_falta and os.path.exists(p_ruas):
            raise _JaExiste()
        progresso('ruas')
        G = ox.graph_from_polygon(geom, network_type='drive')
        ruas = ox.graph_to_gdfs(G, nodes=False, edges=True).reset_index()
        limpa(ruas, ['u', 'v', 'key', 'osmid', 'name', 'highway']).to_file(os.path.join(dir_streets, f'ruas_{area}.geojson'), driver='GeoJSON')
        res['ruas'] = True
    except _JaExiste:
        res['ruas'] = True
    except Exception as e:  # noqa: BLE001
        res['avisos'].append(f'Ruas do OpenStreetMap não baixadas ({str(e)[:160]}).')
    try:
        if so_falta and os.path.exists(p_pois):
            raise _JaExiste()
        progresso('pontos de interesse')
        tags = {'amenity': ['bar', 'pub', 'nightclub', 'restaurant', 'bank', 'police', 'bus_station'], 'shop': True}
        pois = ox.features_from_polygon(geom, tags).reset_index()
        if len(pois):
            pois['geometry'] = pois.to_crs(pois.estimate_utm_crs()).centroid.to_crs(4326)
            os.makedirs(dir_pois, exist_ok=True)
            limpa(pois, ['osmid', 'id', 'amenity', 'shop', 'name']).to_file(os.path.join(dir_pois, f'pois_{area}.geojson'), driver='GeoJSON')
            res['pois'] = True
    except _JaExiste:
        res['pois'] = True
    except Exception as e:  # noqa: BLE001
        res['avisos'].append(f'Pontos de interesse não baixados ({str(e)[:160]}).')
    return res


class _JaExiste(Exception):
    pass


def criar(spec, config, events):
    """spec: {arquivo, indices|null, campoNome|null, modo: 'cada'|'juntar', nome (modo juntar), celula, osm}"""
    from shapely.ops import unary_union

    data_dir = config.DATA_DIR
    gdf, _, _ = _ler(spec['arquivo'])
    idx = spec.get('indices')
    if idx:
        gdf = gdf.iloc[[i for i in idx if 0 <= i < len(gdf)]]
    if gdf.empty:
        raise AreaErro('Nenhum polígono escolhido.')
    celula = int(spec.get('celula') or 200)
    if celula < 50 or celula > 2000:
        raise AreaErro('Tamanho de célula fora do intervalo (50 a 2.000 m).')
    campo = spec.get('campoNome')
    if spec.get('modo') == 'juntar':
        nome = (spec.get('nome') or '').strip() or os.path.splitext(os.path.basename(spec['arquivo']))[0]
        grupos = [(nome[:60], unary_union(list(gdf.geometry)))]
    else:
        grupos = []
        for k, (_, row) in enumerate(gdf.iterrows()):
            nome = str(row[campo]).strip() if campo and campo in gdf.columns and row[campo] is not None else ''
            grupos.append(((nome or f'Polígono {k + 1}')[:60], row.geometry))

    reg = ler_registro(data_dir)
    ids = _proximos_ids(config.DIR_STREETS, reg, len(grupos))
    nomes_usados = {v.get('nome') for v in reg['areas'].values()}
    os.makedirs(config.DIR_STREETS, exist_ok=True)
    os.makedirs(os.path.join(data_dir, 'areas', 'contornos'), exist_ok=True)
    events.emit('plan', job='areas', acao='criar', areas=ids, nomes=[g[0] for g in grupos], celula=celula, osm=bool(spec.get('osm')))
    criadas = []
    for k, (area, (nome, geom)) in enumerate(zip(ids, grupos)):
        base_nome, n = nome, 2
        while nome in nomes_usados:
            nome = f'{base_nome} ({n})'
            n += 1
        nomes_usados.add(nome)
        print(f'\n=== {nome} → {area} ===')
        events.progress('areas', k, len(grupos), area=area, nome=nome, etapa='grade')
        grade, utm = gerar_grade(geom, celula)
        grade['AREA_NOME'] = nome
        p_grade = os.path.join(config.DIR_STREETS, f'grids_{area}.geojson')
        grade.to_file(p_grade, driver='GeoJSON')
        import geopandas as gpd
        km2 = float(gpd.GeoSeries([geom], crs=4326).to_crs(utm).area.iloc[0] / 1e6)
        p_contorno = os.path.join(data_dir, 'areas', 'contornos', f'{area}.geojson')
        gpd.GeoDataFrame({'AREA': [area], 'NOME': [nome]}, geometry=[geom], crs=4326).to_file(p_contorno, driver='GeoJSON')
        print(f'   grade: {len(grade)} células de {celula} m · {km2:.2f} km² · projeção {utm}')
        events.metric('areas', 'celulas', int(len(grade)), area=area)
        events.artifact('areas', p_grade, kind='geojson')
        osm = {'ruas': False, 'pois': False, 'avisos': []}
        if spec.get('osm'):
            osm = _osm(geom, area, config.DIR_STREETS, config.DIR_POIS,
                       lambda etapa: events.progress('areas', k, len(grupos), area=area, nome=nome, etapa=etapa))
            for a in osm['avisos']:
                print(f'[AVISO] {a}')
            for nomearq, ok in ((f'ruas_{area}.geojson', osm['ruas']),):
                if ok:
                    events.artifact('areas', os.path.join(config.DIR_STREETS, nomearq), kind='geojson')
            if osm['pois']:
                events.artifact('areas', os.path.join(config.DIR_POIS, f'pois_{area}.geojson'), kind='geojson')
            print(f"   OpenStreetMap: ruas {'ok' if osm['ruas'] else 'não'} · pontos de interesse {'ok' if osm['pois'] else 'não'}")
        x0, y0, x1, y1 = geom.bounds
        cx0, cy0, cx1, cy1 = _CAPITAL_BBOX
        reg = ler_registro(data_dir)  # relê: outra área pode ter sido gravada
        reg['areas'][area] = {
            'nome': nome, 'arquivo': os.path.basename(spec['arquivo']), 'celula_m': celula, 'celulas': int(len(grade)),
            'km2': round(km2, 3), 'projecao': utm, 'ruas': bool(osm['ruas']), 'pois': bool(osm['pois']),
            'foraDaCapital': bool(x1 < cx0 or x0 > cx1 or y1 < cy0 or y0 > cy1),
            'bbox': [round(v, 5) for v in (x0, y0, x1, y1)], 'criadaEm': datetime.now().isoformat(timespec='seconds'),
        }
        _gravar_registro(data_dir, reg)
        criadas.append({'area': area, 'nome': nome, 'celulas': int(len(grade))})
        events.metric('areas', 'criada', {'area': area, 'nome': nome, 'celulas': int(len(grade)), 'ruas': osm['ruas'], 'pois': osm['pois']}, area=area)
    events.progress('areas', len(grupos), len(grupos))
    return criadas


def baixar_osm(spec, config, events):
    """Baixa (de novo) ruas e pontos de interesse de áreas já criadas, pelo contorno salvo."""
    import geopandas as gpd
    data_dir = config.DATA_DIR
    feitas = []
    areas = spec.get('areas') or []
    reg0 = ler_registro(data_dir)['areas']
    events.emit('plan', job='areas', acao='osm', areas=areas, nomes=[reg0.get(a, {}).get('nome', a) for a in areas])
    for k, area in enumerate(areas):
        reg = ler_registro(data_dir)
        criada = area in reg['areas']
        # contorno salvo (áreas criadas no app) ou, sem ele, a união das células da malha (malhas importadas e as
        # da dissertação). Nas áreas que não foram criadas no app, só baixa o que falta: nada é sobrescrito.
        p = os.path.join(data_dir, 'areas', 'contornos', f'{area}.geojson')
        if not os.path.exists(p):
            p = os.path.join(config.DIR_STREETS, f'grids_{area}.geojson')
        if not os.path.exists(p):
            raise AreaErro(f'Nem o contorno nem a malha da área {area} foram encontrados.')
        gs = gpd.read_file(p).to_crs(4326).geometry
        geom = gs.union_all() if hasattr(gs, 'union_all') else gs.unary_union
        nome = reg['areas'].get(area, {}).get('nome', area)
        print(f'\n=== {nome} ({area}) · OpenStreetMap ===')
        osm = _osm(geom, area, config.DIR_STREETS, config.DIR_POIS,
                   lambda etapa: events.progress('areas', k, len(areas), area=area, nome=nome, etapa=etapa), so_falta=not criada)
        for a in osm['avisos']:
            print(f'[AVISO] {a}')
        reg = ler_registro(data_dir)
        if criada:
            reg['areas'][area]['ruas'] = bool(osm['ruas']) or reg['areas'][area].get('ruas', False)
            reg['areas'][area]['pois'] = bool(osm['pois']) or reg['areas'][area].get('pois', False)
            _gravar_registro(data_dir, reg)
        print(f"   ruas {'ok' if osm['ruas'] else 'não'} · pontos de interesse {'ok' if osm['pois'] else 'não'}")
        if not osm['ruas'] and not osm['pois']:
            raise AreaErro(osm['avisos'][0] if osm['avisos'] else 'Nada foi baixado do OpenStreetMap.')
        feitas.append({'area': area, 'nome': nome, 'celulas': reg['areas'].get(area, {}).get('celulas', 0)})
    events.progress('areas', len(areas), len(areas))
    return feitas


def _main(argv):
    if len(argv) >= 2 and argv[0] == 'inspecionar':
        try:
            r = inspecionar(argv[1])
            print('@@AREA ' + json.dumps({'ok': True, **r}, ensure_ascii=False))
        except AreaErro as e:
            print('@@AREA ' + json.dumps({'ok': False, 'erro': str(e)}, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001
            print('@@AREA ' + json.dumps({'ok': False, 'erro': f'Erro ao ler o arquivo: {str(e)[:300]}'}, ensure_ascii=False))
        return 0
    print('uso: python -m pipeline.areas.geo_area inspecionar <arquivo>')
    return 2


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
