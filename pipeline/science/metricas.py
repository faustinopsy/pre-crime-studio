"""
Métricas científicas do replay sem vazamento.

Funções: run_labels, grid_scores, selecao, metricas, average_precision, ece, holm,
run_metrics e run_colapso, sem datas fixas:
  * a semana inicial de cada mês é a primeira segunda-feira do mês (a mesma regra da
    previsão, step4/step5) e as semanas avaliadas são as FORECAST_HORIZON seguintes;
  * o desempate do top-k exato usa a semente do replay (np.random.default_rng(semente));
  * os modelos são os arquivos results_<modelo>_<área>_<AAAA_MM>.csv encontrados na pasta,
    incluindo as variantes do Ensemble (results_ensemble-<variante>_...).

Rótulos: tirados do dataset COMPLETO (depois do passo "Features com todos os dados"), com as
duas linhas de base sem aprendizado (média de lag_1..lag_24 e soma de lag_1..lag_4 na primeira
semana do mês). Um dataset cortado por DATA_END tem rótulos vazios no fim: a função recusa.

Saídas de uma semente (pasta da semente, processed/replay_seeds/seed_<n>/):
  metricas_replay.csv      PAI, F1, Precisão, Recall, HitRn, HitEn, PEI, n e fração selecionados,
                           células e taxa-base por área × mês × modelo × q (0,95/0,90/0,80) ×
                           corte (top_exato, maior_igual); PR-AUC, Brier e ECE dos modelos
  wilcoxon_replay.csv      Wilcoxon pareado (área × mês) com correção de Holm por métrica
                           (q = 0,90, top_exato; PAI, F1, HitEn e ECE)
  colapso_replay.csv       empates no corte por quantil
  ensemble_vs_membros.csv  o Ensemble supera o melhor membro? e a média dos três?
  ensemble_variantes.csv   PAI, F1 e ECE de cada variante do Ensemble (quando houver)
"""
import glob
import json
import os
import re

import numpy as np
import pandas as pd

from pipeline import config

MEMBROS = ['rf', 'lstm', 'transformer']
PRINCIPAIS = MEMBROS + ['ensemble']
BASES = ['base_media24sem', 'base_ultimas4sem']
LAG24 = [f'lag_{i}' for i in range(1, 25)]
QUANTIS = (0.95, 0.90, 0.80)
CORTES = ('top_exato', 'maior_igual')
NOMES = {'rf': 'RF', 'lstm': 'LSTM', 'transformer': 'Transformer', 'ensemble': 'Ensemble',
         'base_media24sem': 'Média 24 semanas', 'base_ultimas4sem': 'Últimas 4 semanas'}


class ErroCientifico(Exception):
    """Falha com mensagem para o operador."""


def dir_replay():
    return os.path.join(config.DATA_PROC, 'replay_seeds')


def tag_de(mes):
    return mes.replace('-', '_')


def semana_inicial(tag):
    d = pd.Timestamp(f"{tag.replace('_', '-')}-01")
    return d + pd.Timedelta(days=(7 - d.weekday()) % 7)


def semanas(tag):
    d = semana_inicial(tag)
    return [d + pd.Timedelta(weeks=i) for i in range(config.FORECAST_HORIZON)]


def areas_com_dataset():
    return sorted(os.path.basename(f)[len('dataset_full_'):-4]
                  for f in glob.glob(os.path.join(config.DIR_DATASETS, 'dataset_full_area_*.csv')))


# ── rótulos ─────────────────────────────────────────────────────────────────────────────────
def caminho_rotulos():
    return os.path.join(dir_replay(), 'labels_replay.csv')


def rotulo_variante(m):
    """Nome legível da variante: 'ensemble-sem-amenity.bar' → 'sem_amenity:bar', 'ensemble-poi-osm-…' → 'poi_osm-…'."""
    if not m.startswith('ensemble-'):
        return m
    v = m[len('ensemble-'):]
    if v.startswith('sem-') and v not in ('semrf', 'semmax', 'sempoi', 'semfiltro', 'semsuav', 'comsuav'):
        return 'sem_' + v[4:].replace('.', ':', 1)
    if v.startswith('poi-'):
        return 'poi_' + v[4:]
    return v


def gerar_rotulos(tags, areas=None, out=None, log=print):
    """Rótulos reais e linhas de base das semanas avaliadas, do dataset completo."""
    out = out or caminho_rotulos()
    areas = areas or areas_com_dataset()
    if not areas:
        raise ErroCientifico('Não há datasets. Rode as Features antes.')
    todas = set()
    for t in tags:
        todas |= set(semanas(t))
    partes_out = []
    for a in areas:
        p = os.path.join(config.DIR_DATASETS, f'dataset_full_{a}.csv')
        partes = []
        for ch in pd.read_csv(p, usecols=['data', 'GRID_ID', 'target_month'] + LAG24, chunksize=500_000):
            ch['data'] = pd.to_datetime(ch['data'])
            partes.append(ch[ch['data'].isin(todas)])
        ds = pd.concat(partes)
        if ds.empty or ds['data'].max() < max(todas):
            raise ErroCientifico(f'{a}: o dataset não tem todas as semanas avaliadas (precisa ir até {max(todas).date()}). '
                                 'Rode as Features com todos os dados antes das métricas.')
        if ds['target_month'].isna().any():
            raise ErroCientifico(f'{a}: há rótulos vazios nas semanas avaliadas. O dataset parece cortado pela data final '
                                 '(DATA_END) ou faltam os crimes reais das 4 semanas seguintes ao último mês.')
        ds['base_media24sem'] = ds[LAG24].mean(axis=1)
        ds['base_ultimas4sem'] = ds[['lag_1', 'lag_2', 'lag_3', 'lag_4']].sum(axis=1)
        ds['Area'] = a
        partes_out.append(ds[['Area', 'GRID_ID', 'data', 'target_month', 'base_media24sem', 'base_ultimas4sem']])
        log(f'   [rótulos] {a}: {len(ds)} linhas')
    lb = pd.concat(partes_out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    lb.to_csv(out, index=False)
    meta = {'tags': sorted(tags), 'areas': areas,
            'datasets': {a: os.path.getmtime(os.path.join(config.DIR_DATASETS, f'dataset_full_{a}.csv')) for a in areas}}
    with open(out[:-4] + '.json', 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log(f'[OK] {out}')
    return lb


def rotulos(tags, areas=None, log=print):
    """Rótulos gravados (refeitos quando faltam meses/áreas ou o dataset mudou)."""
    out = caminho_rotulos()
    areas = areas or areas_com_dataset()
    try:
        with open(out[:-4] + '.json', encoding='utf-8') as f:
            meta = json.load(f)
        ok = set(tags) <= set(meta['tags']) and set(areas) <= set(meta['areas']) and all(
            abs(os.path.getmtime(os.path.join(config.DIR_DATASETS, f'dataset_full_{a}.csv')) - meta['datasets'].get(a, 0)) < 1
            for a in areas)
    except (OSError, ValueError, KeyError):
        ok = False
    if not ok:
        return gerar_rotulos(sorted(set(tags)), areas, out, log)
    lb = pd.read_csv(out)
    lb['data'] = pd.to_datetime(lb['data'])
    return lb[lb.Area.isin(areas)]


def ler_rotulos_arquivo(path):
    lb = pd.read_csv(path)
    lb['data'] = pd.to_datetime(lb['data'])
    return lb


# ── grade ───────────────────────────────────────────────────────────────────────────────────
def modelos_na_pasta(results_dir, tags, areas=None):
    """rf, lstm, transformer, ensemble e variantes (ensemble-<nome>) com arquivos para os meses (e áreas)."""
    achados = set()
    pad = re.compile(r'^results_([a-z0-9.-]+)_(area_\d+)_(\d{4}_\d{2})\.csv$')
    for f in os.listdir(results_dir) if os.path.isdir(results_dir) else []:
        m = pad.match(f)
        if m and m.group(3) in tags and (areas is None or m.group(2) in areas) and m.group(1) != 'ensemble-previa':
            achados.add(m.group(1))
    ordem = [m for m in PRINCIPAIS if m in achados]
    return ordem + sorted(m for m in achados if m not in PRINCIPAIS)


def grid_scores(results_dir, lb, a, tag, modelos):
    """dict modelo -> DataFrame(risk, crimes, y) por célula."""
    w = semanas(tag)
    sub = lb[(lb.Area == a) & (lb['data'].isin(w))]
    crimes = sub.groupby('GRID_ID')['target_month'].sum()
    s0 = sub[sub['data'] == w[0]].set_index('GRID_ID')
    out = {}
    for m in modelos:
        f = os.path.join(results_dir, f'results_{m}_{a}_{tag}.csv')
        if not os.path.exists(f):
            continue
        r = pd.read_csv(f, usecols=['GRID_ID', 'data', 'probabilidade_risco'])
        r['data'] = pd.to_datetime(r['data'])
        r = r[r['data'].isin(w)]
        if r.empty:
            print(f'   [AVISO] {os.path.basename(f)}: nenhuma semana alinhada a {w[0].date()}')
            continue
        out[m] = r.groupby('GRID_ID')['probabilidade_risco'].mean()
    if not s0.empty:
        for b in BASES:
            out[b] = s0[b]
    res = {}
    for m, sc in out.items():
        g = pd.DataFrame({'risk': sc}).join(crimes.rename('crimes'), how='inner').fillna(0)
        g['y'] = (g['crimes'] > 0).astype(int)
        res[m] = g
    return res


def selecao(g, q, modo, seed=42):
    if modo == 'maior_igual':                      # regra do pipeline (step5/step7)
        thr = max(g['risk'].quantile(q), 0.01)
        return (g['risk'] >= thr).values
    k = int(np.ceil((1 - q) * len(g)))             # top-k exato, desempate aleatório
    tie = np.random.default_rng(seed).random(len(g))
    idx = np.lexsort((tie, -g['risk'].values))[:k]
    sel = np.zeros(len(g), bool)
    sel[idx] = True
    return sel


def metricas(g, q, modo, seed=42):
    sel = selecao(g, q, modo, seed)
    y = g['y'].values.astype(bool)
    c = g['crimes'].values
    tp = int((sel & y).sum()); fp = int((sel & ~y).sum()); fn = int((~sel & y).sum())
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    tot = c.sum(); n = int(sel.sum()); na = int(y.sum())
    hitrn = c[sel].sum() / tot if tot else 0.0
    pai = hitrn / (n / len(g)) if n else 0.0
    hiten = hitrn / (n / na) if n and na else 0.0
    melhor = np.sort(c)[::-1][:n].sum() / tot if tot and n else 0.0
    return dict(PAI=pai, F1=f1, Precisao=p, Recall=r, HitRn=hitrn, HitEn=hiten,
                PEI=hitrn / melhor if melhor else 0.0, n_sel=n, frac_sel=n / len(g),
                n_celulas=len(g), taxa_base=na / len(g))


def average_precision(y, s):
    # ordenação estável: com células empatadas, o resultado não depende da versão do numpy
    # (o original usava o argsort padrão, cuja ordem dos empates muda entre versões)
    o = np.argsort(-np.asarray(s, float), kind='stable')
    y = np.asarray(y)[o]
    return float((np.cumsum(y) / (np.arange(len(y)) + 1) * y).sum() / y.sum()) if y.sum() else 0.0


def ece(p, y, bins=10):
    p = np.clip(p, 0, 1)
    idx = np.minimum((p * bins).astype(int), bins - 1)
    e = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            e += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(e)


def holm(pv):
    pv = np.asarray(pv, float)
    o = np.argsort(pv)
    n = len(pv)
    adj = np.empty(n)
    acc = 0
    for i, j in enumerate(o):
        acc = max(acc, min(1, (n - i) * pv[j]))
        adj[j] = acc
    return adj


def _wilcoxon(base, modelos, metricas_testadas=('PAI', 'F1', 'HitEn', 'ECE'), indice=('Tag', 'Area'), pares=None):
    try:
        from scipy.stats import wilcoxon
    except ImportError:
        print('[AVISO] scipy ausente: Wilcoxon não calculado')
        return pd.DataFrame()
    testes = []
    pares = pares or [(a, b) for i, a in enumerate(modelos) for b in modelos[i + 1:]]
    for met in metricas_testadas:
        if met not in base:
            continue
        piv = base.pivot_table(index=list(indice), columns='Modelo', values=met)
        for a, b in pares:
            if a not in piv or b not in piv or piv[[a, b]].isna().any().any():
                continue
            d = piv[a] - piv[b]
            pv = wilcoxon(piv[a], piv[b]).pvalue if (d != 0).any() else 1.0
            testes.append(dict(Metrica=met, A=a, B=b, dif_media=d.mean(), pos=int((d > 0).sum()), n=len(d), p=pv))
    tt = pd.DataFrame(testes)
    if tt.empty:
        return tt
    tt['p_holm'] = np.nan
    for _, gi in tt.groupby('Metrica'):
        tt.loc[gi.index, 'p_holm'] = holm(gi.p.values)
    return tt


def calcular(results_dir, lb, tags, seed=42, out_dir=None, log=print):
    """Todas as métricas de uma pasta de previsões (uma semente). Devolve o DataFrame das métricas."""
    out_dir = out_dir or results_dir
    os.makedirs(out_dir, exist_ok=True)
    modelos = modelos_na_pasta(results_dir, tags, set(lb.Area.unique()))
    if not modelos:
        raise ErroCientifico(f'Nenhuma previsão dos meses {", ".join(tags)} em {results_dir}.')
    rows, colapso = [], []
    for a in sorted(lb.Area.unique()):
        for t in tags:
            gs = grid_scores(results_dir, lb, a, t, modelos)
            for m, g in gs.items():
                extra = {}
                eh_modelo = not m.startswith('base_')
                if eh_modelo:
                    extra = dict(PR_AUC=average_precision(g['y'].values, g['risk'].values),
                                 Brier=float(((g['risk'].clip(0, 1) - g['y']) ** 2).mean()),
                                 ECE=ece(g['risk'].values, g['y'].values))
                for q in QUANTIS:
                    for modo in CORTES:
                        rows.append(dict(Tag=t, Area=a, Modelo=m, q=q, Corte=modo, **metricas(g, q, modo, seed), **extra))
                if eh_modelo:
                    r = g['risk']
                    moda = r.round(10).value_counts().iloc[0]
                    for q in (0.90, 0.80):
                        me = metricas(g, q, 'maior_igual', seed); te = metricas(g, q, 'top_exato', seed)
                        colapso.append(dict(Tag=t, Area=a, Modelo=m, q=q, valores_distintos=int(r.round(10).nunique()),
                                            frac_no_valor_mais_comum=moda / len(r), frac_sel_maior_igual=me['frac_sel'],
                                            PAI_maior_igual=me['PAI'], PAI_top_exato=te['PAI'],
                                            colapso=me['frac_sel'] > (1 - q) + 0.05))
    df = pd.DataFrame(rows)
    if df.empty:
        raise ErroCientifico('Nenhuma métrica calculada: as previsões não têm as semanas avaliadas.')
    df.to_csv(os.path.join(out_dir, 'metricas_replay.csv'), index=False)
    pd.DataFrame(colapso).to_csv(os.path.join(out_dir, 'colapso_replay.csv'), index=False)

    base = df[(df.q == 0.90) & (df.Corte == 'top_exato')]
    principais = [m for m in PRINCIPAIS + BASES if m in set(base.Modelo)]
    tt = _wilcoxon(base, principais)
    tt.to_csv(os.path.join(out_dir, 'wilcoxon_replay.csv'), index=False)

    # Ensemble × membros
    evm = []
    piv = {met: base.pivot_table(index=['Tag', 'Area'], columns='Modelo', values=met) for met in ('PAI', 'F1')}
    membros = [m for m in MEMBROS if m in piv['PAI']]
    if 'ensemble' in piv['PAI'] and membros:
        for (t, a), _ in piv['PAI'].iterrows():
            linha = {'Tag': t, 'Area': a}
            for met in ('PAI', 'F1'):
                p = piv[met].loc[(t, a)]
                mem = p[membros].dropna()
                if mem.empty or pd.isna(p.get('ensemble')):
                    continue
                linha.update({f'{met}_ensemble': p['ensemble'], f'{met}_melhor_membro': mem.max(), f'melhor_membro_{met}': mem.idxmax(),
                              f'{met}_media_membros': mem.mean(), f'supera_melhor_{met}': bool(p['ensemble'] > mem.max()),
                              f'supera_media_{met}': bool(p['ensemble'] > mem.mean())})
            evm.append(linha)
    pd.DataFrame(evm).to_csv(os.path.join(out_dir, 'ensemble_vs_membros.csv'), index=False)

    # variantes do Ensemble
    variantes = [m for m in modelos if m.startswith('ensemble-')]
    if variantes:
        v = base[base.Modelo.isin(['ensemble'] + variantes)][['Tag', 'Area', 'Modelo', 'PAI', 'F1', 'ECE', 'HitEn']].copy()
        v.insert(3, 'Variante', v['Modelo'].map(rotulo_variante))
        v['Semente'] = seed
        v.to_csv(os.path.join(out_dir, 'ensemble_variantes.csv'), index=False)
        tv = _wilcoxon(base, ['ensemble'] + variantes, ('PAI', 'F1', 'ECE'), pares=[('ensemble', v) for v in variantes])
        if not tv.empty:
            tv.insert(2, 'Variante', tv['B'].map(rotulo_variante))
        tv.to_csv(os.path.join(out_dir, 'wilcoxon_variantes.csv'), index=False)
    else:
        # um replay anterior com variantes não deixa tabelas velhas na pasta da semente
        for f in ('ensemble_variantes.csv', 'wilcoxon_variantes.csv'):
            if os.path.exists(os.path.join(out_dir, f)):
                os.remove(os.path.join(out_dir, f))

    log('\n=== média das áreas, q = 0,90, top 10% exato ===')
    log(base.groupby(['Modelo', 'Tag'])[['PAI', 'F1', 'HitEn']].mean().unstack('Tag').round(3).to_string())
    return df


# ── multi-seed ──────────────────────────────────────────────────────────────────────────────
COLS_METRICAS = ['PAI', 'F1', 'Precisao', 'Recall', 'HitRn', 'HitEn', 'PEI', 'frac_sel', 'PR_AUC', 'Brier', 'ECE']


def agregar(pastas, out_dir, log=print):
    """metricas_multiseed.csv (média, desvio, mínimo e máximo entre sementes) e
    wilcoxon_multiseed.csv (Wilcoxon sobre a média das sementes)."""
    todos = []
    for d in pastas:
        p = os.path.join(d, 'metricas_replay.csv')
        if not os.path.exists(p):
            raise ErroCientifico(f'Faltam as métricas de {os.path.basename(d)}.')
        df = pd.read_csv(p)
        df['Semente'] = os.path.basename(d).replace('seed_', '')
        todos.append(df)
    df = pd.concat(todos)
    chaves = ['Tag', 'Area', 'Modelo', 'q', 'Corte']
    cols = [c for c in COLS_METRICAS if c in df]
    ag = df.groupby(chaves)[cols].agg(['mean', 'std', 'min', 'max'])
    ag.columns = [f'{c}_{s}'.replace('_mean', '_media').replace('_std', '_dp') for c, s in ag.columns]
    ag['n_sementes'] = df.groupby(chaves)['Semente'].nunique()
    ag.reset_index().to_csv(os.path.join(out_dir, 'metricas_multiseed.csv'), index=False)
    media = df[(df.q == 0.90) & (df.Corte == 'top_exato')].groupby(['Tag', 'Area', 'Modelo'])[cols].mean().reset_index()
    principais = [m for m in PRINCIPAIS + BASES if m in set(media.Modelo)]
    _wilcoxon(media, principais).to_csv(os.path.join(out_dir, 'wilcoxon_multiseed.csv'), index=False)
    log(f'[OK] métricas de {len(pastas)} sementes agregadas em {out_dir}')
    return ag


def comparar_vazamento(dir_sem, dir_com, out_dir):
    """PAI por modelo, área e mês com e sem vazamento (q = 0,90, top exato)."""
    def ler(d):
        df = pd.read_csv(os.path.join(d, 'metricas_replay.csv'))
        return df[(df.q == 0.90) & (df.Corte == 'top_exato')].set_index(['Tag', 'Area', 'Modelo'])[['PAI', 'F1']]
    a, b = ler(dir_sem), ler(dir_com)
    c = a.join(b, lsuffix='_sem_vazamento', rsuffix='_com_vazamento', how='inner').reset_index()
    # só os modelos (as linhas de base não mudam e as variantes não rodam na versão com vazamento)
    c = c[c.Modelo.isin(PRINCIPAIS)]
    c['dPAI'] = c['PAI_com_vazamento'] - c['PAI_sem_vazamento']
    c.to_csv(os.path.join(out_dir, 'vazamento_comparacao.csv'), index=False)
    return c


def resumo_tela(df, seed):
    """Tabelas pequenas para a tela do Modo científico (média das áreas, q = 0,90, top exato)."""
    base = df[(df.q == 0.90) & (df.Corte == 'top_exato')]
    pm = base.groupby(['Modelo', 'Tag'])[['PAI', 'F1', 'HitEn']].mean().reset_index()
    cal = base[~base.Modelo.str.startswith('base_')].groupby('Modelo')[['ECE', 'Brier', 'PR_AUC']].mean().reset_index()
    col = df[(df.Corte == 'maior_igual') & (df.q == 0.90) & (~df.Modelo.str.startswith('base_'))]
    return {
        'semente': seed,
        'porModeloMes': pm.to_dict('records'),
        'calibracao': cal.to_dict('records'),
        'fracSelMaiorIgual': col.groupby('Modelo')['frac_sel'].max().round(4).to_dict(),
    }
