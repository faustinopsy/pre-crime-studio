"""Parâmetros com que cada modelo foi treinado.

O treino grava, ao lado do modelo, processed/models/params_<modelo>_<area>.json com os
hiperparâmetros usados (ML_CONFIG depois dos overrides do app). A previsão lê esse arquivo
para montar a LSTM e o Transformer com a mesma arquitetura do treino: se o operador mudar
"hidden_dim" e treinar só uma área, as outras continuam sendo carregadas com os valores
com que foram treinadas. Sem o arquivo, vale ML_CONFIG.
"""
import json
import os
from datetime import datetime

from pipeline import config

# chaves que definem o formato dos pesos (precisam ser iguais no treino e na previsão)
ARQUITETURA = {
    'LSTM': ('hidden_dim', 'layer_dim', 'dropout_prob'),
    'Transformer': ('embed_dim', 'num_heads', 'ff_dim', 'num_layers', 'dropout_prob'),
}


def _caminho(modelo, area):
    return os.path.join(config.DIR_MODELS, f'params_{modelo.lower()}_{area}.json')


def salvar(modelo, area, params):
    dados = {
        'modelo': modelo,
        'area': area,
        'parametros': {k: v for k, v in params.items() if k not in ('n_jobs', 'random_state')},
        'seed': config.GLOBAL_SEED,
        'data_end': config.DATA_END,
        'treinado_em': datetime.now().isoformat(timespec='seconds'),
    }
    with open(_caminho(modelo, area), 'w', encoding='utf-8') as f:
        json.dump(dados, f, ensure_ascii=False, indent=2)


def para_previsao(modelo, area):
    """ML_CONFIG do modelo com a arquitetura trocada pela do treino (quando registrada)."""
    params = dict(config.ML_CONFIG[modelo])
    try:
        with open(_caminho(modelo, area), encoding='utf-8') as f:
            usados = json.load(f).get('parametros') or {}
    except (OSError, ValueError):
        return params
    for k in ARQUITETURA.get(modelo, ()):
        if k in usados:
            params[k] = usados[k]
    return params


def overrides_do_app(modelo):
    """Parâmetros que o operador mudou no app para este modelo (vazio = os recomendados)."""
    return ((config.CONFIG_OVERRIDES or {}).get('ML_CONFIG') or {}).get(modelo) or {}
