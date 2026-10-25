"""
Arquivo: step4_train_lstm.py
Descrição: Treinamento LSTM com Validação Walk-Forward e Hiperparâmetros do Config.
"""
import pandas as pd
import numpy as np
import os
import glob
import joblib
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset
from sklearn.preprocessing import MinMaxScaler
from pipeline import config
from pipeline.train import validation as vf
from pipeline.train import loader
from pipeline.train import params_io
from pipeline.bridge import events
import time

# Contexto só para os eventos do app (área e etapa em andamento)
_CTX = {'area': None, 'fase': 'final'}
import gc

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
torch.manual_seed(config.GLOBAL_SEED)

class CrimeLSTM(nn.Module):
    def __init__(self, input_dim, hidden_dim, layer_dim, output_dim, dropout_prob):
        super(CrimeLSTM, self).__init__()
        self.hidden_dim = hidden_dim
        self.layer_dim = layer_dim
        self.lstm = nn.LSTM(input_dim, hidden_dim, layer_dim, 
                            batch_first=True, dropout=dropout_prob if layer_dim > 1 else 0)
        self.dropout = nn.Dropout(dropout_prob)
        self.fc1 = nn.Linear(hidden_dim, 32)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(32, output_dim)

    def forward(self, x):
        h0 = torch.zeros(self.layer_dim, x.size(0), self.hidden_dim).to(x.device)
        c0 = torch.zeros(self.layer_dim, x.size(0), self.hidden_dim).to(x.device)
        out, _ = self.lstm(x, (h0, c0))
        out = out[:, -1, :]
        out = self.dropout(out)
        out = self.fc1(out)
        out = self.relu(out)
        out = self.fc2(out)
        return out

def train_model_fold(X_train, y_train, input_dim, params):
    """Treina usando params do config."""
    model = CrimeLSTM(
        input_dim, 
        hidden_dim=params['hidden_dim'], 
        layer_dim=params['layer_dim'], 
        output_dim=1, 
        dropout_prob=params['dropout_prob']
    )
    model.to(DEVICE)
    
    pos_weight = torch.tensor([params['pos_weight']]).to(DEVICE) 
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    
    optimizer = optim.Adam(model.parameters(), lr=params['learning_rate'])
    scaler_amp = torch.amp.GradScaler('cuda') if DEVICE.type == 'cuda' else None
    
    dataset = TensorDataset(torch.from_numpy(X_train), torch.from_numpy(y_train))
    loader = DataLoader(dataset, batch_size=params['batch_size'], shuffle=True, pin_memory=True)
    
    model.train()
    n_batches = len(loader)
    for epoch in range(params['epochs']):
        t_ep = time.time()
        ep_loss = torch.zeros((), device=DEVICE)
        for i_batch, (X_batch, y_batch) in enumerate(loader):
            X_batch, y_batch = X_batch.to(DEVICE), y_batch.to(DEVICE).unsqueeze(1)
            optimizer.zero_grad()
            if scaler_amp:
                with torch.amp.autocast('cuda'):
                    outputs = model(X_batch)
                    loss = criterion(outputs, y_batch)
                scaler_amp.scale(loss).backward()
                scaler_amp.step(optimizer)
                scaler_amp.update()
            else:
                outputs = model(X_batch)
                loss = criterion(outputs, y_batch)
                loss.backward()
                optimizer.step()
            ep_loss += loss.detach().float()
            if events.enabled() and n_batches >= 20 and i_batch % max(1, n_batches // 10) == 0:
                events.progress('train', i_batch, n_batches, model='LSTM', area=_CTX['area'], fase=_CTX['fase'],
                                epoch=epoch + 1, epochs=params['epochs'])
        if events.enabled():
            events.metric('train', 'loss', round(ep_loss.item() / max(1, n_batches), 5), model='LSTM', area=_CTX['area'],
                          fase=_CTX['fase'], epoch=epoch + 1, epochs=params['epochs'], secs=round(time.time() - t_ep, 1))
    return model

def batch_inference(model, X_data, batch_size):
    model.eval()
    dataset = TensorDataset(torch.from_numpy(X_data))
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False)
    probs_list = []
    with torch.no_grad():
        for X_batch, in loader:
            X_batch = X_batch.to(DEVICE)
            logits = model(X_batch)
            probs = torch.sigmoid(logits).cpu().numpy().flatten()
            probs_list.append(probs)
    return np.concatenate(probs_list)

def train_lstm_single_area(area_name, fast_training=False):
    print(f"\n--- Treinando LSTM: {area_name} {'[FAST]' if fast_training else '[FULL]'} ---")
    _CTX['area'] = area_name
    _t0 = time.time()
    events.emit('train', status='start', model='LSTM', area=area_name, device=DEVICE.type)
    
    path_full = os.path.join(config.DIR_DATASETS, f'dataset_full_{area_name}.csv')
    if not os.path.exists(path_full): return

    df_full = loader.load_train_dataset(path_full)
    if df_full is None: return

    validator = vf.TimeSeriesValidator(df_full, date_col='data')
    feature_cols = [c for c in df_full.columns if 'lag_' in c]
    
    X_raw = df_full[feature_cols].values.astype(np.float32)
    y_raw = (df_full['target_month'] > 0).astype(np.float32).values
    
    scaler = MinMaxScaler()
    X_scaled = scaler.fit_transform(X_raw)
    
    n_features = 1
    time_steps = len(feature_cols)
    X_3d = X_scaled.reshape((-1, time_steps, n_features))
    
    # Carrega Params
    params = config.ML_CONFIG['LSTM']
    
        # --- MODO CIENTÍFICO (VALIDAÇÃO) ---
    if not fast_training:
        print("   -> Iniciando Validação Cruzada Temporal...")
        metrics_history = []
        
        for fold, train_idx, test_idx, cutoff in validator.walk_forward_split():
            X_train_f = X_3d[train_idx]
            y_train_f = y_raw[train_idx]
            X_test_f = X_3d[test_idx]
            y_test_f = y_raw[test_idx]
            
            if len(X_test_f) == 0 or y_train_f.sum() == 0: continue
            
            _CTX['fase'] = f'validação {fold}'
            model = train_model_fold(X_train_f, y_train_f, n_features, params)
            probs = batch_inference(model, X_test_f, params['batch_size'])
            
            visual_limit = np.quantile(probs, 0.50) 
            if visual_limit == 0: visual_limit = 0.001
            m = vf.evaluate_predictions(y_test_f, probs, threshold=visual_limit)
            m['Visual_Threshold'] = visual_limit
            metrics_history.append(m)
            events.metric('train', 'auc_fold', round(float(m['AUC']), 4), model='LSTM', area=area_name, fold=fold)
            
            del model
            torch.cuda.empty_cache()

        if metrics_history:
            df_m = pd.DataFrame(metrics_history)
            print(f"   [RESULTADOS] AUC Médio: {df_m['AUC'].mean():.3f}")
            vf.save_metrics_csv(metrics_history, "LSTM", area_name, config.DIR_METRICS)
    
    else:
        print("   [INFO] Modo Rápido: Pulando validação cruzada.")

    # --- TREINO FINAL (PRODUÇÃO) ---
    print("   -> Treinando Modelo Final (Todo Histórico)...")
    _CTX['fase'] = 'final'
    final_model = train_model_fold(X_3d, y_raw, n_features, params)
    final_probs = batch_inference(final_model, X_3d, params['batch_size'])
    
    torch.save(final_model.state_dict(), os.path.join(config.DIR_MODELS, f'lstm_{area_name}.pth'))
    params_io.salvar('LSTM', area_name, params)
    events.emit('train', status='end', model='LSTM', area=area_name, ok=True, secs=round(time.time() - _t0, 1),
                linhas=int(len(y_raw)), positivos=int(y_raw.sum()))
    joblib.dump(scaler, os.path.join(config.DIR_MODELS, f'scaler_lstm_{area_name}.pkl'))
    print(f"   -> Modelo salvo: {config.DIR_MODELS}/lstm_{area_name}.pth")
    print("   -> Previsões serão geradas pelo step9_predict (pipeline de previsão).")
    del final_model, X_3d, X_scaled
    torch.cuda.empty_cache()
    gc.collect()

def run_step3(target_area=None, fast_training=False):
    import random
    random.seed(config.GLOBAL_SEED)
    np.random.seed(config.GLOBAL_SEED)
    torch.manual_seed(config.GLOBAL_SEED)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config.GLOBAL_SEED)
    torch.backends.cudnn.deterministic = True
    print("=== PASSO 3 (Paralelo): TREINAMENTO LSTM (WALK-FORWARD) ===")
    pattern = os.path.join(config.DIR_DATASETS, "dataset_full_*.csv")
    files = glob.glob(pattern)
    areas = sorted([os.path.basename(f).replace("dataset_full_", "").replace(".csv", "") for f in files])
    
    if target_area and target_area in areas:
        train_lstm_single_area(target_area, fast_training)
    else:
        for area in areas:
            train_lstm_single_area(area, fast_training)

if __name__ == "__main__":
    run_step3(target_area=None)