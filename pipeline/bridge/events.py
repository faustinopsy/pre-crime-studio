"""
Protocolo de eventos Pipeline -> Desktop.

Cada evento é uma linha no stdout:  @@PC {json}
Só imprime quando a variável de ambiente PRECRIME_EVENTS=1 está definida
(o app desktop define). Na linha de comando comum, nada muda.
"""
import json
import os
import sys
import time
from contextlib import contextmanager

PREFIX = "@@PC "
_V = 1


def enabled() -> bool:
    return os.environ.get("PRECRIME_EVENTS") == "1"


def emit(t: str, **fields) -> None:
    if not enabled():
        return
    payload = {"v": _V, "t": t, "ts": round(time.time(), 3)}
    payload.update(fields)
    try:
        line = PREFIX + json.dumps(payload, ensure_ascii=False, default=str)
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def stage_start(stage_id: str, label: str = "", **extra) -> None:
    emit("stage", id=stage_id, status="start", label=label or stage_id, **extra)


def stage_end(stage_id: str, ok: bool = True, secs: float = None, **extra) -> None:
    emit("stage", id=stage_id, status="end", ok=ok, secs=secs, **extra)


def metric(stage_id: str, key: str, value, **extra) -> None:
    emit("metric", id=stage_id, key=key, value=value, **extra)


def progress(stage_id: str, done: int, total: int, **extra) -> None:
    emit("progress", id=stage_id, done=done, total=total, **extra)


def artifact(stage_id: str, path: str, kind: str = "") -> None:
    emit("artifact", id=stage_id, path=path, kind=kind)


@contextmanager
def stage(stage_id: str, label: str = ""):
    t0 = time.time()
    stage_start(stage_id, label)
    ok = True
    try:
        yield
    except BaseException:
        ok = False
        raise
    finally:
        stage_end(stage_id, ok=ok, secs=round(time.time() - t0, 2))
