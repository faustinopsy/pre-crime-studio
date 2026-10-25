"""
Executa uma fase do pipeline a pedido do app desktop.

    python -u -m pipeline.bridge.run clean

O app define antes, no ambiente do processo:
    PRECRIME_DATA_DIR          pasta de trabalho
    PRECRIME_CONFIG_OVERRIDES  parâmetros escolhidos nas telas (JSON)
    PRECRIME_EVENTS=1          liga os eventos @@PC no stdout

Faz o mesmo que main.py faria para a fase, com três diferenças:
  * a Limpeza é sempre refeita (force=True): o operador pediu para executar;
  * confere se a saída esperada foi gravada nesta execução;
  * erros viram um evento "error" com uma dica em português para o operador.
"""
import os
import re
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

from pipeline.bridge import events  # noqa: E402


def _vigiar_pai():
    """Encerra este processo se o processo que o abriu (o app, ou o run.py no caso dos
    processos de treino) deixar de existir. Evita treino órfão rodando depois que o app
    foi fechado à força."""
    import threading
    try:
        import psutil
        pai = psutil.Process(os.getpid()).parent()
    except Exception:
        return
    if pai is None:
        return

    def loop():
        while True:
            time.sleep(5)
            try:
                vivo = pai.is_running() and pai.status() != psutil.STATUS_ZOMBIE
            except Exception:
                vivo = False
            if not vivo:
                os._exit(130)
    threading.Thread(target=loop, daemon=True, name='vigia-pai').start()


class JobError(Exception):
    """Falha esperada, com mensagem para o operador."""


def _versoes():
    """Versões do Python e dos pacotes que esta execução usa (vão para o manifesto)."""
    import platform
    from importlib import metadata
    out = {'python': platform.python_version()}
    for nome in ('numpy', 'pandas', 'scikit-learn', 'scipy', 'geopandas', 'shapely', 'pyogrio', 'torch'):
        try:
            out[nome] = metadata.version(nome)
        except Exception:
            out[nome] = None
    return out


def _usa_gpu():
    try:
        import torch
        g = bool(torch.cuda.is_available())
        events.metric('ambiente', 'gpu', g)
        if g:
            events.metric('ambiente', 'placa', torch.cuda.get_device_name(0))
        return g
    except Exception:
        return False


def _fresh(path, t0):
    return os.path.exists(path) and os.path.getmtime(path) >= t0 - 1


def job_clean():
    from pipeline import config
    from pipeline.dataset import step1_ingest
    from pipeline.helpers.resource_monitor import ResourceMonitor

    xlsx = [f for f in os.listdir(config.DATA_SSP) if f.lower().endswith('.xlsx') and not f.startswith('~$')] \
        if os.path.isdir(config.DATA_SSP) else []
    if not xlsx:
        raise JobError('Nenhuma planilha .xlsx em dados_ssp. Importe as planilhas da SSP primeiro.')
    t0 = time.time()
    with ResourceMonitor('Limpeza'):
        step1_ingest.run_step0(force=True)
    out = step1_ingest.saida_csv
    if not _fresh(out, t0):
        raise JobError('A base unificada não foi gravada. Veja as linhas de erro acima no log.')
    events.artifact('clean', out, kind='csv')
    events.artifact('clean', step1_ingest.params_json, kind='json')


def _areas_streets(config, area):
    """Áreas que têm malha em streets/ e estão na lista do ETL (config.INPUT_GRIDS)."""
    import glob
    malha = sorted(os.path.basename(f)[len('grids_'):-len('.geojson')]
                   for f in glob.glob(os.path.join(config.DIR_STREETS, 'grids_area_*.geojson')))
    etl = {os.path.splitext(os.path.basename(p))[0] for p in config.INPUT_GRIDS}
    areas = [a for a in malha if a in etl]
    if area:
        if area not in areas:
            raise JobError(f'A área {area} não tem malha na pasta streets.')
        areas = [area]
    return areas


def job_filter(area=None):
    from pipeline import config
    from pipeline.dataset import step2_filter_grids, step2_etl
    from pipeline.helpers.resource_monitor import ResourceMonitor

    if not os.path.exists(config.FILES['csv']):
        raise JobError('A base unificada não existe. Rode a Limpeza antes.')
    areas = _areas_streets(config, area)
    if not areas:
        raise JobError('Nenhuma malha de área em streets. Feche e abra o app para ele copiar as malhas.')
    t0 = time.time()
    with ResourceMonitor('Filtragem'):
        step2_filter_grids.run_step1_5(target_area=area)
        step2_etl.run_step1(target_area=area)
    falhas = []
    for a in areas:
        grid = os.path.join(config.DIR_GRIDS, f'{a}.geojson')
        crimes = os.path.join(config.DIR_CRIMES, f'crimes_{a}.csv')
        if _fresh(grid, t0) and _fresh(crimes, t0):
            events.artifact('filter', grid, kind='geojson')
            events.artifact('filter', crimes, kind='csv')
        else:
            falhas.append(a)
    if falhas:
        raise JobError(f"Não gerou a saída de: {', '.join(falhas)}. Veja o log.")


def job_features(area=None):
    from pipeline import config
    from pipeline.dataset import step3_features
    from pipeline.helpers.resource_monitor import ResourceMonitor

    import glob
    disponiveis = sorted(os.path.basename(f)[len('crimes_'):-len('.csv')]
                         for f in glob.glob(os.path.join(config.DIR_CRIMES, 'crimes_area_*.csv')))
    if not disponiveis:
        raise JobError('Ainda não há crimes por área. Rode a Filtragem antes.')
    areas = [area] if area else disponiveis
    if area and area not in disponiveis:
        raise JobError(f'A área {area} ainda não passou pela Filtragem.')
    print(f"-> Período do dataset: {config.DATE_START_DATA} até {getattr(config, 'DATA_END', None) or 'o último dado'}")
    t0 = time.time()
    with ResourceMonitor('Features'):
        step3_features.run_step2(target_area=area)
    falhas = []
    for a in areas:
        out = os.path.join(config.DIR_DATASETS, f'dataset_full_{a}.csv')
        if _fresh(out, t0):
            events.artifact('features', out, kind='csv')
        else:
            falhas.append(a)
    if falhas:
        raise JobError(f"Não gerou o dataset de: {', '.join(falhas)}. Veja o log.")


# ── Treino ───────────────────────────────────────────────────────────────────
MODELOS = {
    'rf': ('RF', 'pipeline.train.train_rf', 'rf_{a}.pkl'),
    'lstm': ('LSTM', 'pipeline.train.train_lstm', 'lstm_{a}.pth'),
    'transformer': ('Transformer', 'pipeline.train.train_transformer', 'transformer_{a}.pth'),
}


def _treinar_modelo(modulo, area, fast):
    """Alvo dos processos de treino (precisa ser uma função de módulo para o 'spawn')."""
    import importlib
    _vigiar_pai()
    importlib.import_module(modulo).run_step3(target_area=area, fast_training=fast)


def job_train(area=None, fast=True, modo='paralelo', modelos=('rf', 'lstm', 'transformer')):
    import glob
    import importlib
    import multiprocessing
    from pipeline import config
    from pipeline.helpers.resource_monitor import ResourceMonitor

    disponiveis = sorted(os.path.basename(f)[len('dataset_full_'):-len('.csv')]
                         for f in glob.glob(os.path.join(config.DIR_DATASETS, 'dataset_full_area_*.csv')))
    if not disponiveis:
        raise JobError('Ainda não há datasets. Rode as Features antes.')
    if area and area not in disponiveis:
        raise JobError(f'A área {area} ainda não tem dataset. Rode as Features dela antes.')
    areas = [area] if area else disponiveis
    modelos = [m for m in modelos if m in MODELOS]
    if not modelos:
        raise JobError('Escolha ao menos um modelo.')
    tf = config.ML_CONFIG.get('Transformer') or {}
    if 'transformer' in modelos and int(tf.get('embed_dim', 1)) % max(1, int(tf.get('num_heads', 1))):
        raise JobError(f"Transformer: o tamanho do embedding ({tf.get('embed_dim')}) precisa ser divisível "
                       f"pelo número de cabeças de atenção ({tf.get('num_heads')}). Ajuste na tela Treino.")
    mudados = {m: v for m, v in ((config.CONFIG_OVERRIDES or {}).get('ML_CONFIG') or {}).items() if v}
    if mudados:
        print('-> Parâmetros diferentes dos recomendados: ' +
              '; '.join(f"{m}: " + ', '.join(f'{k}={v}' for k, v in d.items()) for m, d in mudados.items()))
    if any(m != 'rf' for m in modelos):
        try:
            import torch
            dev = f"placa de vídeo ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else 'processador'
        except Exception:
            raise JobError('O PyTorch não está instalado. Abra a tela Ambiente e use "Preparar ambiente".')
        _usa_gpu()
        print(f"-> LSTM e Transformer vão usar: {dev}")
    events.emit('plan', job='train', areas=areas, modelos=[MODELOS[m][0] for m in modelos],
                fast=bool(fast), modo=modo, config={MODELOS[m][0]: config.ML_CONFIG.get(MODELOS[m][0]) for m in modelos})
    print(f"-> Treino {'rápido' if fast else 'completo (com validação cruzada temporal)'} · "
          f"{'modelos em paralelo' if modo == 'paralelo' else 'um modelo por vez'} · áreas: {', '.join(areas)}")

    t0 = time.time()
    with ResourceMonitor('Treino'):
        if modo == 'paralelo' and len(modelos) > 1:
            # 'spawn' é obrigatório com CUDA (mesmo motivo do main.py)
            ctx = multiprocessing.get_context('spawn')
            procs = [ctx.Process(target=_treinar_modelo, args=(MODELOS[m][1], area, fast), name=f'Treino_{MODELOS[m][0]}')
                     for m in modelos]
            for p in procs:
                p.start()
            for p in procs:
                p.join()
            ruins = [p.name for p in procs if p.exitcode != 0]
            if ruins:
                print(f"[ERRO] Processo(s) com erro: {', '.join(ruins)}")
        else:
            for m in modelos:
                importlib.import_module(MODELOS[m][1]).run_step3(target_area=area, fast_training=fast)
                import gc
                gc.collect()

    falhas = []
    for m in modelos:
        for a in areas:
            out = os.path.join(config.DIR_MODELS, MODELOS[m][2].format(a=a))
            if _fresh(out, t0):
                events.artifact('train', out, kind=MODELOS[m][0])
                reg = os.path.join(config.DIR_MODELS, f'params_{m}_{a}.json')
                if _fresh(reg, t0):
                    events.artifact('train', reg, kind='parametros')
            else:
                falhas.append(f'{MODELOS[m][0]} {a}')
    if falhas:
        raise JobError(f"Não gerou o modelo: {', '.join(falhas)}. Veja o log.")


# ── Previsão e Validação ─────────────────────────────────────────────────────
ARQ_MODELO = {'RF': ['rf_{a}.pkl'], 'LSTM': ['lstm_{a}.pth', 'scaler_lstm_{a}.pkl'],
              'Transformer': ['transformer_{a}.pth', 'scaler_transformer_{a}.pkl']}


def _mes(mes):
    """'2026-05' -> ('2026-05-01', '2026_05', segunda-feira da 1ª semana)."""
    import pandas as pd
    if not mes or not re.fullmatch(r'\d{4}-\d{2}', mes):
        raise JobError('Escolha o mês no formato AAAA-MM.')
    fd = f'{mes}-01'
    d = pd.to_datetime(fd)
    seg = d + pd.Timedelta(days=(7 - d.weekday()) % 7)
    return fd, mes.replace('-', '_'), seg


def _areas_com_dataset(config):
    import glob
    return sorted(os.path.basename(f)[len('dataset_full_'):-len('.csv')]
                  for f in glob.glob(os.path.join(config.DIR_DATASETS, 'dataset_full_area_*.csv')))


def _semanas_dataset(config, area):
    """Semanas do dataset da área e as que têm o alvo (crimes das 4 semanas seguintes) conhecido."""
    import pandas as pd
    df = pd.read_csv(os.path.join(config.DIR_DATASETS, f'dataset_full_{area}.csv'), usecols=['data', 'target_month'])
    df['data'] = pd.to_datetime(df['data'])
    todas = df['data'].drop_duplicates().sort_values()
    conhecidas = df.loc[df['target_month'].notna(), 'data'].drop_duplicates().sort_values()
    return todas, conhecidas


def _sidecar(config, area, tag):
    return os.path.join(config.DIR_RESULTS, f'previsao_{area}_{tag}.json')


def _registro_treino(config, modelo, area):
    import json
    try:
        with open(os.path.join(config.DIR_MODELS, f'params_{modelo.lower()}_{area}.json'), encoding='utf-8') as f:
            j = json.load(f)
        return {'data_end': j.get('data_end'), 'seed': j.get('seed'), 'treinado_em': j.get('treinado_em')}
    except (OSError, ValueError):
        return {'data_end': None, 'seed': None, 'treinado_em': None}


def _registro_pois(config, area):
    """Conjunto de pontos de interesse usado na previsão (id, origem, data, hash) e o sha256 do arquivo da área."""
    from pipeline.pois import conjuntos
    r = conjuntos.info(config)
    p = conjuntos.caminho_pois(config, area)
    r['arquivo'] = os.path.basename(p) if os.path.exists(p) else None
    r['arquivo_sha256'] = conjuntos.sha256(p) if os.path.exists(p) else None
    return r


def job_predict(area=None, mes=None, modelos=None):
    import gc
    import json
    import pandas as pd
    from datetime import datetime
    from pipeline import config
    from pipeline.predict import step4_predict, step5_ensemble, step6_geojson, step8_history
    from pipeline.helpers.resource_monitor import ResourceMonitor

    fd, tag, seg = _mes(mes)
    fim = seg + pd.Timedelta(weeks=config.FORECAST_HORIZON)
    disponiveis = _areas_com_dataset(config)
    if not disponiveis:
        raise JobError('Ainda não há datasets. Rode as Features e o Treino antes.')
    if area and area not in disponiveis:
        raise JobError(f'A área {area} ainda não tem dataset.')
    pedidas = [area] if area else disponiveis

    # --modelos: só estes (o replay usa só os modelos que treinou com DATA_END; um modelo
    # treinado antes, com todos os dados, vazaria o futuro para o Ensemble)
    pedidos = {'rf': 'RF', 'lstm': 'LSTM', 'transformer': 'Transformer'}
    so = {pedidos[m] for m in (modelos or []) if m in pedidos} or set(ARQ_MODELO)

    def modelos_de(a):
        return [m for m, arqs in ARQ_MODELO.items()
                if m in so and all(os.path.exists(os.path.join(config.DIR_MODELS, f.format(a=a))) for f in arqs)]

    areas = [a for a in pedidas if modelos_de(a)]
    for a in pedidas:
        if a not in areas:
            print(f'[AVISO] {a}: nenhum modelo treinado. Área pulada.')
            events.metric('predict', 'pulada', 'sem modelo treinado', area=a)
    if not areas:
        raise JobError('Nenhuma das áreas escolhidas tem modelo treinado. Rode o Treino antes.')
    if any(m != 'RF' for a in areas for m in modelos_de(a)):
        try:
            import torch
            dev = f"placa de vídeo ({torch.cuda.get_device_name(0)})" if torch.cuda.is_available() else 'processador'
            print(f'-> LSTM e Transformer vão usar: {dev}')
            _usa_gpu()
        except Exception:
            raise JobError('O PyTorch não está instalado. Abra a tela Ambiente e use "Preparar ambiente".')

    data_end = getattr(config, 'DATA_END', None)
    events.emit('plan', job='predict', areas=areas, mes=mes, tag=tag, semanas=config.FORECAST_HORIZON,
                inicio=str(seg.date()), data_end=data_end)
    print(f"-> Previsão de {mes[5:]}/{mes[:4]} ({config.FORECAST_HORIZON} semanas a partir de {seg.date()}) · áreas: {', '.join(areas)}")

    t0 = time.time()
    feitas = []
    with ResourceMonitor('Previsão'):
        for i, a in enumerate(areas):
            print(f'\n=== {a} ===')
            modelos = modelos_de(a)
            todas, conhecidas = _semanas_dataset(config, a)
            ultima = todas.max()
            na_janela = todas[(todas >= pd.Timestamp(fd)) & (todas < pd.Timestamp(fd) + pd.DateOffset(weeks=config.FORECAST_HORIZON))]
            if data_end:
                modo, base = 'replay', ultima
            elif len(na_janela):
                modo, base = 'retroativa', None
            else:
                modo, base = 'cega', ultima
            if modo == 'retroativa':
                print(f'[AVISO] {mes} já está no dataset (até {ultima.date()}): a previsão usa as semanas reais do mês '
                      'e os modelos treinados com elas. O acerto medido fica otimista.')
            elif base is not None and seg > base + pd.Timedelta(weeks=8):
                print(f'[AVISO] O último dado do dataset é de {base.date()}, {int((seg - base).days / 7)} semanas antes do mês previsto.')
            events.metric('predict', 'modo', modo, area=a)
            events.metric('predict', 'ultima_semana', str(ultima.date()), area=a)
            if base is not None:
                events.metric('predict', 'semana_base', str(base.date()), area=a)

            # resultados antigos de um modelo que não existe mais entrariam no Ensemble
            for m in ARQ_MODELO:
                velho = os.path.join(config.DIR_RESULTS, f'results_{m.lower()}_{a}_{tag}.csv')
                if m not in modelos and os.path.exists(velho):
                    destino = os.path.join(config.DIR_RESULTS, '_antigos')
                    os.makedirs(destino, exist_ok=True)
                    novo = os.path.join(destino, f'{os.path.basename(velho)[:-4]}.{int(os.path.getmtime(velho))}.csv')
                    os.replace(velho, novo)
                    print(f'[AVISO] {m} fora desta previsão em {a}: previsão antiga movida para {novo}')

            fn = {'RF': step4_predict.predict_rf_single_area, 'LSTM': step4_predict.predict_lstm_single_area,
                  'Transformer': step4_predict.predict_transformer_single_area}
            for j, m in enumerate(modelos):
                events.progress('predict', i, len(areas), area=a, etapa='modelos', modelo=m, sub=j, subtotal=len(modelos) + 3)
                fn[m](a, fd, tag)
                gc.collect()
            events.progress('predict', i, len(areas), area=a, etapa='ensemble', sub=len(modelos), subtotal=len(modelos) + 3)
            step5_ensemble.process_ensemble_area(a, forecast_date=fd, tag=tag)
            events.progress('predict', i, len(areas), area=a, etapa='mapa', sub=len(modelos) + 1, subtotal=len(modelos) + 3)
            step6_geojson.process_area_export(a, forecast_date=fd, tag=tag, generate_predictions=True)
            events.progress('predict', i, len(areas), area=a, etapa='historico', sub=len(modelos) + 2, subtotal=len(modelos) + 3)
            step8_history.generate_grid_history(a, forecast_date=fd)
            gc.collect()

            ens = os.path.join(config.DIR_RESULTS, f'results_ensemble_{a}_{tag}.csv')
            geo = os.path.join(config.DIR_RESULTS_GEOJSON, f'hotspots_Ensemble_{a}_{tag}.geojson')
            if not (_fresh(ens, t0) and _fresh(geo, t0)):
                print(f'[ERRO] {a}: o Ensemble não foi gravado.')
                continue
            df = pd.read_csv(ens, usecols=['GRID_ID', 'probabilidade_risco', 'predicao_top10'])
            ativas = int((df.groupby('GRID_ID')['probabilidade_risco'].max() > 0).sum())
            events.metric('predict', 'celulas', int(df['GRID_ID'].nunique()), area=a)
            events.metric('predict', 'celulas_ativas', ativas, area=a)
            events.metric('predict', 'hotspots', int(df.groupby('GRID_ID')['predicao_top10'].max().sum()), area=a)
            events.metric('predict', 'modelos', modelos, area=a)
            pers = config.diferencas_do_padrao()
            if pers:
                events.metric('predict', 'personalizado', pers, area=a)
            # registro do que gerou esta previsão (a Validação diz se o teste foi cego)
            with open(_sidecar(config, a, tag), 'w', encoding='utf-8') as f:
                json.dump({
                    'area': a, 'mes': mes, 'tag': tag, 'modo': modo,
                    'semana_base': str(base.date()) if base is not None else None,
                    'ultima_semana_dataset': str(ultima.date()),
                    'semanas_previstas': [str((seg + pd.Timedelta(weeks=k)).date()) for k in range(config.FORECAST_HORIZON)],
                    'data_end': data_end,
                    'modelos': {m: datetime.fromtimestamp(os.path.getmtime(os.path.join(config.DIR_MODELS, ARQ_MODELO[m][0].format(a=a)))).isoformat(timespec='seconds')
                                for m in modelos},
                    # data final e semente do treino de cada modelo (origem móvel: muda ao longo do replay)
                    'treino': {m: _registro_treino(config, m, a) for m in modelos},
                    'cobertura': dict(config.COBERTURA), 'corte': config.CORTE,
                    'ensemble_config': config.ENSEMBLE_CONFIG,
                    'pois': _registro_pois(config, a),
                    'personalizado': config.diferencas_do_padrao(),
                    'gerado_em': datetime.now().isoformat(timespec='seconds'),
                }, f, ensure_ascii=False, indent=1)
            for m in modelos + ['Ensemble']:
                p = os.path.join(config.DIR_RESULTS, f'results_{m.lower()}_{a}_{tag}.csv')
                if _fresh(p, t0):
                    events.artifact('predict', p, kind=m)
            events.artifact('predict', geo, kind='geojson')
            feitas.append(a)
    falhas = [a for a in areas if a not in feitas]
    if falhas:
        raise JobError(f"Não gerou a previsão de: {', '.join(falhas)}. Veja o log.")


def _comparacao_justa(config, area, tag, semanas):
    """Modelos e as duas linhas de base sem aprendizado, todos com o top exato da cobertura
    escolhida (padrão: 10%). A base é o que um analista faria sem IA: a média das 24 semanas
    anteriores ou a soma das últimas 4, calculadas dos crimes da Filtragem na 1ª semana prevista.
    Grava processed/metrics/linhas_base.csv."""
    import pandas as pd
    from pipeline.predict import gabarito
    from pipeline.science import metricas as M
    gab = gabarito.ler(area, tag)
    piv = gabarito._pivo(area)
    if gab is None or piv is None:
        return []
    w0 = pd.Timestamp(semanas[0])
    gab = gab[gab['data'].isin(semanas)]
    crimes = gab.groupby('GRID_ID')['target_month'].sum()
    full = piv.reindex(pd.date_range(piv.index.min(), max(w0, piv.index.max()), freq='W-MON'), fill_value=0)
    lag = lambda k: full.shift(k).loc[w0]
    scores = {'base_media24sem': pd.concat([lag(k) for k in range(1, 25)], axis=1).mean(axis=1),
              'base_ultimas4sem': sum(lag(k) for k in range(1, 5))}
    for m in M.PRINCIPAIS:
        f = os.path.join(config.DIR_RESULTS, f'results_{m}_{area}_{tag}.csv')
        if os.path.exists(f):
            r = pd.read_csv(f, usecols=['GRID_ID', 'data', 'probabilidade_risco'])
            r['data'] = pd.to_datetime(r['data'])
            r = r[r['data'].isin(semanas)]
            if len(r):
                scores[m] = r.groupby('GRID_ID')['probabilidade_risco'].mean()
    q = config.METRICS_THRESHOLDS['HIGH_RISK_QUANTILE']
    out = []
    for m, sc in scores.items():
        g = pd.DataFrame({'risk': sc}).join(crimes.rename('crimes'), how='inner').fillna(0)
        if g.empty or not g['crimes'].sum():
            continue
        g['y'] = (g['crimes'] > 0).astype(int)
        r = M.metricas(g, q, 'top_exato', config.GLOBAL_SEED)
        out.append({'modelo': M.NOMES.get(m, m), 'chave': m, 'base': m.startswith('base_'), 'pai': r['PAI'], 'f1': r['F1'],
                    'foco': r['HitRn'] * 100, 'hiten': r['HitEn'], 'precisao': r['Precisao'], 'recall': r['Recall'], 'q': q})
    if out:
        p = os.path.join(config.DIR_METRICS, 'linhas_base.csv')
        novo = pd.DataFrame([{'Tag': tag, 'Area': area, **{k: v for k, v in r.items() if k != 'chave'}} for r in out])
        if os.path.exists(p):
            velho = pd.read_csv(p)
            velho = velho[~((velho['Tag'].astype(str) == tag) & (velho['Area'] == area))]
            novo = pd.concat([velho, novo], ignore_index=True)
        novo.to_csv(p, index=False)
    return out


def job_validate(area=None, mes=None):
    import json
    import pandas as pd
    from pipeline import config
    from pipeline.predict import step6_geojson, step7_metrics, step7b_zhang
    from pipeline.helpers.resource_monitor import ResourceMonitor

    fd, tag, seg = _mes(mes)
    semanas = [seg + pd.Timedelta(weeks=k) for k in range(config.FORECAST_HORIZON)]
    import glob
    com_previsao = sorted(re.search(r'(area_\d{2})', os.path.basename(f)).group(1)
                          for f in glob.glob(os.path.join(config.DIR_RESULTS, f'results_ensemble_area_*_{tag}.csv')))
    if not com_previsao:
        raise JobError(f'Não há previsão de {mes[5:]}/{mes[:4]}. Gere a previsão desse mês antes de validar.')
    if area and area not in com_previsao:
        raise JobError(f'A área {area} não tem previsão de {mes[5:]}/{mes[:4]}.')
    if not os.path.exists(config.FILES['csv']):
        raise JobError('A base unificada não existe. Rode a Limpeza antes.')
    pedidas = [area] if area else com_previsao

    # Para validar, é preciso o alvo (crimes das 4 semanas seguintes) de cada semana prevista.
    # O gabarito vem dos crimes por área da Filtragem, que guardam todos os meses: a data final
    # do período (Features) corta só o treino e a previsão, não a validação.
    from pipeline.predict import gabarito
    prontas, motivos = [], {}
    for a in pedidas:
        conhecidas, _ = gabarito.gerar(a, semanas, tag)
        if conhecidas is None:
            # sem os crimes da Filtragem: usa o alvo do dataset, como antes
            p = os.path.join(config.DIR_DATASETS, f'dataset_full_{a}.csv')
            if not os.path.exists(p):
                motivos[a] = 'sem os crimes da Filtragem e sem dataset'
                continue
            _, conhecidas = _semanas_dataset(config, a)
        faltam = [s for s in semanas if s not in set(conhecidas)]
        if faltam:
            ult = gabarito.ultimo_crime(a)
            precisa = (semanas[-1] + pd.Timedelta(weeks=config.FORECAST_HORIZON)).date()
            motivos[a] = (f'faltam os crimes reais até {precisa} (as 4 semanas seguintes à última semana prevista); '
                          f'os dados vão até {ult.date() if ult is not None and not pd.isna(ult) else "?"}')
        else:
            prontas.append(a)
    for a, m in motivos.items():
        print(f'[AVISO] {a}: {m}. Área pulada.')
        events.metric('validate', 'pulada', m, area=a)
    if not prontas:
        raise JobError(f'Ainda não dá para validar {mes[5:]}/{mes[:4]}: {next(iter(motivos.values()))}. '
                       'Importe a planilha da SSP com esses meses e rode Limpeza e Filtragem. '
                       'Não precisa refazer as Features, treinar nem prever de novo.')

    events.emit('plan', job='validate', areas=prontas, mes=mes, tag=tag, semanas=[str(s.date()) for s in semanas])
    print(f"-> Validação de {mes[5:]}/{mes[:4]} · áreas: {', '.join(prontas)}")
    t0 = time.time()
    feitas = []
    q_alto = config.METRICS_THRESHOLDS.get('HIGH_RISK_QUANTILE', config.HOTSPOT_QUANTILE) if isinstance(getattr(config, 'METRICS_THRESHOLDS', None), dict) else config.HOTSPOT_QUANTILE
    with ResourceMonitor('Validação'):
        for i, a in enumerate(prontas):
            print(f'\n=== {a} ===')
            info = {}
            try:
                with open(_sidecar(config, a, tag), encoding='utf-8') as f:
                    info = json.load(f)
            except Exception:
                pass
            modo = info.get('modo', 'desconhecido')
            events.metric('validate', 'modo', modo, area=a)
            if modo == 'retroativa':
                print('[AVISO] Previsão retroativa: o mês estava nos dados de treino. O acerto fica otimista.')

            events.progress('validate', i, len(prontas), area=a, etapa='gabarito', sub=0, subtotal=3)
            saida = step6_geojson.process_area_export(a, forecast_date=fd, tag=tag, generate_predictions=False) or {}
            events.metric('validate', 'crimes_reais', int(saida.get('gabarito') or 0), area=a)
            events.progress('validate', i, len(prontas), area=a, etapa='metricas', sub=1, subtotal=3)
            linhas = step7_metrics.run_step7(target_area=a, forecast_date=fd) or []
            for r in linhas:
                events.metric('validate', 'resultado', {
                    'modelo': r['Modelo'], 'foco': r['Hit Rate (Foco)'], 'cobertura': r['Hit Rate (Cobertura)'],
                    'pai': r['PAI'], 'f1': r['F1-Score'], 'precisao': r['Precision'], 'recall': r['Recall'],
                    'crimes': r['Crimes Totais']}, area=a, model=r['Modelo'])
            events.progress('validate', i, len(prontas), area=a, etapa='zhang', sub=2, subtotal=3)
            dz = step7b_zhang.run_step7b(target_area=a, forecast_date=fd)
            if dz is not None and len(dz):
                sel = dz[(dz['Quantile'] - q_alto).abs() < 1e-6]
                for _, r in sel.iterrows():
                    events.metric('validate', 'zhang', {'modelo': r['Model'], 'hitrn': float(r['HitRn']), 'hiten': float(r['HitEn']),
                                                        'pai': float(r['PAI']), 'quantil': float(r['Quantile'])}, area=a, model=r['Model'])
            try:
                for r in _comparacao_justa(config, a, tag, semanas):
                    events.metric('validate', 'justa', r, area=a, model=r['modelo'])
            except Exception as e:  # noqa: BLE001 — informativo; não impede a validação
                print(f'[AVISO] {a}: linhas de base não calculadas ({e}).')
            if info.get('personalizado'):
                events.metric('validate', 'personalizado', info['personalizado'], area=a)
            if linhas:
                feitas.append(a)
            else:
                print(f'[ERRO] {a}: nenhuma métrica calculada.')

    resumo = os.path.join(config.DIR_RESULTS, 'metrics_summary_all.csv')
    if feitas and _fresh(resumo, t0):
        events.artifact('validate', resumo, kind='csv')
    zh = os.path.join(config.DIR_METRICS, 'zhang_comparison.csv')
    if feitas and _fresh(zh, t0):
        events.artifact('validate', zh, kind='csv')
    for a in feitas:
        g = os.path.join(config.DIR_RESULTS_GEOJSON, f'crimes_reais_{a}_{fd}.geojson')
        if _fresh(g, t0):
            events.artifact('validate', g, kind='geojson')
    falhas = [a for a in prontas if a not in feitas]
    if falhas:
        raise JobError(f"Não calculou as métricas de: {', '.join(falhas)}. Veja o log.")


# ── Ensemble só (variantes e pré-visualização) ──────────────────────────────────────────────
# Recalcula só o step5 sobre os resultados já salvos dos membros, com override de ENSEMBLE_CONFIG
# e um sufixo no nome do arquivo. Roda logo depois da Previsão, com a mesma data final (o filtro
# de histórico do Ensemble lê o dataset daquele momento).
VARIANTES = {
    'semrf': ('Sem o Random Forest', {'MODEL_WEIGHTS': {'RF': 0}}),
    'semmax': ('Sem o máximo (só a média)', {'HYBRID_FORMULA': {'MEAN_WEIGHT': 1.0, 'MAX_WEIGHT': 0.0}}),
    'sempoi': ('Sem pontos de interesse', {'POI_BOOST_FACTOR': 0}),
    'semfiltro': ('Sem o filtro de histórico', {'MIN_HISTORICAL_CRIMES': None}),
    'comsuav': ('Com a suavização das simulações iniciais', {'TEMPORAL_SMOOTHING': {'ENABLED': True, 'EIXO': 'grids'}}),
    'ranks': ('Média dos postos', {'COMBINACAO': 'postos'}),
}


def _merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            _merge(dst[k], v)
        else:
            dst[k] = v
    return dst


def _ensemble_com(config, ajuste, fn, poi_dir=None):
    """Roda fn com ENSEMBLE_CONFIG ajustado (e, se pedido, outro conjunto de pontos de interesse)."""
    import copy
    original, dir0 = config.ENSEMBLE_CONFIG, getattr(config, 'POI_SET_DIR', None)
    config.ENSEMBLE_CONFIG = _merge(copy.deepcopy(original), ajuste)
    if poi_dir:
        config.POI_SET_DIR = poi_dir
    try:
        return fn()
    finally:
        config.ENSEMBLE_CONFIG = original
        config.POI_SET_DIR = dir0


def _expandir_variantes(config, area, pedidas):
    """Variantes da lista: as fixas (VARIANTES), 'poicat' (uma 'sem-<categoria>' para cada categoria com
    pelo menos 1 ponto no conjunto em uso na área) e 'poiset:<id>' (o mesmo Ensemble com outro conjunto).
    Devolve [(sufixo, rótulo, ajuste do ENSEMBLE_CONFIG, pasta do conjunto ou None)]."""
    import geopandas as gpd
    from pipeline.pois import conjuntos
    out = []
    for v in pedidas:
        if v in VARIANTES:
            out.append((v, VARIANTES[v][0], VARIANTES[v][1], None))
        elif v == 'poicat':
            p = conjuntos.caminho_pois(config, area)
            if not os.path.exists(p):
                print(f'[AVISO] {area}: sem pontos de interesse no conjunto em uso; ablação por categoria pulada.')
                continue
            cats = conjuntos.categorias_de(gpd.read_file(p)).value_counts()
            for cat, n in cats.items():
                if n >= 1:
                    out.append((f'sem-{conjuntos.slug(cat)}', f'sem_{cat}', {'POI_WEIGHTS': {cat: 0.0}}, None))
        elif v.startswith('poiset:'):
            cid = v.split(':', 1)[1]
            d = conjuntos.dir_conjunto(config, cid) if cid != conjuntos.ID_DISSERTACAO else config.DIR_POIS
            if not os.path.isdir(d):
                raise JobError(f'O conjunto de pontos de interesse "{cid}" não existe nesta pasta de trabalho.')
            out.append((f'poi-{cid}', f'poi_{cid}', {}, d))
    return out


def _areas_do_mes(config, tag, area):
    import glob
    achadas = sorted(re.search(r'(area_\d{2})', os.path.basename(f)).group(1)
                     for f in glob.glob(os.path.join(config.DIR_RESULTS, f'results_ensemble_area_*_{tag}.csv')))
    if area:
        if area not in achadas:
            raise JobError(f'A área {area} não tem previsão desse mês.')
        return [area]
    return achadas


def job_ensemble(area=None, mes=None, variantes=None, previa=False):
    import pandas as pd
    from pipeline import config
    from pipeline.predict import step5_ensemble, corte
    from pipeline.helpers.resource_monitor import ResourceMonitor

    fd, tag, seg = _mes(mes)
    areas = _areas_do_mes(config, tag, area)
    if not areas:
        raise JobError(f'Não há previsão de {mes[5:]}/{mes[:4]}. Gere a previsão antes.')
    t0 = time.time()
    with ResourceMonitor('Ensemble'):
        if previa:
            for a in areas:
                _previa(config, step5_ensemble, corte, a, fd, tag, t0)
            return
        pedidas = [v for v in (variantes or list(VARIANTES)) if v in VARIANTES or v == 'poicat' or re.fullmatch(r'poiset:[a-z0-9-]{1,48}', v)]
        if not pedidas:
            raise JobError('Variante do Ensemble desconhecida.')
        events.emit('plan', job='ensemble', areas=areas, mes=mes, variantes=pedidas)
        for i, a in enumerate(areas):
            salvo = os.path.join(config.DIR_RESULTS, f'results_ensemble_{a}_{tag}.csv')
            # teste de identidade: sem ajuste nenhum, o arquivo precisa sair igual ao Ensemble salvo
            ident = step5_ensemble.process_ensemble_area(a, forecast_date=fd, tag=tag, sufixo='-identidade')
            x = pd.read_csv(salvo)['probabilidade_risco'].values
            y = pd.read_csv(ident)['probabilidade_risco'].values
            igual = len(x) == len(y) and bool((abs(x - y) < 1e-12).all())
            os.remove(ident)
            events.metric('ensemble', 'identidade', igual, area=a)
            if not igual:
                raise JobError(f'{a}: o Ensemble recalculado sem ajuste não ficou igual ao salvo. As variantes não seriam '
                               'comparáveis; rode a Previsão de novo com a mesma configuração e tente outra vez.')
            print(f'   [OK] {a}: Ensemble recalculado sem ajuste é idêntico ao salvo')
            lista = _expandir_variantes(config, a, pedidas)
            for j, (suf, rot, ajuste, poi_dir) in enumerate(lista):
                events.progress('ensemble', i, len(areas), area=a, etapa=rot, sub=j, subtotal=len(lista))
                out = _ensemble_com(config, ajuste,
                                    lambda: step5_ensemble.process_ensemble_area(a, forecast_date=fd, tag=tag, sufixo=f'-{suf}'),
                                    poi_dir=poi_dir)
                if out and _fresh(out, t0):
                    events.artifact('ensemble', out, kind=f'ensemble-{suf}')


def _previa(config, step5_ensemble, corte, area, fd, tag, t0):
    """Ensemble com a configuração da tela (ainda não salva) × o Ensemble salvo: células que entram
    e saem do alto risco. Grava results_ensemble-previa_<área>_<mês>.csv e um GeoJSON das células."""
    import json
    import geopandas as gpd
    import pandas as pd
    salvo = os.path.join(config.DIR_RESULTS, f'results_ensemble_{area}_{tag}.csv')
    novo = step5_ensemble.process_ensemble_area(area, forecast_date=fd, tag=tag, sufixo='-previa')
    if not novo:
        raise JobError(f'{area}: não consegui recalcular o Ensemble.')

    def alto(path, frac, exato):
        r = pd.read_csv(path).groupby('GRID_ID')['probabilidade_risco'].mean()
        if exato:
            return set(r[corte.top_exato(r, frac)].index), r
        return set(r[r >= max(r.quantile(round(1 - frac, 6)), config.VISUALIZATION_CONFIG['SCORE_MIN_THRESHOLD'])].index), r
    # o mapa salvo, com a cobertura e o corte com que a previsão foi feita (registro da previsão)
    try:
        with open(_sidecar(config, area, tag), encoding='utf-8') as f:
            side = json.load(f)
    except (OSError, ValueError):
        side = {}
    cob0 = (side.get('cobertura') or config.PADROES_DISSERTACAO['COBERTURA'])['ALTO']
    corte0 = side.get('corte') or config.PADROES_DISSERTACAO['CORTE']
    a0, r0 = alto(salvo, cob0, corte0 == 'top_exato')
    a1, r1 = alto(novo, corte.frac_alto(), corte.exato())
    entram, saem, ficam = sorted(a1 - a0), sorted(a0 - a1), sorted(a0 & a1)
    grid = gpd.read_file(os.path.join(config.DIR_GRIDS, f'{area}.geojson'))
    grid['GRID_ID'] = grid['GRID_ID'].astype(int)
    grid = grid.dissolve(by='GRID_ID', as_index=False)[['GRID_ID', 'geometry']]
    estado = {**{g: 'entra' for g in entram}, **{g: 'sai' for g in saem}, **{g: 'fica' for g in ficam}}
    grid['estado'] = grid['GRID_ID'].map(estado).fillna('fora')
    try:
        grid['geometry'] = grid.to_crs(config.CRS_METRIC).simplify(5).to_crs(4326) if grid.crs else grid['geometry']
    except Exception:
        grid = grid.to_crs(4326)
    geo = os.path.join(config.DIR_RESULTS, f'previa_{area}_{tag}.geojson')
    grid.to_crs(4326).to_file(geo, driver='GeoJSON')
    corr = float(pd.concat([r0, r1], axis=1).corr().iloc[0, 1]) if len(r0) > 1 else 1.0
    resumo = {'area': area, 'tag': tag, 'entram': len(entram), 'saem': len(saem), 'ficam': len(ficam),
              'alto_antes': len(a0), 'alto_depois': len(a1), 'celulas': int(r1.size), 'correlacao': round(corr, 4),
              'geojson': geo, 'personalizado': config.diferencas_do_padrao(('ENSEMBLE_CONFIG', 'COBERTURA', 'CORTE'))}
    with open(os.path.join(config.DIR_RESULTS, f'previa_{area}_{tag}.json'), 'w', encoding='utf-8') as f:
        json.dump(resumo, f, ensure_ascii=False, indent=1)
    events.metric('ensemble', 'previa', resumo, area=area)
    print(f'-> {area}: {len(entram)} célula(s) entram e {len(saem)} saem do alto risco ({len(ficam)} ficam). '
          f'Correlação com o Ensemble salvo: {corr:.3f}')


# ── Métricas científicas (Modo científico) ──────────────────────────────────────────────────
def job_science(area=None, meses=None, seed=None, acao='metricas', seeds=None):
    import json
    from pipeline import config
    from pipeline.science import metricas as M
    from pipeline.helpers.resource_monitor import ResourceMonitor

    lista = [m for m in (meses or '').split(',') if re.fullmatch(r'\d{4}-\d{2}', m)]
    if not lista:
        raise JobError('Informe os meses do replay (AAAA-MM).')
    tags = [M.tag_de(m) for m in lista]
    raiz = M.dir_replay()
    areas = [area] if area else None
    with ResourceMonitor('Métricas científicas'):
        try:
            if acao == 'agregar':
                sl = [s for s in (seeds or '').split(',') if s.strip().isdigit()]
                pastas = [os.path.join(raiz, f'seed_{s}') for s in sl]
                M.agregar(pastas, raiz)
                for f in ('metricas_multiseed.csv', 'wilcoxon_multiseed.csv'):
                    events.artifact('science', os.path.join(raiz, f), kind='csv')
                _gravar_registro_multiseed(config, raiz, sl, lista)
                return
            if seed is None:
                raise JobError('Informe a semente.')
            pasta = os.path.join(raiz, f'seed_{seed}' + ('_vazamento' if acao == 'vazamento' else ''))
            if not os.path.isdir(pasta):
                raise JobError(f'Não há previsões guardadas em {os.path.relpath(pasta, config.DATA_DIR)}.')
            lb = M.rotulos(tags, areas)
            events.emit('plan', job='science', areas=sorted(lb.Area.unique()), meses=lista, seed=seed, acao=acao)
            df = M.calcular(pasta, lb, tags, seed=int(seed), out_dir=pasta)
            for f in ('metricas_replay.csv', 'wilcoxon_replay.csv', 'colapso_replay.csv', 'ensemble_vs_membros.csv',
                      'ensemble_variantes.csv', 'wilcoxon_variantes.csv'):
                if os.path.exists(os.path.join(pasta, f)):
                    events.artifact('science', os.path.join(pasta, f), kind='csv')
            resumo = M.resumo_tela(df, int(seed))
            if acao == 'vazamento':
                comp = M.comparar_vazamento(os.path.join(raiz, f'seed_{seed}'), pasta, raiz)
                resumo['vazamento'] = comp.groupby('Modelo')[['PAI_sem_vazamento', 'PAI_com_vazamento']].mean().reset_index().to_dict('records')
                events.artifact('science', os.path.join(raiz, 'vazamento_comparacao.csv'), kind='csv')
            else:
                resumo['wilcoxon'] = _ler_csv_registros(os.path.join(pasta, 'wilcoxon_replay.csv'))
                resumo['ensembleVsMembros'] = _ler_csv_registros(os.path.join(pasta, 'ensemble_vs_membros.csv'))
                resumo['variantes'] = _ler_csv_registros(os.path.join(pasta, 'ensemble_variantes.csv'))
                resumo['wilcoxonVariantes'] = _ler_csv_registros(os.path.join(pasta, 'wilcoxon_variantes.csv'))
                resumo['registro'] = _gravar_registro(config, pasta, int(seed), lista, lb)
            with open(os.path.join(pasta, 'resumo_ciencia.json'), 'w', encoding='utf-8') as f:
                json.dump(resumo, f, ensure_ascii=False, indent=1, default=str)
            events.metric('science', 'resumo', resumo)
        except M.ErroCientifico as e:
            raise JobError(str(e))


def _ler_csv_registros(p):
    import pandas as pd
    try:
        return pd.read_csv(p).to_dict('records') if os.path.exists(p) and os.path.getsize(p) > 2 else []
    except Exception:
        return []


def _registro_malha(config, areas):
    """Células por área e se a malha tem células repetidas (várias linhas com o mesmo GRID_ID)."""
    import pyogrio
    out = {}
    for a in areas:
        p = os.path.join(config.DIR_GRIDS, f'{a}.geojson')
        try:
            ids = pyogrio.read_dataframe(p, columns=['GRID_ID'], read_geometry=False)['GRID_ID']
            out[a] = {'celulas': int(ids.nunique()), 'linhas': int(len(ids)), 'repetidas': bool(len(ids) > ids.nunique())}
        except Exception:
            out[a] = None
    return out


def _info_pois(config):
    from pipeline.pois import conjuntos
    return conjuntos.info(config)


def _gravar_registro(config, pasta, seed, meses, lb):
    """Item 2.8 do plano: malha, período, datas finais de treino, semente e modelos do replay."""
    import json
    from pipeline.science import metricas as M
    areas = sorted(lb.Area.unique())
    malha = _registro_malha(config, areas)
    origens = None
    try:
        with open(os.path.join(pasta, 'origens.json'), encoding='utf-8') as f:
            origens = json.load(f)
    except (OSError, ValueError):
        pass
    reg = {
        'seed': seed, 'meses': meses, 'areas': areas,
        'REMOVER_CELULAS_REPETIDAS': bool(config.FILTER_PARAMS.get('REMOVER_CELULAS_REPETIDAS')),
        'malha_com_celulas_repetidas': any((v or {}).get('repetidas') for v in malha.values()),
        'celulas_por_area': {a: (v or {}).get('celulas') for a, v in malha.items()},
        'DATE_START_DATA': config.DATE_START_DATA,
        'origens': origens,
        'modelos': M.modelos_na_pasta(pasta, [M.tag_de(m) for m in meses], set(areas)),
        'pois': _info_pois(config),
        'personalizado': config.diferencas_do_padrao(),
    }
    p = os.path.join(pasta, 'semente.json')
    try:
        with open(p, encoding='utf-8') as f:
            atual = json.load(f)
    except (OSError, ValueError):
        atual = {}
    atual['registro'] = reg
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(atual, f, ensure_ascii=False, indent=1)
    return reg


def _gravar_registro_multiseed(config, raiz, seeds, meses):
    import json
    regs = []
    for s in seeds:
        try:
            with open(os.path.join(raiz, f'seed_{s}', 'semente.json'), encoding='utf-8') as f:
                regs.append(json.load(f).get('registro') or {})
        except (OSError, ValueError):
            regs.append({})
    malhas = {r.get('malha_com_celulas_repetidas') for r in regs if r}
    pois = {(r.get('pois') or {}).get('hash') or (r.get('pois') or {}).get('id') for r in regs if r}
    reg = {'seeds': seeds, 'meses': meses, 'registros': regs, 'malhas_diferentes': len(malhas) > 1,
           'pois': _info_pois(config), 'pois_diferentes': len(pois) > 1}
    with open(os.path.join(raiz, 'registro_multiseed.json'), 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=1)
    if reg['malhas_diferentes']:
        print('[AVISO] As sementes usaram malhas diferentes (com e sem células repetidas): os números não são comparáveis.')


JOBS = {
    'clean': ('Limpeza', job_clean),
    'filter': ('Filtragem', job_filter),
    'features': ('Features', job_features),
    'train': ('Treino', job_train),
    'predict': ('Previsão', job_predict),
    'validate': ('Validação', job_validate),
    'areas': ('Áreas', None),
    'ensemble': ('Ensemble', job_ensemble),
    'science': ('Métricas científicas', job_science),
}


def job_areas(spec_path):
    """Cria áreas de estudo a partir do arquivo do operador (GeoJSON, KML, Shapefile .zip, GeoPackage)."""
    import json
    from pipeline import config
    from pipeline.areas import geo_area
    from pipeline.helpers.resource_monitor import ResourceMonitor
    try:
        with open(spec_path, encoding='utf-8') as f:
            spec = json.load(f)
    except (OSError, ValueError) as e:
        raise JobError(f'Pedido de criação de área inválido: {e}')
    with ResourceMonitor('Áreas'):
        try:
            if spec.get('acao') == 'osm':
                feitas = geo_area.baixar_osm(spec, config, events)
                print('\n-> OpenStreetMap: ' + ', '.join(f"{c['nome']} ({c['area']})" for c in feitas))
                print('-> Rode a Filtragem dessas áreas de novo para recortar a malha pelas ruas.')
                return
            criadas = geo_area.criar(spec, config, events)
        except geo_area.AreaErro as e:
            raise JobError(str(e))
    print('\n-> Áreas criadas: ' + ', '.join(f"{c['nome']} ({c['area']}, {c['celulas']} células)" for c in criadas))
    print('-> Próximo passo: Filtragem (escolha a área nova na lista) para colocar os crimes em cada célula.')


JOBS['areas'] = ('Áreas', job_areas)


def job_pois(spec_path):
    """Conjunto novo de pontos de interesse: download do OpenStreetMap ou arquivo próprio (pipeline/pois)."""
    import json
    from pipeline import config
    from pipeline.pois import conjuntos
    from pipeline.helpers.resource_monitor import ResourceMonitor
    try:
        with open(spec_path, encoding='utf-8') as f:
            spec = json.load(f)
    except (OSError, ValueError) as e:
        raise JobError(f'Pedido inválido: {e}')
    with ResourceMonitor('Pontos de interesse'):
        try:
            if spec.get('acao') == 'osm':
                man = conjuntos.baixar_osm(spec, config, events)
            elif spec.get('acao') == 'importar':
                man = conjuntos.importar(spec, config, events)
            else:
                raise JobError('Ação desconhecida.')
        except conjuntos.PoiErro as e:
            raise JobError(str(e))
        except Exception as e:  # noqa: BLE001
            if type(e).__name__ == 'AreaErro':
                raise JobError(str(e))
            raise
    d = conjuntos.dir_conjunto(config, man['id'])
    for f in sorted(os.listdir(d)):
        events.artifact('pois', os.path.join(d, f), kind='geojson' if f.endswith('.geojson') else 'json')


JOBS['pois'] = ('Pontos de interesse', job_pois)


def hint_for(exc):
    msg = str(exc)
    if isinstance(exc, MemoryError) or 'Unable to allocate' in msg:
        return 'Memória insuficiente. Feche outros programas e tente de novo.'
    if isinstance(exc, PermissionError):
        return 'Um arquivo está bloqueado. Feche-o se estiver aberto no Excel ou em outro programa e tente de novo.'
    if isinstance(exc, ModuleNotFoundError):
        return 'Falta um pacote do Python. Abra a tela Ambiente e use "Preparar ambiente".'
    if isinstance(exc, FileNotFoundError):
        return 'Um arquivo esperado não existe. Rode a fase anterior antes desta.'
    if 'CUDA out of memory' in msg or 'OutOfMemoryError' in type(exc).__name__:
        return 'A placa de vídeo ficou sem memória. Feche outros programas que usam a placa e tente de novo.'
    if isinstance(exc, OSError) and getattr(exc, 'errno', None) == 28:
        return 'Disco cheio. Libere espaço na pasta de trabalho.'
    return None


def main():
    import argparse
    ap = argparse.ArgumentParser(prog='python -m pipeline.bridge.run')
    ap.add_argument('job', choices=list(JOBS))
    ap.add_argument('--area', default=None, help='só esta área (ex.: area_01)')
    ap.add_argument('--completo', action='store_true', help='treino com validação cruzada temporal')
    ap.add_argument('--modo', choices=['paralelo', 'sequencial'], default='paralelo')
    ap.add_argument('--modelos', default='rf,lstm,transformer')
    ap.add_argument('--mes', default=None, help='mês da previsão/validação: AAAA-MM')
    ap.add_argument('--spec', default=None, help='áreas: arquivo JSON com o pedido de criação')
    ap.add_argument('--variantes', default=None, help='ensemble: variantes (semrf,semmax,sempoi,semfiltro,comsuav,ranks)')
    ap.add_argument('--previa', action='store_true', help='ensemble: compara a configuração atual com o Ensemble salvo')
    ap.add_argument('--meses', default=None, help='science: meses do replay (AAAA-MM,AAAA-MM)')
    ap.add_argument('--seed', default=None, help='science: semente')
    ap.add_argument('--seeds', default=None, help='science --acao agregar: sementes')
    ap.add_argument('--acao', choices=['metricas', 'agregar', 'vazamento'], default='metricas')
    args = ap.parse_args()
    args.modelos_set = '--modelos' in sys.argv
    job = args.job
    label, fn = JOBS[job]
    if args.area and not re.fullmatch(r'area_\d{2}', args.area):
        print('[ERRO] Área inválida.')
        return 2
    if events.enabled():
        _vigiar_pai()
    events.emit('run', status='start', job=job, label=label, pid=os.getpid(), area=args.area, mes=args.mes)
    try:
        events.metric('ambiente', 'versoes', _versoes())
    except Exception:
        pass
    t0 = time.time()
    try:
        if job == 'clean':
            fn()
        elif job == 'train':
            fn(args.area, fast=not args.completo, modo=args.modo, modelos=tuple(args.modelos.split(',')))
        elif job == 'predict':
            fn(args.area, mes=args.mes, modelos=tuple(args.modelos.split(',')) if args.modelos_set else None)
        elif job == 'validate':
            fn(args.area, mes=args.mes)
        elif job in ('areas', 'pois'):
            fn(args.spec)
        elif job == 'ensemble':
            fn(args.area, mes=args.mes, variantes=args.variantes.split(',') if args.variantes else None, previa=args.previa)
        elif job == 'science':
            if args.seed is not None and not str(args.seed).isdigit():
                raise JobError('Semente inválida.')
            fn(args.area, meses=args.meses, seed=args.seed, acao=args.acao, seeds=args.seeds)
        else:
            fn(args.area)
    except KeyboardInterrupt:
        events.emit('run', status='end', job=job, ok=False, cancelled=True, secs=round(time.time() - t0, 1))
        return 130
    except JobError as e:
        print(f'[ERRO] {e}')
        events.emit('error', id=job, kind='JobError', msg=str(e), hint=None)
        events.emit('run', status='end', job=job, ok=False, secs=round(time.time() - t0, 1))
        return 1
    except BaseException as e:  # noqa: BLE001
        traceback.print_exc()
        events.emit('error', id=job, kind=type(e).__name__, msg=str(e)[:500], hint=hint_for(e))
        events.emit('run', status='end', job=job, ok=False, secs=round(time.time() - t0, 1))
        return 1
    events.emit('run', status='end', job=job, ok=True, secs=round(time.time() - t0, 1))
    return 0


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    sys.exit(main())
