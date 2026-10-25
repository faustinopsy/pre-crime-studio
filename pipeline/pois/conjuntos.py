"""
Conjuntos de pontos de interesse (POI) versionados.

<pasta de trabalho>/pois/conjuntos/<id>/
    pois_area_NN.geojson   pontos de cada área
    manifesto.json         nome, origem (dissertacao | osm | arquivo), data e hora, consulta usada ou arquivo
                           original (com sha256), contagem por área e por categoria, sha256 de cada arquivo,
                           duplicados removidos e situação (rascunho | pronto)

O conjunto "dissertacao" é a cópia byte a byte de <pasta de trabalho>/pois/pois_area_NN.geojson (os POIs
que acompanham o app, em base/pois). Ele é o padrão e não é normalizado: com ele ativo o pipeline lê os
mesmos arquivos de sempre e o resultado é idêntico ao da dissertação.

Os conjuntos novos (OpenStreetMap ou arquivo próprio) seguem um esquema comum. Cada ponto tem:
    categoria   'amenity:bar', 'amenity:police', 'shop:clothes', 'arquivo:delegacia'… (o que os pesos usam)
    nome, fonte (osm | arquivo | dissertacao)
    amenity, shop (compatibilidade: preenchidos quando a categoria é amenity:… ou shop:…)
    abertura, fechamento (opcionais, AAAA-MM-DD): a previsão usa só os pontos abertos na data de referência
Polígonos e linhas viram um ponto representativo (dentro da forma); tudo é recortado pelo contorno da área.
Duplicados: pontos da mesma categoria e com o mesmo nome a menos de N metros (25 por padrão; 0 desliga)
contam uma vez só, e o manifesto registra quantos saíram.

    python -m pipeline.pois.conjuntos inspecionar <arquivo>   → "@@POI {json}" (campos e valores, para a tela)
    job 'pois' (pipeline/bridge/run.py --spec)                → baixar_osm(spec) / importar(spec)
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime

ID_DISSERTACAO = 'dissertacao'
SEM_CATEGORIA = '(sem categoria)'
COLS = ['categoria', 'nome', 'fonte', 'amenity', 'shop', 'abertura', 'fechamento']
AVISO_OSM = ('O OpenStreetMap é um retrato de hoje: usado em meses passados, pode conter estabelecimentos '
             'que ainda não existiam (e deixar de fora os que já fecharam).')
CAMPOS_LAT = ['lat', 'latitude', 'y', 'lat_dd', 'nu_latitude', 'coord_y']
CAMPOS_LON = ['lon', 'lng', 'long', 'longitude', 'x', 'lon_dd', 'nu_longitude', 'coord_x']
CAMPOS_CATEGORIA = ['categoria', 'category', 'tipo', 'type', 'amenity', 'classe', 'class', 'shop']
CAMPOS_NOME = ['nome', 'name', 'nome_fantasia', 'razao_social', 'descricao', 'description', 'title', 'titulo']
CAMPOS_ABERTURA = ['abertura', 'data_abertura', 'inicio', 'data_inicio', 'opening_date', 'start_date', 'dt_abertura']
CAMPOS_FECHAMENTO = ['fechamento', 'data_fechamento', 'fim', 'data_fim', 'closing_date', 'end_date', 'dt_fechamento']


class PoiErro(Exception):
    pass


# ── caminhos e utilidades ──────────────────────────────────────────────────────────────────────
def dir_conjuntos(config):
    return os.path.join(config.DIR_POIS, 'conjuntos')


def dir_conjunto(config, cid):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', cid or ''):
        raise PoiErro(f'Identificador de conjunto inválido: {cid!r}')
    return os.path.join(dir_conjuntos(config), cid)


def caminho_pois(config, area, dir_conjunto_=None):
    """Arquivo de POI da área: o do conjunto ativo (POI_SET_DIR) ou o de sempre (pois/pois_<área>.geojson)."""
    base = dir_conjunto_ or getattr(config, 'POI_SET_DIR', None) or config.DIR_POIS
    return os.path.join(base, f'pois_{area}.geojson')


def sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for bloco in iter(lambda: f.read(1 << 20), b''):
            h.update(bloco)
    return h.hexdigest()


def slug(categoria):
    """Categoria → pedaço de nome de arquivo ('amenity:bar' → 'amenity.bar')."""
    s = str(categoria).lower().replace(':', '.')
    s = re.sub(r'[^a-z0-9.]+', '-', s).strip('-.')
    return (s or 'sem-categoria')[:40]


def categorias_de(df):
    """Categoria de cada ponto: a coluna 'categoria' (conjuntos novos) ou, nos arquivos da dissertação,
    amenity:<valor>, senão shop:<valor>, senão '(sem categoria)' (a mesma ordem dos pesos no step5)."""
    import numpy as np
    import pandas as pd
    if 'categoria' in df.columns:
        c = df['categoria'].astype(object)
        return c.where(c.notna() & (c.astype(str).str.strip() != ''), SEM_CATEGORIA).astype(str)
    out = pd.Series(SEM_CATEGORIA, index=df.index, dtype=object)
    if 'shop' in df.columns:
        m = df['shop'].notna()
        out[m] = 'shop:' + df.loc[m, 'shop'].astype(str)
    if 'amenity' in df.columns:
        m = df['amenity'].notna()
        out[m] = 'amenity:' + df.loc[m, 'amenity'].astype(str)
    return out.astype(str) if len(out) else out


def filtrar_por_data(gdf, data_ref):
    """Só os pontos abertos na data de referência (abertura <= ref < fechamento). Sem as colunas, nada muda."""
    import pandas as pd
    if data_ref is None or ('abertura' not in gdf.columns and 'fechamento' not in gdf.columns):
        return gdf, 0
    ref = pd.Timestamp(data_ref)
    ok = pd.Series(True, index=gdf.index)
    if 'abertura' in gdf.columns:
        a = pd.to_datetime(gdf['abertura'], errors='coerce')
        ok &= a.isna() | (a <= ref)
    if 'fechamento' in gdf.columns:
        f = pd.to_datetime(gdf['fechamento'], errors='coerce')
        ok &= f.isna() | (f > ref)
    return gdf[ok], int((~ok).sum())


def areas_disponiveis(config):
    import glob
    return sorted(os.path.basename(f)[len('grids_'):-len('.geojson')]
                  for f in glob.glob(os.path.join(config.DIR_STREETS, 'grids_area_*.geojson')))


def contorno(config, area):
    """Polígono da área em WGS84: o contorno salvo (áreas criadas no app) ou a união da malha."""
    import geopandas as gpd
    p = os.path.join(config.DATA_DIR, 'areas', 'contornos', f'{area}.geojson')
    if not os.path.exists(p):
        p = os.path.join(config.DIR_STREETS, f'grids_{area}.geojson')
    if not os.path.exists(p):
        raise PoiErro(f'A área {area} não tem malha nem contorno.')
    gs = gpd.read_file(p).to_crs(4326).geometry
    g = gs.union_all() if hasattr(gs, 'union_all') else gs.unary_union
    return g.buffer(0)


# ── leitura de arquivos ────────────────────────────────────────────────────────────────────────
def _ler_csv(caminho):
    import pandas as pd
    for sep in (',', ';', '\t'):
        for enc in ('utf-8-sig', 'latin-1'):
            try:
                df = pd.read_csv(caminho, sep=sep, encoding=enc, dtype=str)
            except Exception:  # noqa: BLE001
                continue
            if df.shape[1] > 1:
                return df
    raise PoiErro('Não consegui ler o CSV. Use vírgula ou ponto e vírgula como separador e uma linha de cabeçalho.')


def _acha(cols, nomes):
    low = {c.lower().strip(): c for c in cols}
    for n in nomes:
        if n in low:
            return low[n]
    return None


def ler_pontos(caminho, lat=None, lon=None):
    """GeoJSON, KML, Shapefile (.zip), GeoPackage ou CSV com latitude e longitude → GeoDataFrame de pontos em
    WGS84. Usa o leitor das áreas (pipeline/areas/geo_area.py) para os formatos de mapa: conserta geometrias e
    converte a projeção. Polígonos e linhas viram um ponto representativo (sempre dentro da forma)."""
    import geopandas as gpd
    import pandas as pd
    ext = os.path.splitext(caminho)[1].lower()
    if ext in ('.csv', '.txt'):
        df = _ler_csv(caminho)
        lat = lat or _acha(df.columns, CAMPOS_LAT)
        lon = lon or _acha(df.columns, CAMPOS_LON)
        if not lat or not lon or lat not in df.columns or lon not in df.columns:
            raise PoiErro('O CSV precisa de uma coluna de latitude e uma de longitude (ex.: "lat" e "lon").')
        y = pd.to_numeric(df[lat].astype(str).str.replace(',', '.'), errors='coerce')
        x = pd.to_numeric(df[lon].astype(str).str.replace(',', '.'), errors='coerce')
        ok = x.between(-180, 180) & y.between(-90, 90)
        if not ok.any():
            raise PoiErro(f'Nenhuma linha com latitude e longitude válidas em "{lat}" e "{lon}" (graus decimais, WGS84).')
        gdf = gpd.GeoDataFrame(df[ok].drop(columns=[lat, lon]), geometry=gpd.points_from_xy(x[ok], y[ok]), crs=4326)
        return gdf.reset_index(drop=True), 'EPSG:4326 (CSV)', int((~ok).sum())
    from pipeline.areas import geo_area
    gdf, origem, ignoradas = geo_area.ler_geometrias(caminho)
    gdf['geometry'] = gdf.geometry.representative_point()
    return gdf, origem, ignoradas


def inspecionar(caminho):
    gdf, origem, ignoradas = ler_pontos(caminho)
    cols = [c for c in gdf.columns if c != 'geometry']
    campos = []
    for c in cols[:60]:
        v = gdf[c].dropna().astype(str).str.strip()
        v = v[v != '']
        vc = v.value_counts()
        campos.append({'nome': c, 'unicos': int(vc.size), 'vazios': int(len(gdf) - len(v)), 'exemplos': v.head(4).tolist(),
                       'valores': [[str(k)[:80], int(n)] for k, n in vc.head(300).items()] if vc.size <= 300 else None})
    x0, y0, x1, y1 = gdf.total_bounds
    amostra = gdf.sample(min(len(gdf), 3000), random_state=0) if len(gdf) > 3000 else gdf
    return {
        'arquivo': os.path.basename(caminho), 'n': int(len(gdf)), 'ignoradas': int(ignoradas), 'crs': origem,
        'bbox': [round(float(v), 5) for v in (x0, y0, x1, y1)], 'campos': campos,
        'sugestao': {'categoria': _acha(cols, CAMPOS_CATEGORIA), 'nome': _acha(cols, CAMPOS_NOME),
                     'abertura': _acha(cols, CAMPOS_ABERTURA), 'fechamento': _acha(cols, CAMPOS_FECHAMENTO)},
        'pontos': [[round(p.x, 5), round(p.y, 5)] for p in amostra.geometry],
    }


# ── esquema comum ──────────────────────────────────────────────────────────────────────────────
def normalizar(gdf, categoria, nome=None, fonte='arquivo', abertura=None, fechamento=None):
    """categoria/nome/abertura/fechamento: Series alinhadas a gdf (ou None)."""
    import geopandas as gpd
    import pandas as pd
    cat = pd.Series(categoria, index=gdf.index).astype(object)
    cat = cat.where(cat.notna() & (cat.astype(str).str.strip() != ''), SEM_CATEGORIA).astype(str)
    out = gpd.GeoDataFrame({
        'categoria': cat,
        'nome': (pd.Series(nome, index=gdf.index) if nome is not None else pd.Series(None, index=gdf.index, dtype=object)),
        'fonte': fonte,
    }, geometry=gdf.geometry.representative_point() if len(gdf) else gdf.geometry, crs=gdf.crs)
    out['amenity'] = out['categoria'].where(out['categoria'].str.startswith('amenity:'), None).str.slice(8)
    out['shop'] = out['categoria'].where(out['categoria'].str.startswith('shop:'), None).str.slice(5)

    def data(s):
        if s is None:
            return pd.Series(None, index=gdf.index, dtype=object)
        d = pd.to_datetime(pd.Series(s, index=gdf.index), errors='coerce', dayfirst=True)
        return d.dt.strftime('%Y-%m-%d').where(d.notna(), None)
    out['abertura'] = data(abertura)
    out['fechamento'] = data(fechamento)
    out['nome'] = out['nome'].where(out['nome'].notna(), None)
    return out[COLS + ['geometry']]


def deduplicar(gdf, metros):
    """Pontos da mesma categoria e com o mesmo nome (não vazio) a menos de `metros` contam uma vez só.
    Pontos sem nome nunca são juntados: lojas vizinhas sem nome são, em geral, estabelecimentos diferentes."""
    if not metros or metros <= 0 or len(gdf) < 2:
        return gdf, 0
    m = gdf.to_crs(gdf.estimate_utm_crs())
    nm = m['nome'].fillna('').astype(str).str.strip().str.lower()
    manter = []
    from shapely.strtree import STRtree
    for (cat, nome), g in m.groupby([m['categoria'], nm]):
        if not nome:
            manter.extend(g.index)
            continue
        pts = list(g.geometry)
        idx = list(g.index)
        arv = STRtree(pts)
        fora = set()
        for i, p in enumerate(pts):
            if i in fora:
                continue
            manter.append(idx[i])
            for j in arv.query(p.buffer(metros)):
                if j > i and pts[j].distance(p) < metros:
                    fora.add(int(j))
    manter = sorted(set(manter))
    return gdf.loc[manter], int(len(gdf) - len(manter))


def recortar(gdf, geom):
    if not len(gdf):
        return gdf, 0
    dentro = gdf.within(geom) | gdf.touches(geom)
    return gdf[dentro], int((~dentro).sum())


# ── conjuntos ──────────────────────────────────────────────────────────────────────────────────
def ler_manifesto(config, cid):
    try:
        with open(os.path.join(dir_conjunto(config, cid), 'manifesto.json'), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError, PoiErro):
        return None


def hash_conjunto(arquivos):
    """sha256 do conjunto: dos sha256 de cada arquivo, em ordem de nome."""
    h = hashlib.sha256()
    for k in sorted(arquivos):
        h.update(f'{k}:{arquivos[k]}\n'.encode())
    return h.hexdigest()


def contar(gdf):
    return {k: int(v) for k, v in categorias_de(gdf).value_counts().items()}


def gravar(config, cid, por_area, manifesto):
    """Grava os arquivos e o manifesto. por_area: {area: GeoDataFrame no esquema comum}."""
    d = dir_conjunto(config, cid)
    os.makedirs(d, exist_ok=True)
    arquivos, contagem = {}, {}
    for area, g in sorted(por_area.items()):
        p = os.path.join(d, f'pois_{area}.geojson')
        g = g.copy()
        for c in COLS:
            if c in g.columns:
                g[c] = g[c].astype(object).where(g[c].notna(), None)
        g.to_crs(4326).to_file(p, driver='GeoJSON')
        arquivos[os.path.basename(p)] = sha256(p)
        contagem[area] = contar(g)
    manifesto = {**manifesto, 'id': cid, 'arquivos': arquivos, 'contagem': contagem, 'hash': hash_conjunto(arquivos),
                 'total': int(sum(sum(c.values()) for c in contagem.values()))}
    with open(os.path.join(d, 'manifesto.json'), 'w', encoding='utf-8') as f:
        json.dump(manifesto, f, ensure_ascii=False, indent=1)
    return manifesto


def ler_normalizado(config, cid, area):
    """Pontos de uma área de um conjunto no esquema comum (o da dissertação é convertido na hora)."""
    import geopandas as gpd
    if cid == ID_DISSERTACAO:
        p = caminho_pois(config, area, dir_conjunto_=config.DIR_POIS)
    else:
        p = os.path.join(dir_conjunto(config, cid), f'pois_{area}.geojson')
    if not os.path.exists(p):
        return None
    g = gpd.read_file(p).to_crs(4326)
    if 'categoria' in g.columns:
        for c in COLS:
            if c not in g.columns:
                g[c] = None
        return g[COLS + ['geometry']]
    return normalizar(g, categorias_de(g), g['name'] if 'name' in g.columns else None, fonte=cid)


def info(config, dir_conjunto_=None):
    """Registro do conjunto em uso (vai para o registro da previsão e do replay)."""
    d = dir_conjunto_ or getattr(config, 'POI_SET_DIR', None)
    if not d:
        m = None
        try:
            with open(os.path.join(dir_conjuntos(config), ID_DISSERTACAO, 'manifesto.json'), encoding='utf-8') as f:
                m = json.load(f)
        except (OSError, ValueError):
            pass
        return {'id': ID_DISSERTACAO, 'origem': 'dissertacao', 'criado_em': (m or {}).get('criado_em'), 'hash': (m or {}).get('hash')}
    try:
        with open(os.path.join(d, 'manifesto.json'), encoding='utf-8') as f:
            m = json.load(f)
    except (OSError, ValueError):
        m = {}
    return {'id': m.get('id') or os.path.basename(d), 'origem': m.get('origem'), 'criado_em': m.get('criado_em'),
            'hash': m.get('hash'), 'nome': m.get('nome')}


def _novo_id(origem):
    return f"{origem}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"


def _base_para_juntar(config, base, area):
    if not base:
        return None
    g = ler_normalizado(config, base, area)
    if g is not None and len(g):
        g = g.copy()
        g['fonte'] = g['fonte'].fillna(base)
    return g


# ── download do OpenStreetMap ──────────────────────────────────────────────────────────────────
def _tags(itens):
    tags = {}
    for it in itens:
        k, v = it['chave'], it['valor']
        if not re.fullmatch(r'[a-z_:]{1,40}', k) or not re.fullmatch(r'[\w*.:\-]{1,60}', v):
            raise PoiErro(f'Etiqueta inválida: {k}={v}')
        if v == '*':
            tags[k] = True
        elif tags.get(k) is not True:
            tags.setdefault(k, [])
            if v not in tags[k]:
                tags[k].append(v)
    return tags


def _categoria_osm(df, itens):
    import pandas as pd
    cat = pd.Series(None, index=df.index, dtype=object)
    for it in itens:  # a primeira etiqueta pedida que o ponto tem decide a categoria
        k, v = it['chave'], it['valor']
        if k not in df.columns:
            continue
        col = df[k]
        m = cat.isna() & col.notna() & (col.astype(str) != '') & ((col.astype(str) == v) if v != '*' else True)
        cat[m] = k + ':' + col[m].astype(str)
    return cat


def baixar_osm(spec, config, events):
    """spec: {itens: [{chave, valor}], areas: [..] | null, dedup_m, juntarCom, nome, timeout}"""
    itens = spec.get('itens') or []
    if not itens:
        raise PoiErro('Escolha ao menos uma categoria.')
    tags = _tags(itens)
    try:
        import osmnx as ox
    except Exception:  # noqa: BLE001
        raise PoiErro('O pacote osmnx não está instalado. Abra a tela Ambiente e use "Preparar ambiente".')
    try:
        import requests
        requests.get(ox.settings.overpass_url.rstrip('/') + '/status', timeout=10)
    except Exception as e:  # noqa: BLE001
        raise PoiErro(f'Sem acesso ao OpenStreetMap ({type(e).__name__}). Confira a internet e tente de novo; '
                      'os conjuntos que já estão no app continuam funcionando sem internet.')
    ox.settings.requests_timeout = int(spec.get('timeout') or 180)
    ox.settings.use_cache = True
    ox.settings.cache_folder = os.path.join(config.DIR_POIS, '_cache_osm')
    areas = spec.get('areas') or areas_disponiveis(config)
    cid = _novo_id('osm')
    dedup = float(spec.get('dedup_m', 25) or 0)
    events.emit('plan', job='pois', acao='osm', areas=areas, conjunto=cid, tags=tags)
    por_area, dups, fora, avisos = {}, {}, {}, []
    for k, area in enumerate(areas):
        events.progress('pois', k, len(areas), area=area, etapa='baixando')
        geom = contorno(config, area)
        print(f'\n=== {area}: OpenStreetMap ({", ".join(f"{a}={b}" for a, b in ((i["chave"], i["valor"]) for i in itens))}) ===')
        try:
            g = ox.features_from_polygon(geom, tags).reset_index()
        except Exception as e:  # noqa: BLE001 — área sem nenhum ponto também cai aqui (InsufficientResponseError)
            if 'InsufficientResponse' in type(e).__name__ or 'No matching features' in str(e):
                g = None
            else:
                raise PoiErro(f'{area}: o OpenStreetMap não respondeu ({type(e).__name__}: {str(e)[:200]}). '
                              'Tente de novo mais tarde; os downloads que já terminaram ficam no cache.')
        if g is None or not len(g):
            print('   nenhum ponto')
            avisos.append(f'{area}: nenhum ponto das categorias escolhidas.')
            continue
        g = g.set_crs(4326) if g.crs is None else g.to_crs(4326)
        cat = _categoria_osm(g, itens)
        g = g[cat.notna()]
        n = normalizar(g, cat[cat.notna()], g['name'] if 'name' in g.columns else None, fonte='osm')
        base = _base_para_juntar(config, spec.get('juntarCom'), area)
        if base is not None and len(base):
            import pandas as pd
            n = type(n)(pd.concat([base, n], ignore_index=True), crs=4326)
        n, fora[area] = recortar(n, geom)
        n, dups[area] = deduplicar(n, dedup)
        por_area[area] = n
        print(f'   {len(n)} pontos · {fora[area]} fora do contorno · {dups[area]} duplicados removidos')
        events.metric('pois', 'contagem', contar(n), area=area)
    if not por_area:
        raise PoiErro('Nenhum ponto encontrado nas áreas escolhidas.')
    import osmnx
    man = gravar(config, cid, por_area, {
        'nome': (spec.get('nome') or '').strip()[:80] or f"OpenStreetMap {datetime.now().strftime('%d/%m/%Y %H:%M')}",
        'origem': 'osm', 'status': 'rascunho', 'criado_em': datetime.now().isoformat(timespec='seconds'),
        'consulta': {'itens': itens, 'tags': tags, 'overpass': ox.settings.overpass_url, 'osmnx': getattr(osmnx, '__version__', None)},
        'baixado_em': datetime.now().isoformat(timespec='seconds'), 'aviso': AVISO_OSM,
        'juntado_com': spec.get('juntarCom') or None, 'dedup_m': dedup, 'duplicados_removidos': dups,
        'fora_do_contorno': fora, 'avisos': avisos,
    })
    events.metric('pois', 'conjunto', {'id': cid, 'nome': man['nome'], 'total': man['total'], 'contagem': man['contagem']})
    print(f'\n-> Conjunto {cid}: {man["total"]} pontos em {len(por_area)} área(s). Confira na tela e salve.')
    print(f'[AVISO] {AVISO_OSM}')
    return man


# ── importação de arquivo próprio ──────────────────────────────────────────────────────────────
def importar(spec, config, events):
    """spec: {arquivo, original, lat, lon, campoCategoria, mapa: {valor: categoria | '__ignorar__'},
    campoNome, campoAbertura, campoFechamento, dedup_m, juntarCom, areas, nome}"""
    import pandas as pd
    caminho = spec['arquivo']
    gdf, origem, ignoradas = ler_pontos(caminho, spec.get('lat'), spec.get('lon'))
    campo = spec.get('campoCategoria')
    if campo and campo not in gdf.columns:
        raise PoiErro(f'O campo "{campo}" não está no arquivo.')
    mapa = spec.get('mapa') or {}
    bruto = gdf[campo].astype(object) if campo else pd.Series(None, index=gdf.index, dtype=object)
    txt = bruto.where(bruto.notna(), '').astype(str).str.strip()

    def categoria(v):
        if v in mapa:
            return mapa[v]
        if not v:
            return mapa.get('', SEM_CATEGORIA)
        return 'arquivo:' + re.sub(r'\s+', '_', v.lower())[:50]
    cat = txt.map(categoria)
    manter = cat != '__ignorar__'
    gdf, cat = gdf[manter], cat[manter]
    col = lambda c: gdf[c] if c and c in gdf.columns else None  # noqa: E731
    n = normalizar(gdf, cat, col(spec.get('campoNome')), fonte='arquivo',
                   abertura=col(spec.get('campoAbertura')), fechamento=col(spec.get('campoFechamento')))
    areas = spec.get('areas') or areas_disponiveis(config)
    cid = _novo_id('arquivo')
    dedup = float(spec.get('dedup_m', 25) or 0)
    events.emit('plan', job='pois', acao='importar', areas=areas, conjunto=cid)
    por_area, dups, fora = {}, {}, {}
    for k, area in enumerate(areas):
        events.progress('pois', k, len(areas), area=area, etapa='recortando')
        geom = contorno(config, area)
        g, fora[area] = recortar(n, geom)
        base = _base_para_juntar(config, spec.get('juntarCom'), area)
        if base is not None and len(base):
            g = type(g)(pd.concat([base, g], ignore_index=True), crs=4326)
        g, dups[area] = deduplicar(g, dedup)
        if len(g):
            por_area[area] = g
            events.metric('pois', 'contagem', contar(g), area=area)
        print(f'   {area}: {len(g)} pontos · {dups[area]} duplicados removidos')
    if not por_area:
        raise PoiErro('Nenhum ponto do arquivo cai dentro das áreas escolhidas. Confira se as coordenadas estão em latitude e longitude (WGS84).')
    man = gravar(config, cid, por_area, {
        'nome': (spec.get('nome') or '').strip()[:80] or os.path.splitext(spec.get('original') or os.path.basename(caminho))[0],
        'origem': 'arquivo', 'status': 'rascunho', 'criado_em': datetime.now().isoformat(timespec='seconds'),
        'arquivo': {'nome': spec.get('original') or os.path.basename(caminho), 'copia': os.path.basename(caminho),
                    'sha256': sha256(caminho), 'crs': origem, 'linhas_sem_geometria': int(ignoradas)},
        'mapeamento': {'campoCategoria': campo, 'mapa': mapa, 'campoNome': spec.get('campoNome'),
                       'campoAbertura': spec.get('campoAbertura'), 'campoFechamento': spec.get('campoFechamento')},
        'com_datas': bool(spec.get('campoAbertura') or spec.get('campoFechamento')),
        'juntado_com': spec.get('juntarCom') or None, 'dedup_m': dedup, 'duplicados_removidos': dups,
        'fora_do_contorno': fora, 'ignorados_pelo_mapeamento': int((~manter).sum()),
    })
    events.metric('pois', 'conjunto', {'id': cid, 'nome': man['nome'], 'total': man['total'], 'contagem': man['contagem']})
    print(f'\n-> Conjunto {cid}: {man["total"]} pontos em {len(por_area)} área(s). Confira na tela e salve.')
    return man


def _main(argv):
    if len(argv) >= 2 and argv[0] == 'inspecionar':
        try:
            r = inspecionar(argv[1])
            print('@@POI ' + json.dumps({'ok': True, **r}, ensure_ascii=False, default=str))
        except Exception as e:  # noqa: BLE001
            msg = str(e) if isinstance(e, PoiErro) or type(e).__name__ == 'AreaErro' else f'Erro ao ler o arquivo: {str(e)[:300]}'
            print('@@POI ' + json.dumps({'ok': False, 'erro': msg}, ensure_ascii=False))
        return 0
    print('uso: python -m pipeline.pois.conjuntos inspecionar <arquivo>')
    return 2


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
