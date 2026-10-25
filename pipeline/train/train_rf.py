"""
Arquivo: src/step3_train_rf.py
Descrição: Treinamento Random Forest (Limpo).
Correção: Adicionada compressão no salvamento do modelo para economizar disco.
"""
import pandas as pd
import numpy as np
import os
import glob
import gc
import joblib
import json # Necessário para ler o best_params
from sklearn.ensemble import RandomForestClassifier
from pipeline import config
from pipeline.train import validation as vf
from pipeline.train import loader
from pipeline.train import params_io
from pipeline.bridge import events
import time

def train_rf_single_area(area_name, fast_training=False):
    print(f"\n--- Treinando Random Forest: {area_name} {'[FAST]' if fast_training else '[FULL]'} ---")
    _t0 = time.time()
    events.emit('train', status='start', model='RF', area=area_name, device='cpu')
    
    path_full = os.path.join(config.DIR_DATASETS, f'dataset_full_{area_name}.csv')
    if not os.path.exists(path_full):
        print(f"   [PULAR] Dataset full não encontrado: {path_full}")
        return

    # Carrega apenas as colunas necessárias para o RF (economiza ~40% de RAM em áreas grandes)
    all_cols_peek = pd.read_csv(path_full, nrows=0).columns.tolist()
    feature_cols  = [c for c in all_cols_peek if 'lag_' in c or c in ('neigh_crime_sum', 'neigh_crime_max')]
    needed_cols   = feature_cols + ['target_month', 'GRID_ID', 'data']
    needed_cols   = [c for c in needed_cols if c in all_cols_peek]

    df_full = loader.load_train_dataset(path_full, usecols=needed_cols)
    if df_full is None:
        return

    validator = vf.TimeSeriesValidator(df_full, date_col='data')
    feature_cols = [c for c in df_full.columns if 'lag_' in c or c in ('neigh_crime_sum', 'neigh_crime_max')]
    
    # Carrega Params
    params = config.ML_CONFIG['RF'].copy()
    if os.path.exists(config.PATH_BEST_PARAMS):
        try:
            with open(config.PATH_BEST_PARAMS, 'r') as f:
                best = json.load(f)
                if 'RF' in best:
                    params.update(best['RF'])
                    print("   [INFO] Usando parâmetros otimizados.")
        except: pass
    # o que o operador mudou no app vale por cima dos otimizados
    _ov = params_io.overrides_do_app('RF')
    if _ov:
        params.update(_ov)
        print(f"   [INFO] Parâmetros escolhidos no app: {_ov}")
    
        # --- MODO CIENTÍFICO (VALIDAÇÃO) ---
    if not fast_training:
        print("   -> Iniciando Validação Cruzada Temporal...")
        metrics_history = []
        
        for fold, train_idx, test_idx, cutoff_date in validator.walk_forward_split():
            X_train = df_full.loc[train_idx, feature_cols]
            y_train = (df_full.loc[train_idx, 'target_month'] > 0).astype(int)
            
            X_test = df_full.loc[test_idx, feature_cols]
            y_test = (df_full.loc[test_idx, 'target_month'] > 0).astype(int)
            
            if len(X_test) == 0 or y_train.sum() == 0: continue
            events.progress('train', fold, fold, model='RF', area=area_name, fase=f'validação {fold}')
                
            rf = RandomForestClassifier(
                n_estimators=int(params['n_estimators']),
                max_depth=None if params['max_depth'] is None else int(params['max_depth']),
                min_samples_split=int(params.get('min_samples_split', 2)),
                min_samples_leaf=int(params.get('min_samples_leaf', 1)),
                n_jobs=int(params.get('n_jobs', -1)),
                random_state=config.GLOBAL_SEED,
                class_weight='balanced'
            )
            rf.fit(X_train, y_train)
            
            if len(X_test) > 0:
                probs = rf.predict_proba(X_test)[:, 1]
                
                visual_limit = np.quantile(probs, 0.50)
                if visual_limit == 0: visual_limit = 0.001
                
                fold_metrics = vf.evaluate_predictions(y_test, probs, threshold=visual_limit)
                metrics_history.append(fold_metrics)
                events.metric('train', 'auc_fold', round(float(fold_metrics['AUC']), 4), model='RF', area=area_name, fold=fold)

        if metrics_history:
            df_metrics = pd.DataFrame(metrics_history)
            print(f"   [RESULTADOS] AUC Média: {df_metrics['AUC'].mean():.3f}")
            vf.save_metrics_csv(metrics_history, "RF", area_name, config.DIR_METRICS)
    else:
        print("   [INFO] Modo Rápido: Pulando validação cruzada.")
    

    # --- TREINO FINAL (PRODUÇÃO) ---
    print("   -> Treinando Modelo Final...")
    X_all = df_full[feature_cols].values
    y_all = (df_full['target_month'] > 0).astype(int).values
    events.progress('train', 0, 1, model='RF', area=area_name, fase='final', arvores=int(params['n_estimators']))
    _n_linhas, _n_pos = int(len(y_all)), int(y_all.sum())

    del df_full
    gc.collect()

    rf_final = RandomForestClassifier(
        n_estimators=int(params['n_estimators']),
        max_depth=None if params['max_depth'] is None else int(params['max_depth']),
        min_samples_split=int(params.get('min_samples_split', 2)),
        min_samples_leaf=int(params.get('min_samples_leaf', 1)),
        n_jobs=int(params.get('n_jobs', -1)),
        random_state=config.GLOBAL_SEED,
        class_weight='balanced'
    )
    rf_final.fit(X_all, y_all)

    del X_all, y_all
    gc.collect()

    out_model = os.path.join(config.DIR_MODELS, f'rf_{area_name}.pkl')
    joblib.dump(rf_final, out_model, compress=3)
    params_io.salvar('RF', area_name, params)
    events.emit('train', status='end', model='RF', area=area_name, ok=True, secs=round(time.time() - _t0, 1),
                linhas=_n_linhas, positivos=_n_pos)
    del rf_final
    gc.collect()
    print(f"   -> Modelo salvo: {out_model}")
    print("   -> Previsões serão geradas pelo step9_predict (pipeline de previsão).")

def run_step3(target_area=None, fast_training=False):
    import random
    random.seed(config.GLOBAL_SEED)
    np.random.seed(config.GLOBAL_SEED)
    print("=== PASSO 3: TREINAMENTO RANDOM FOREST (COMPRESSÃO ATIVADA) ===")
    pattern = os.path.join(config.DIR_DATASETS, "dataset_full_*.csv")
    files = glob.glob(pattern)
    available_areas = sorted([os.path.basename(f).replace("dataset_full_", "").replace(".csv", "") for f in files])
    
    if target_area and target_area in available_areas:
        train_rf_single_area(target_area, fast_training)
    else:
        for area in available_areas:
            train_rf_single_area(area, fast_training)

if __name__ == "__main__":
    run_step3(target_area=None)