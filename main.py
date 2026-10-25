"""
Arquivo: main.py
Descrição: Orquestrador principal do pipeline do Pre-Crime Studio.
"""

import multiprocessing
import os
import sys
import argparse
import gc

# Força UTF-8 no stdout para evitar erro de encoding no Windows ao imprimir Emojis
if sys.stdout.encoding.lower() != 'utf-8':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

# Garante que a raiz do projeto esteja no PYTHONPATH
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from pipeline import config
from pipeline.helpers.resource_monitor import ResourceMonitor
from pipeline.helpers import download_pois

from pipeline.dataset import step1_ingest
from pipeline.dataset import step2_filter_grids
from pipeline.dataset import step2_etl
from pipeline.dataset import step3_features

from pipeline.train import train_rf
from pipeline.train import train_lstm
from pipeline.train import train_transformer

from pipeline.predict import step4_predict
from pipeline.predict import step5_ensemble
from pipeline.predict import step6_geojson
from pipeline.predict import step7_metrics
from pipeline.predict import step7b_zhang
from pipeline.predict import step8_history


def run_training_parallel(target_area=None, fast_mode=False):
    """Roda treinamentos em paralelo."""
    desc = "FASE 3: TREINO PARALELO"
    if target_area: desc += f" (Target: {target_area})"
    if fast_mode: desc += " [FAST MODE]"
    
    with ResourceMonitor(desc):
        args = (target_area, fast_mode)

        # 'spawn' (em vez do 'fork' padrão do Linux) é obrigatorio quando os
        # processos usam CUDA: o PyTorch nao permite reinicializar a GPU em um
        # processo criado por fork. Com 'spawn' cada filho inicia um interpretador
        # limpo e seu proprio contexto CUDA. (No modo CPU 'spawn' tambem funciona.)
        ctx = multiprocessing.get_context('spawn')

        p_rf = ctx.Process(target=train_rf.run_step3, args=args, name="Treino_RF")
        p_lstm = ctx.Process(target=train_lstm.run_step3, args=args, name="Treino_LSTM")
        p_trans = ctx.Process(target=train_transformer.run_step3, args=args, name="Treino_Transformer")

        p_rf.start(); p_lstm.start(); p_trans.start()
        print("    -> [INFO] Processos disparados...")
        p_rf.join(); p_lstm.join(); p_trans.join()


def _parse_month_arg(month_str):
    if not month_str: return None
    parts = month_str.split('-')
    return f"{parts[0]}-{parts[1].zfill(2)}-01"


def run_predict_pipeline(target_area=None, forecast_date=None, generate_predictions=True):
    """Gera previsões (--predict) ou valida contra dados reais (--validate)."""
    forecast_date = forecast_date or config.FORECAST_DATE
    tag = config.get_forecast_tag(forecast_date)

    with ResourceMonitor(f"FASE 4: PREVISÃO MENSAL | tag={tag} | predic_mode={generate_predictions}"):

        if generate_predictions:
            with ResourceMonitor("PREVISÃO: step4_predict"):
                step4_predict.run_step9(target_area=target_area, forecast_date=forecast_date)
            gc.collect()

            with ResourceMonitor("PREVISÃO: ENSEMBLE"):
                step5_ensemble.run_step4_ensemble(target_area=target_area, forecast_date=forecast_date)

            with ResourceMonitor("PREVISÃO: GEOJSON (Hotspots)"):
                step6_geojson.run_step6(target_area=target_area, forecast_date=forecast_date, generate_predictions=True)

            with ResourceMonitor("PREVISÃO: HISTÓRICO DE GRIDS (JSON)"):
                step8_history.run_step8b(target_area=target_area, forecast_date=forecast_date)

        else:
            # Modo validação: crimes reais + métricas contra previsões já geradas
            with ResourceMonitor("VALIDAÇÃO: GEOJSON (Crimes Reais)"):
                step6_geojson.run_step6(target_area=target_area, forecast_date=forecast_date, generate_predictions=False)

            with ResourceMonitor("VALIDAÇÃO: MÉTRICAS"):
                step7_metrics.run_step7(target_area=target_area, forecast_date=forecast_date)

            with ResourceMonitor("VALIDAÇÃO: MÉTRICAS ZHANG"):
                step7b_zhang.run_step7b(target_area=target_area, forecast_date=forecast_date)


def main():
    parser = argparse.ArgumentParser(
        description="Pipeline Pre-Crime",
        formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--ingest",  action="store_true", help="Fase 1: Unifica dados da SSP")
    parser.add_argument("--etl",     action="store_true", help="Fase 2: Filtro viário, sjoin crimes->grids e features")
    parser.add_argument("--train",   action="store_true", help="Fase 3: Treina modelos (RF, LSTM, Transformer)")
    parser.add_argument("--predict", action="store_true", help="Fase 4: Gera previsões cegas para o mês indicado")
    parser.add_argument("--validate",action="store_true", help="Fase 5: Valida previsões contra dados reais (ingest+ETL automáticos)")

    parser.add_argument("--area",  type=str, default=None, help="Área específica (ex: area_01).")
    parser.add_argument("--fast",  action="store_true",    help="Modo rápido (pula validação cruzada no treino).")

    # --month é o fallback compartilhado; --predict-month e --validate-month permitem
    # especificar meses diferentes para cada fase num único comando encadeado.
    parser.add_argument("--month",          type=str, default=None,
                        help="Mês padrão para --predict e --validate: YYYY-MM (ex: 2025-12).")
    parser.add_argument("--predict-month",  type=str, default=None,
                        help="Mês exclusivo para --predict (sobrepõe --month).")
    parser.add_argument("--validate-month", type=str, default=None,
                        help="Mês exclusivo para --validate (sobrepõe --month).")

    args = parser.parse_args()

    # Resolve meses: argumento específico tem prioridade sobre --month
    predict_date  = _parse_month_arg(args.predict_month  or args.month)
    validate_date = _parse_month_arg(args.validate_month or args.month)

    if not any([args.ingest, args.etl, args.train, args.predict, args.validate]):
        parser.print_help()
        print("\nExemplos de uso:")
        print("  python main.py --ingest --etl --train --fast --predict --month 2026-02")
        print("  python main.py --ingest --etl --train --fast --predict --predict-month 2026-02 --validate --validate-month 2026-01")
        print("  python main.py --predict --month 2026-02          # Previsão cega")
        print("  python main.py --validate --month 2026-01         # Valida mês passado")
        return

    with ResourceMonitor("PIPELINE PRE-CRIME"):
        if args.ingest:
            with ResourceMonitor("FASE 1: INGESTÃO"):
                step1_ingest.run_step0()

        if args.etl:
            with ResourceMonitor("FASE 2: ETL E FEATURES"):
                step2_filter_grids.run_step1_5(target_area=args.area)
                step2_etl.run_step1(target_area=args.area)
                step3_features.run_step2(target_area=args.area)
            gc.collect()

        if args.train:
            run_training_parallel(target_area=args.area, fast_mode=args.fast)

        if args.predict:
            with ResourceMonitor("ATUALIZANDO POIs"):
                download_pois.run_step4()
            run_predict_pipeline(target_area=args.area, forecast_date=predict_date, generate_predictions=True)

        if args.validate:
            # Garante dados reais do período antes de validar.
            if not args.ingest:
                with ResourceMonitor("VALIDAÇÃO: INGESTÃO DE DADOS REAIS"):
                    step1_ingest.run_step0(force=True)
            if not args.etl:
                with ResourceMonitor("VALIDAÇÃO: ETL E FEATURES"):
                    step2_filter_grids.run_step1_5(target_area=args.area)
                    step2_etl.run_step1(target_area=args.area)
                    step3_features.run_step2(target_area=args.area)
                gc.collect()
            run_predict_pipeline(target_area=args.area, forecast_date=validate_date, generate_predictions=False)

if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()