"""
Sonda do ambiente Python, usada pelo app desktop (tela Ambiente).

    python -m pipeline.bridge.env_probe pandas numpy torch ...

Imprime um JSON com a versão do Python e, para cada pacote pedido, a versão instalada
(ou o erro ao importar). Para o torch diz também se ele enxerga a placa de vídeo (CUDA).
Não importa nada do pipeline: roda em qualquer Python.
"""
import importlib
import json
import platform
import sys
import time

# nome no pip -> nome do módulo
MODULE = {
    'scikit-learn': 'sklearn',
    'pyyaml': 'yaml',
}


def probe(name):
    mod = MODULE.get(name, name.replace('-', '_'))
    t0 = time.time()
    try:
        m = importlib.import_module(mod)
        ver = getattr(m, '__version__', None)
        if ver is None:
            try:
                from importlib.metadata import version
                ver = version(name)
            except Exception:
                ver = '?'
        return {'ok': True, 'version': str(ver), 'secs': round(time.time() - t0, 2)}
    except Exception as e:  # noqa: BLE001 — qualquer erro de import conta como ausente
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'[:300]}


def torch_info():
    try:
        import torch
        info = {
            'version': torch.__version__,
            'built_cuda': torch.version.cuda,
            'cuda_available': bool(torch.cuda.is_available()),
        }
        if info['cuda_available']:
            info['device'] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            info['vram_mb'] = int(props.total_memory / 1048576)
        return info
    except Exception as e:  # noqa: BLE001
        return {'error': f'{type(e).__name__}: {e}'[:300]}


def main():
    names = sys.argv[1:]
    out = {
        'python': platform.python_version(),
        'executable': sys.executable,
        'prefix': sys.prefix,
        'is_venv': sys.prefix != getattr(sys, 'base_prefix', sys.prefix),
        'platform': platform.platform(),
        'bits': 64 if sys.maxsize > 2**32 else 32,
        'packages': {n: probe(n) for n in names},
    }
    if 'torch' in names and out['packages']['torch'].get('ok'):
        out['torch'] = torch_info()
    sys.stdout.write('@@ENV ' + json.dumps(out, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
