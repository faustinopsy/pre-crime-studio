import os
import pandas as pd
import numpy as np
import unicodedata
from pipeline import config
from pipeline.bridge import events

# Configuração de Caminhos
BASE_DIR = config.BASE_DIR
DATA_DADOS = config.DATA_SSP
DATA_RAW = config.DATA_RAW

# Garante que a pasta de saída existe
os.makedirs(DATA_RAW, exist_ok=True)

colunas_desejadas = [
    "ID_DELEGACIA",
    "NOME_DELEGACIA",
    "NOME_MUNICIPIO",
    "BAIRRO",
    "LOGRADOURO",
    "LATITUDE",
    "LONGITUDE",
    "ANO",
    "MES",
    "DATA_OCORRENCIA_BO",
    "HORA_OCORRENCIA",
    "DESCR_TIPO_VEICULO",
    "DESCR_OCORRENCIA_VEICULO",
]

saida_csv = os.path.join(DATA_RAW, "dados_unificados.csv")


def _norm(v):
    """Mesma regra do app (desktop/src/main/services/sspProfile.js → norm)."""
    s = unicodedata.normalize('NFKD', str(v if v is not None else ''))
    s = ''.join(c for c in s if not unicodedata.combining(c)).upper()
    s = '/'.join(p.strip() for p in s.split('/'))
    return ' '.join(s.split())


def _norm_series(col):
    uniq = col.dropna().unique()
    mapa = {u: _norm(u) for u in uniq}
    return col.map(mapa).fillna('')


_P = config.CLEAN_PARAMS
_MUNS = {_norm(x) for x in (_P.get('MUNICIPIOS') or ['S.PAULO'])}
# '*' = todas as cidades das planilhas (áreas do operador fora da capital; a Filtragem recorta pelo mapa)
_TODAS_CIDADES = '*' in _MUNS
_OCS = {_norm(x) for x in (_P.get('OCORRENCIAS') or ['FURTADO', 'ROUBADO'])}
_VES = None if _P.get('TIPOS_VEICULO') is None else {_norm(x) for x in _P['TIPOS_VEICULO']}
_DEDUP = bool(_P.get('REMOVER_DUPLICADOS', True))

# Parâmetros usados na última unificação, gravados ao lado do CSV. Se mudarem, a base é refeita.
params_json = os.path.join(DATA_RAW, "dados_unificados.parametros.json")


def _params_atuais():
    return {'municipios': sorted(_MUNS), 'ocorrencias': sorted(_OCS),
            'tipos_veiculo': None if _VES is None else sorted(_VES),
            'remover_duplicados': _DEDUP}


def _params_mudaram():
    import json
    try:
        with open(params_json, encoding='utf-8') as f:
            return json.load(f) != _params_atuais()
    except FileNotFoundError:
        # base antiga, sem registro: só conta como mudança se os parâmetros não forem os da pesquisa
        return _params_atuais() != {'municipios': ['S.PAULO'], 'ocorrencias': ['FURTADO', 'ROUBADO'],
                                    'tipos_veiculo': None, 'remover_duplicados': True}
    except Exception:
        return True

def run_step0(force=False):
    print("=== PASSO 0: UNIFICAÇÃO E LIMPEZA AVANÇADA DE DADOS ===")

    if os.path.exists(saida_csv) and not force and _params_mudaram():
        print("   [PARÂMETROS MUDARAM] A base unificada foi feita com outros parâmetros da Limpeza; refazendo.")
        force = True

    if os.path.exists(saida_csv):
        if force:
            arquivos_xlsx = [f for f in os.listdir(DATA_DADOS) if f.endswith(".xlsx")]
            if not arquivos_xlsx:
                print(f"   [AVISO] force=True ignorado: nenhum .xlsx em {DATA_DADOS}. Mantendo arquivo existente.")
                return
            print("   [FORCE] Refazendo a base unificada (a atual só é substituída no fim, se tudo der certo).")
        else:
            print(f"   [PULAR] Arquivo unificado já existe em: {saida_csv}")
            print("   Exclua este arquivo ou use force=True para reprocessar os dados brutos.")
            return

    try:
        _processar_xlsx()
    except Exception as e:
        print(f"   [ERRO CRÍTICO] Processamento falhou: {e}")
        print("   A base unificada anterior (se havia) não foi alterada.")
        raise


# ── Cache da leitura das planilhas ─────────────────────────────────────
# Ler um .xlsx da SSP leva de 30 s a 2 min; com 7 anos, a Limpeza relia tudo a cada planilha
# nova. A leitura bruta de cada arquivo (antes de qualquer filtro) fica guardada em
# dados_ssp/_cache/<sha256>.pkl: uma planilha nova (ou alterada) é lida do Excel; as outras
# vêm do cache, com os mesmos tipos de coluna. O resultado é o mesmo arquivo, byte a byte
# (conferido por sha256). config.INGEST_CACHE = False desliga.
_CACHE_VERSAO = 1
_CACHE_DIR = os.path.join(DATA_DADOS, '_cache')


def _sha256(caminho):
    import hashlib
    h = hashlib.sha256()
    with open(caminho, 'rb') as f:
        for bloco in iter(lambda: f.read(1 << 20), b''):
            h.update(bloco)
    return h.hexdigest()


def _cache_caminho(caminho_arq):
    return os.path.join(_CACHE_DIR, f"{_sha256(caminho_arq)}.v{_CACHE_VERSAO}.pkl")


def _cache_ler(caminho_arq):
    if not getattr(config, 'INGEST_CACHE', True):
        return None
    try:
        p = _cache_caminho(caminho_arq)
        if os.path.exists(p):
            df = pd.read_pickle(p)
            print(f"      -> Do cache (planilha não mudou): {len(df)} linhas")
            return df
    except Exception as e:
        print(f"      [AVISO] Cache ignorado ({e}); lendo a planilha.")
    return None


def _cache_gravar(caminho_arq, df):
    if not getattr(config, 'INGEST_CACHE', True):
        return
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        p = _cache_caminho(caminho_arq)
        tmp = p + '.tmp'
        df.to_pickle(tmp)
        os.replace(tmp, p)
    except Exception as e:
        print(f"      [AVISO] Não consegui gravar o cache da leitura ({e}).")


def _processar_xlsx():
    frames = []
    funil = {'lidos': 0, 'cidade': 0, 'ocorrencia': 0, 'veiculo': 0}
    print(f"-> Parâmetros: cidades={sorted(_MUNS)} ocorrências={sorted(_OCS)} "
          f"veículos={'todos' if _VES is None else sorted(_VES)} "
          f"remover repetidos={'sim' if _DEDUP else 'não'}")

    # 1. Leitura dos Arquivos Excel
    arquivos = [f for f in os.listdir(DATA_DADOS) if f.lower().endswith(".xlsx") and not f.startswith("~$")]

    if not arquivos:
        print(f"[ERRO] Nenhum arquivo .xlsx encontrado em {DATA_DADOS}")
        return

    print(f"-> Encontrados {len(arquivos)} arquivos. Iniciando leitura...")

    for i, arq in enumerate(sorted(arquivos), 1):
        print(f"   Lendo {arq} ...")
        events.progress('step1_ingest', i - 1, len(arquivos), arquivo=arq, etapa='lendo')
        caminho_arq = os.path.join(DATA_DADOS, arq)
        
        df = _cache_ler(caminho_arq)
        if df is None:
            try:
                xls = pd.ExcelFile(caminho_arq, engine="openpyxl")
                sheet_alvo = xls.sheet_names[0]
                for sheet in xls.sheet_names:
                    if "VEICULO" in sheet.upper() or "VEÍCULO" in sheet.upper(): sheet_alvo = sheet; break
                print(f"      -> Lendo aba: {sheet_alvo}")
                df = pd.read_excel(xls, sheet_name=sheet_alvo)
            except Exception as e:
                print(f"   [ERRO] Falha ao ler {arq}: {e}")
                continue
            _cache_gravar(caminho_arq, df)

        # Normaliza nomes de colunas (remove espaços extras que as vezes vem no Excel)
        df.columns = [str(c).strip() for c in df.columns]
        # 2020 e 2021 chamam a hora de HORA_OCORRENCIA_BO; sem isso a hora ficava vazia
        # e a remoção de repetidos juntava ocorrências diferentes do mesmo dia e lugar.
        if "HORA_OCORRENCIA" not in df.columns and "HORA_OCORRENCIA_BO" in df.columns:
            df = df.rename(columns={"HORA_OCORRENCIA_BO": "HORA_OCORRENCIA"})

        # Adiciona colunas ausentes como vazio
        for col in colunas_desejadas:
            if col not in df.columns:
                df[col] = None

        # Mantém só as colunas de interesse
        df = df[colunas_desejadas]

        # Filtros da Limpeza (config.CLEAN_PARAMS — editáveis no app)
        n_lidos = len(df)
        if not _TODAS_CIDADES:
            df = df[_norm_series(df["NOME_MUNICIPIO"]).isin(_MUNS)]
        n_cidade = len(df)
        df = df[_norm_series(df["DESCR_OCORRENCIA_VEICULO"]).isin(_OCS)]
        n_ocorr = len(df)
        if _VES is not None:
            df = df[_norm_series(df["DESCR_TIPO_VEICULO"]).isin(_VES)]
        df["NOME_MUNICIPIO"] = df["NOME_MUNICIPIO"].astype(str).str.upper().str.strip()
        print(f"      -> {n_lidos} linhas · cidade: {n_cidade} · ocorrência: {n_ocorr} · veículo: {len(df)}")
        funil['lidos'] += n_lidos; funil['cidade'] += n_cidade; funil['ocorrencia'] += n_ocorr; funil['veiculo'] += len(df)
        events.progress('step1_ingest', i, len(arquivos), arquivo=arq, etapa='lido')

        frames.append(df)

    # cache de planilhas que saíram da pasta (ou foram trocadas por versão nova): remove
    if getattr(config, 'INGEST_CACHE', True) and os.path.isdir(_CACHE_DIR):
        vivos = {os.path.basename(_cache_caminho(os.path.join(DATA_DADOS, a))) for a in arquivos}
        for f in os.listdir(_CACHE_DIR):
            if f.endswith('.pkl') and f not in vivos:
                try:
                    os.remove(os.path.join(_CACHE_DIR, f))
                except OSError:
                    pass

    # 2. Concatenação
    if not frames:
        print("[ERRO] Nenhum dado válido encontrado após leitura.")
        return

    print("-> Concatenando DataFrames...")
    events.progress('step1_ingest', len(arquivos), len(arquivos), etapa='juntando')
    df_final = pd.concat(frames, ignore_index=True)
    qtd_inicial = len(df_final)
    print(f"   Total de registros brutos: {qtd_inicial}")

    # 3. Limpeza e Normalização de Datas (A Correção Solicitada)
    print("-> Higienizando Datas e Removendo Ruído Histórico...")
    
    # Converte para Datetime (erros viram NaT)
    df_final['DATA_OCORRENCIA_BO'] = pd.to_datetime(df_final['DATA_OCORRENCIA_BO'], errors='coerce')
    
    # Remove linhas onde a data é inválida
    df_final = df_final.dropna(subset=['DATA_OCORRENCIA_BO'])
    
    # Sem corte de período aqui: a base unificada guarda todos os meses das planilhas.
    # O período usado pelos modelos (DATE_START_DATA / DATA_END) é aplicado no ETL e no treino.

    # Sincroniza ANO e MES com a DATA real (Corrige a inconsistência apontada)
    df_final['ANO'] = df_final['DATA_OCORRENCIA_BO'].dt.year
    df_final['MES'] = df_final['DATA_OCORRENCIA_BO'].dt.month

    qtd_pos_data = len(df_final)
    print(f"   Registros com data válida: {qtd_pos_data} (Removidos: {qtd_inicial - qtd_pos_data})")

    # 4. Deduplicação (Remoção de Duplicatas)
    print("-> Removendo Duplicatas...")
    events.progress('step1_ingest', len(arquivos), len(arquivos), etapa='repetidos')
    
    # Sem coordenada não há como pôr o registro num grid
    df_final = df_final.dropna(subset=['LATITUDE', 'LONGITUDE'])
    qtd_coord = len(df_final)

    if _DEDUP:
        # Linhas exatas repetidas e B.O. reemitido (mesmo local, data, hora e veículo)
        df_final = df_final.drop_duplicates()
        subset_dedup = ['LATITUDE', 'LONGITUDE', 'DATA_OCORRENCIA_BO', 'HORA_OCORRENCIA', 'DESCR_TIPO_VEICULO']
        df_final = df_final.drop_duplicates(subset=subset_dedup)

    qtd_final = len(df_final)
    print(f"   Registros finais: {qtd_final} (sem coordenada: {qtd_pos_data - qtd_coord} · repetidos: {qtd_coord - qtd_final})")
    for k, v in [*funil.items(), ('data_valida', qtd_pos_data), ('coordenadas', qtd_coord), ('final', qtd_final)]:
        events.metric('step1_ingest', f'funil_{k}', int(v))

    # 5. Salvar
    print(f"-> Salvando arquivo unificado...")
    events.progress('step1_ingest', len(arquivos), len(arquivos), etapa='salvando')
    # Grava num arquivo temporário e só então substitui a base: se a execução for
    # cancelada ou falhar no meio, a base anterior continua inteira.
    tmp_csv = saida_csv + ".tmp"
    try:
        df_final.to_csv(tmp_csv, index=False, encoding="utf-8-sig")
        os.replace(tmp_csv, saida_csv)
        import json
        with open(params_json, 'w', encoding='utf-8') as f:
            json.dump(_params_atuais(), f, ensure_ascii=False, indent=2)
        print(f"   [SUCESSO] Arquivo salvo em: {saida_csv}")
        # sobra da versão anterior deste passo, que fazia backup antes de processar
        if os.path.exists(saida_csv + ".bak"):
            os.remove(saida_csv + ".bak")
    except Exception as e:
        print(f"   [ERRO] Falha ao salvar arquivo: {e}")
        if os.path.exists(tmp_csv):
            os.remove(tmp_csv)
        raise

if __name__ == "__main__":
    run_step0()