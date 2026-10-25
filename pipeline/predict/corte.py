"""Regra de corte do alto (e do médio) risco.

config.CORTE:
  'maior_igual' (dissertação): risco >= quantil. Cada passo (step4, step5, step6, step7) mantém
                o cálculo de sempre, por isso esta regra não passa por aqui.
  'top_exato':  exatamente ceil(fração × n) células, as de maior risco; empates no limite são
                desempatados ao acaso com a semente (np.random.default_rng(GLOBAL_SEED)), a mesma
                regra das métricas do Modo científico (pipeline/science/metricas.py).
"""
import math

import numpy as np
import pandas as pd

from pipeline import config


def top_exato_mask(valores, frac, seed=None):
    """Máscara booleana (mesma ordem de `valores`) com as ceil(frac × n) maiores."""
    v = np.asarray(valores, dtype=float)
    n = len(v)
    sel = np.zeros(n, bool)
    if not n:
        return sel
    k = min(n, int(math.ceil(float(frac) * n - 1e-9)))
    tie = np.random.default_rng(config.GLOBAL_SEED if seed is None else seed).random(n)
    sel[np.lexsort((tie, -v))[:k]] = True
    return sel


def top_exato(serie, frac, seed=None):
    """Série booleana com o mesmo índice de `serie`."""
    return pd.Series(top_exato_mask(serie.values, frac, seed), index=serie.index)


def frac_alto():
    return round(1 - config.HOTSPOT_QUANTILE, 6)


def frac_medio():
    return round(1 - config.VISUALIZATION_CONFIG['GEOJSON_MEDIUM_QUANTILE'], 6)


def exato():
    return getattr(config, 'CORTE', 'maior_igual') == 'top_exato'


def cobertura_padrao():
    p = config.PADROES_DISSERTACAO.get('COBERTURA', {})
    return abs(frac_alto() - p.get('ALTO', 0.10)) < 1e-9 and abs(frac_medio() - p.get('MEDIO', 0.20)) < 1e-9
