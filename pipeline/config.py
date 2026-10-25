import copy as _copy
import json as _json
import os

# --- PADRÕES DA DISSERTAÇÃO ---
# Os valores que o operador pode mudar no app ficam num lugar só: padroes_dissertacao.json
# (ao lado deste arquivo). Este módulo e o app leem o mesmo arquivo; o que o operador muda
# chega por PRECRIME_CONFIG_OVERRIDES (fim deste arquivo) e o arquivo não muda.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'padroes_dissertacao.json'), encoding='utf-8') as _f:
    PADROES_DISSERTACAO = {k: v for k, v in _json.load(_f).items() if not k.startswith('_')}


def _padrao(chave):
    return _copy.deepcopy(PADROES_DISSERTACAO[chave])


# --- CAMINHOS BASE ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Pasta de dados: <repo>/data por padrão; PRECRIME_DATA_DIR aponta para outra
# (ex.: o app desktop usa a pasta de dados escolhida pelo operador).
DATA_DIR = os.path.abspath(os.environ.get('PRECRIME_DATA_DIR') or os.path.join(BASE_DIR, 'data'))
DATA_SSP = os.path.join(DATA_DIR, 'dados_ssp')
DATA_RAW = os.path.join(DATA_DIR, 'raw')
DATA_PROC = os.path.join(DATA_DIR, 'processed')

# --- SUBPASTAS DE ORGANIZAÇÃO (PIPELINE) ---
DIR_GRIDS = os.path.join(DATA_PROC, 'grids')
DIR_CRIMES = os.path.join(DATA_PROC, 'crimes')
DIR_DATASETS = os.path.join(DATA_PROC, 'datasets')
DIR_MODELS = os.path.join(DATA_PROC, 'models')
DIR_RESULTS = os.path.join(DATA_PROC, 'results')
DIR_RESULTS_3D = os.path.join(DATA_PROC, 'results_3d')
DIR_RESULTS_GEOJSON = os.path.join(DATA_PROC, 'results_geojson')
DIR_METRICS = os.path.join(DATA_PROC, 'metrics')
DIR_STREETS = os.path.join(DATA_DIR, 'streets')
DIR_POIS = os.path.join(DATA_DIR, 'pois')
PATH_BEST_PARAMS = os.path.join(DATA_PROC, 'best_params.json')
DIR_OPTIMIZATION_LOGS = os.path.join(DATA_PROC, 'optimization_logs')

# Cria todas as pastas estruturais de processed caso tenham sido removidas pelo usuário
for d in [DIR_GRIDS, DIR_CRIMES, DIR_DATASETS, DIR_MODELS, DIR_RESULTS, 
          DIR_RESULTS_3D, DIR_RESULTS_GEOJSON, DIR_METRICS, DIR_STREETS, 
          DIR_POIS, DIR_OPTIMIZATION_LOGS]:
    os.makedirs(d, exist_ok=True)

# --- LISTA DE ENTRADAS ---
# Uma área por malha em streets/grids_area_NN.geojson: as 8 da dissertação (copiadas de base/)
# e as que o operador cria no app a partir de um GeoJSON (area_12 em diante, ver pipeline/areas).
# Sem malhas em streets/, vale a lista da dissertação.
_GRIDS_DISSERTACAO = ['area_01', 'area_02', 'area_03', 'area_04', 'area_05', 'area_09', 'area_10', 'area_11']


def _input_grids():
    import glob
    malhas = sorted(os.path.basename(f)[len('grids_'):-len('.geojson')]
                    for f in glob.glob(os.path.join(DIR_STREETS, 'grids_area_*.geojson')))
    return [os.path.join(DIR_GRIDS, f'{a}.geojson') for a in (malhas or _GRIDS_DISSERTACAO)]


INPUT_GRIDS = _input_grids()

# --- ARQUIVOS DE DADOS ---
FILES = {
    'csv': os.path.join(DATA_RAW, 'dados_unificados.csv')
}

# --- REPRODUTIBILIDADE ---
# Seed global de todos os geradores aleatórios (random, numpy, torch, sklearn).
# Sobrescreva com a variável de ambiente PRECRIME_SEED para estudos de variância:
#   PRECRIME_SEED=43 python main.py --train --fast ...
GLOBAL_SEED = int(os.environ.get('PRECRIME_SEED', _padrao('GLOBAL_SEED')))

# --- CONFIGURAÇÕES GERAIS ---
CRS_LATLON = "EPSG:4326"
CRS_METRIC = "EPSG:31983"

# --- CONTROLE TEMPORAL (TREINO) ---
# Data mínima de início dos dados históricos usada para filtrar o dataset de treino.
# Evita contaminar os modelos com dados muito antigos (estrutura criminal diferente).
DATE_START_DATA = _padrao('DATE_START_DATA')   # "2020-01-01"

# --- LIMPEZA (step1_ingest) ---
# Quais registros das planilhas da SSP entram na base unificada. O app desktop envia estes
# valores por PRECRIME_CONFIG_OVERRIDES; sem o app, vale o padrão da pesquisa (capital,
# furto e roubo, todos os veículos). A base unificada guarda todos os meses: o período dos
# modelos é DATE_START_DATA / DATA_END, aplicado no ETL e no treino.
# Os textos são comparados normalizados (maiúsculas, sem acento, sem espaço em volta de "/"),
# porque a SSP muda a grafia entre anos ("Localizado/Entregue" x "Localizado / Entregue").
CLEAN_PARAMS = _padrao('CLEAN_PARAMS')
# MUNICIPIOS ['S.PAULO'] (malhas viárias só da capital; ['*'] = todas as cidades das planilhas)
# OCORRENCIAS ['FURTADO', 'ROUBADO'] (também: 'LOCALIZADO/ENTREGUE', recuperados)
# TIPOS_VEICULO None = todos; lista = só estes · REMOVER_DUPLICADOS True

# Cache da leitura das planilhas (dados_ssp/_cache/<sha256>.pkl): só a planilha nova ou
# alterada é lida do Excel. Não muda o resultado (mesmos dados e tipos); False desliga.
INGEST_CACHE = True

# --- FILTRAGEM (step2_filter_grids) ---
# As malhas em streets/grids_area_*.geojson trazem a mesma célula da grade de 200 m em
# mais de uma linha (inteira e/ou recortada pelos limites de batalhão e distrito): na
# área 01 são 2.764 linhas para 1.206 células. Cada crime nessas células é contado mais
# de uma vez. False mantém o comportamento usado na dissertação; True junta as linhas de
# cada célula numa só (união dos pedaços) e descarta linhas sem área.
FILTER_PARAMS = _padrao('FILTER_PARAMS')   # {'REMOVER_CELULAS_REPETIDAS': False}

# --- REPLAY PROSPECTIVO SEM VAZAMENTO ---
# PRECRIME_DATA_END=AAAA-MM-DD simula o que se sabia nessa data:
#   ETL     -> descarta ocorrências posteriores a DATA_END;
#   features-> mantém as linhas mais recentes (alvo ainda desconhecido) para a previsão;
#   treino  -> usa só linhas cujo alvo de 4 semanas termina até DATA_END (embargo);
#   predict -> usa a linha mais recente de cada célula, replicada nas semanas do mês-alvo.
# Sem a variável, o pipeline se comporta como antes.
DATA_END = os.environ.get('PRECRIME_DATA_END') or None

# --- PREVISÃO OPERACIONAL ---
# Data de referência para a previsão.
# Por padrão, calcula dinamicamente o 1º dia do próximo mês calendário,
# garantindo que o pipeline nunca use uma data hardcoded desatualizada.
# Sobrescrito automaticamente quando --month é passado via CLI.
def _default_forecast_date() -> str:
    """
    Retorna o 1º dia do próximo mês como string 'YYYY-MM-01'.
    Ex: se hoje é 20/04/2026, retorna '2026-05-01'.
    """
    from datetime import date
    today = date.today()
    if today.month == 12:
        return f"{today.year + 1}-01-01"
    return f"{today.year}-{today.month + 1:02d}-01"

FORECAST_DATE = _default_forecast_date()

# Tag derivada automaticamente: "2025_04" — usada em todos os filenames de saída.
# Isso permite que múltiplas previsões de meses diferentes coexistam em disco.
def get_forecast_tag(date_str=None):
    """Retorna tag YYYY_MM para o date_str (ou FORECAST_DATE se omitido)."""
    from datetime import datetime
    d = datetime.strptime(date_str or FORECAST_DATE, "%Y-%m-%d")
    return f"{d.year}_{d.month:02d}"

FORECAST_TAG = get_forecast_tag()   # ex: "2026_05" (dinâmico)

# --- ÁREA DE COBERTURA (quanto do mapa vira alto e médio risco) ---
# Fração das células marcadas como alto risco (área de patrulha) e como alto + médio risco.
# Uma fonte só: as quatro chaves abaixo (HOTSPOT_QUANTILE, METRICS_THRESHOLDS
# HIGH/MEDIUM_RISK_QUANTILE e VISUALIZATION_CONFIG GEOJSON_MEDIUM_QUANTILE) são derivadas
# daqui, para o mapa, a previsão e a validação medirem a mesma coisa. Dissertação: 10% e 20%.
COBERTURA = _padrao('COBERTURA')

# Regra de corte do alto risco:
#   'maior_igual' (dissertação): risco >= quantil. Com muitas células empatadas no valor do
#                 quantil, a área marcada passa (às vezes muito) do valor escolhido.
#   'top_exato':  exatamente ceil(fração × células), desempate aleatório com GLOBAL_SEED.
CORTE = _padrao('CORTE')

# --- DEFINIÇÃO DE CRITÉRIOS DE AVALIAÇÃO (MÉTRICAS) ---
# HIGH_RISK_QUANTILE / MEDIUM_RISK_QUANTILE: derivados de COBERTURA (1 - fração).
# CONFUSION_MATRIX_MODE 'HIGH_ONLY': só o alto risco conta como previsão positiva no
#   F1/precisão/recall; 'HIGH_AND_MEDIUM': alto + médio.
# REAL_CRIME_THRESHOLD 0: célula com mais de 0 crimes conta como positiva.
# ABSOLUTE_MIN_PROB 0.01: piso do corte (células abaixo nunca são alto risco).
# DYNAMIC_THRESHOLD False: True escolhe, por área, o corte que maximiza o F1 olhando os
#   crimes reais do próprio mês avaliado (infla as métricas; não serve para avaliar modelo).
# HIGH_RISK_SEARCH_RANGE (0.70, 0.99, 30): busca do DYNAMIC_THRESHOLD.
METRICS_THRESHOLDS = _padrao('METRICS_THRESHOLDS')


# --- MODELAGEM CIENTÍFICA ---
LAG_WEEKS = 24          
FORECAST_HORIZON = 4    
HOTSPOT_QUANTILE = 0.90   # derivado de COBERTURA['ALTO'] (ver _derivar_cobertura)

# --- CONFIGURAÇÃO DO ENSEMBLE (STEP 5) ---
# MODEL_WEIGHTS {'RF': 0.1, 'LSTM': 0.5, 'Transformer': 0.4}: peso de cada modelo na média
#   ponderada (renormalizada entre os modelos presentes). Peso 0 tira o modelo do Ensemble
#   (da média e do máximo).
# HYBRID_FORMULA MEAN_WEIGHT 0.7 / MAX_WEIGHT 0.3: risco = 0,7 × média + 0,3 × máximo.
# COMBINACAO 'probabilidades' (dissertação) | 'postos': usa o posto (percentil) de cada
#   célula em cada modelo no lugar da probabilidade.
# POI_BOOST_FACTOR 0.15: risco × (1 + 0,15 × escore de POI); 0 desliga.
# POI_WEIGHTS: peso por tipo de POI. Chaves 'bar' (= 'amenity:bar'), 'amenity:<tipo>',
#   'shop:<tipo>' e '_padrao' (tipos não listados, 1.0).
# POI_NORMALIZACAO 'com_poi' (dissertação): MinMax só entre as células com POI (célula sem
#   POI = 0); 'todas': MinMax com todas as células (sem POI = soma 0), o que deixa as
#   células com delegacia abaixo das células sem POI.
# MIN_HISTORICAL_CRIMES 1: células com até 1 crime no histórico do dataset são zeradas;
#   None desliga o filtro.
# TEMPORAL_SMOOTHING: desligada na configuração final (ENABLED False). Ligada com EIXO
#   'grids', reproduz a variante das simulações iniciais, em que a média móvel (WINDOW 2,
#   ALPHA 0.7) corre entre células de numeração vizinha (GRID_ID), e não entre semanas;
#   'semanas' faz a média entre semanas consecutivas da mesma célula.
ENSEMBLE_CONFIG = _padrao('ENSEMBLE_CONFIG')

# --- CONJUNTO DE PONTOS DE INTERESSE ---
# Sem override, o Ensemble lê pois/pois_<área>.geojson (os POIs da dissertação). O app manda
# POI_SET_DIR = pois/conjuntos/<id> quando o operador ativa outro conjunto (OpenStreetMap novo ou
# arquivo próprio) e POI_SET = {id, origem, criado_em, hash} para o registro (pipeline/pois/conjuntos.py).
POI_SET_DIR = None
POI_SET = None

# --- CONFIGURAÇÃO VISUAL (STEP 5, 6, 8) ---
VISUALIZATION_CONFIG = {
    # === CLASSIFICAÇÃO DE RISCO (GeoJSON / Mapa) ===
    # Quantil para o corte do risco MÉDIO (Amarelo) na visualização
    # Derivado de COBERTURA['MEDIO'] (o mesmo corte da validação)
    'GEOJSON_MEDIUM_QUANTILE': 0.80,

    # Piso de score para nunca classificar como Risco (evita falsos alarmes em zeros)
    # Grids com score abaixo deste valor aparecem como "BAIXO" (transparente)
    'SCORE_MIN_THRESHOLD': 0.01,

    # === OPACIDADE DOS POLÍGONOS ===
    # Opacidade mínima (usada no início de cada faixa de risco)
    'OPACITY_MIN': 0.30,
    # Opacidade máxima (usada no topo de cada faixa de risco)
    'OPACITY_MAX': 0.99,

    # === PROTEÇÃO NUMÉRICA ===
    # Denominador mínimo para evitar divisão por zero no cálculo de opacidade
    # (quando q_high == q_med, a distribuição está achatada)
    'ZERO_DIVISION_GUARD': 0.0001,
}

# --- VALIDAÇÃO (Walk-Forward) ---
VALIDATION_START_YEAR = 2022
VALIDATION_STEP_MONTHS = 3

# --- FEATURES ESPACIAIS (step2_matrix.py) ---
# Ativa/desativa features de crimes em grids vizinhos (adjacência Queen)
# True  → Adiciona neigh_crime_sum e neigh_crime_max ao dataset
#         Melhora TP capturando deslocamento espacial de crimes
#         Custo: +30s de processamento por área (sjoin de adjacência)
# False → Desativa (usar se houver erros de memória ou geometria)
ENABLE_SPATIAL_FEATURES = True

# --- HIPERPARÂMETROS DOS MODELOS ---
# Valores escolhidos por busca em grade (Random Forest: validação cruzada temporal com três
# dobras no período de treino; LSTM e Transformer: validação no mês seguinte ao treino),
# com o F1-Score da classe positiva como critério. São os valores usados no artigo.
# RF: n_estimators 150, max_depth 20 (min_samples_split 2, min_samples_leaf 1, o padrão do
#     scikit-learn); LSTM: hidden_dim 64, 1 camada, dropout 0.2, lr 0.001, 10 épocas, lote 2048,
#     pos_weight 10; Transformer: embed 32, 2 cabeças, ff 32, 1 camada, dropout 0.1, lr 0.001,
#     5 épocas, lote 2048, pos_weight 10.
ML_CONFIG = _padrao('ML_CONFIG')


# --- OVERRIDES (app desktop) ---
# PRECRIME_CONFIG_OVERRIDES='{"METRICS_THRESHOLDS": {"HIGH_RISK_QUANTILE": 0.95}}'
# Faz merge profundo sobre os valores acima. Os valores deste arquivo continuam
# sendo o padrão; o app registra no manifesto da execução qualquer override usado.
def _apply_overrides():
    import json
    raw = os.environ.get('PRECRIME_CONFIG_OVERRIDES')
    if not raw:
        return {}
    try:
        ov = json.loads(raw)
    except Exception as e:
        print(f"[AVISO] PRECRIME_CONFIG_OVERRIDES ignorado (JSON inválido): {e}")
        return {}

    def merge(dst, src):
        for k, v in src.items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict):
                merge(dst[k], v)
            else:
                dst[k] = v

    g = globals()
    for name, value in ov.items():
        if not name.isupper() or name not in g:
            print(f"[AVISO] Override desconhecido ignorado: {name}")
            continue
        if isinstance(value, dict) and isinstance(g[name], dict):
            merge(g[name], value)
        else:
            g[name] = value
    return ov


def _derivar_cobertura():
    """As quatro chaves de corte saem de COBERTURA (com o padrão: 0.90 e 0.80, como antes)."""
    global HOTSPOT_QUANTILE
    alto = float(COBERTURA.get('ALTO', 0.10))
    medio = float(COBERTURA.get('MEDIO', 0.20))
    if not 0 < alto < 1:
        print(f"[AVISO] COBERTURA['ALTO'] inválida ({alto}); usando 0.10.")
        alto = 0.10
    if not alto < medio < 1:
        print(f"[AVISO] COBERTURA['MEDIO'] precisa ser maior que o alto risco ({medio}); usando {min(0.99, alto * 2):.2f}.")
        medio = min(0.99, alto * 2)
    HOTSPOT_QUANTILE = round(1 - alto, 6)
    METRICS_THRESHOLDS['HIGH_RISK_QUANTILE'] = HOTSPOT_QUANTILE
    METRICS_THRESHOLDS['MEDIUM_RISK_QUANTILE'] = round(1 - medio, 6)
    VISUALIZATION_CONFIG['GEOJSON_MEDIUM_QUANTILE'] = round(1 - medio, 6)


_derivar_cobertura()
CONFIG_OVERRIDES = _apply_overrides()
if 'COBERTURA' in CONFIG_OVERRIDES:
    _derivar_cobertura()
if CORTE not in ('maior_igual', 'top_exato'):
    print(f"[AVISO] CORTE desconhecido ({CORTE}); usando 'maior_igual'.")
    CORTE = 'maior_igual'


def diferencas_do_padrao(chaves=('ML_CONFIG', 'ENSEMBLE_CONFIG', 'COBERTURA', 'CORTE', 'METRICS_THRESHOLDS',
                                 'FILTER_PARAMS', 'DATE_START_DATA')):
    """O que está diferente do padrão da dissertação nesta execução: {'ENSEMBLE_CONFIG.POI_BOOST_FACTOR': [atual, padrão]}.
    Vai para o registro das previsões e das validações (as telas mostram "configuração personalizada")."""
    g = globals()
    out = {}

    def cmp(nome, atual, padrao):
        if isinstance(padrao, dict) and isinstance(atual, dict):
            for k in sorted(set(padrao) | set(atual)):
                if k in ('HIGH_RISK_QUANTILE', 'MEDIUM_RISK_QUANTILE', 'n_jobs', 'random_state'):
                    continue
                cmp(f'{nome}.{k}', atual.get(k), padrao.get(k))
        elif isinstance(padrao, (list, tuple)) and isinstance(atual, (list, tuple)):
            if list(atual) != list(padrao):
                out[nome] = [list(atual), list(padrao)]
        elif atual != padrao and not (isinstance(atual, (int, float)) and isinstance(padrao, (int, float))
                                      and not isinstance(atual, bool) and abs(float(atual) - float(padrao)) < 1e-12):
            out[nome] = [atual, padrao]

    for c in chaves:
        if c in PADROES_DISSERTACAO and c in g:
            cmp(c, g[c], PADROES_DISSERTACAO[c])
    if 'ENSEMBLE_CONFIG' in chaves and POI_SET_DIR:
        out['POI_SET'] = [(POI_SET or {}).get('id') or os.path.basename(str(POI_SET_DIR).rstrip('/\\')), 'dissertacao']
    return out
