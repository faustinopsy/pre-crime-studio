"""
Arquivo: step5_train_transformer.py
Descrição: Treinamento Transformer com Validação Walk-Forward e Hiperparâmetros do Config.
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

class CrimeTransformer(nn.Module):
    def __init__(self, input_dim, embed_dim, num_heads, ff_dim, num_layers, output_dim, dropout_prob):
        super(CrimeTransformer, self).__init__()
        
        self.embedding = nn.Linear(input_dim, embed_dim)
        self.pos_encoder = nn.Parameter(torch.zeros(1, 100, embed_dim)) 
        
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=embed_dim, 
            nhead=num_heads, 
            dim_feedforward=ff_dim, 
            dropout=dropout_prob,
            batch_first=True
        )
        self.transformer_encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        
        self.global_pool = nn.AdaptiveAvgPool1d(1) 
        self.dropout = nn.Dropout(dropout_prob)
        self.fc1 = nn.Linear(embed_dim, 20)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(20, output_dim)

    def forward(self, x):
        x = self.embedding(x) 
        seq_len = x.size(1)
        if seq_len > self.pos_encoder.size(1):
            resized_pos = nn.functional.interpolate(
                self.pos_encoder.permute(0,2,1), size=seq_len, mode='linear'
            ).permute(0,2,1)
            x = x + resized_pos
        else:
            x = x + self.pos_encoder[:, :seq_len, :]
        
        x = self.transformer_encoder(x)
        x = x.permute(0, 2, 1) 
        x = self.global_pool(x).squeeze(-1) 
        x = self.dropout(x)
        x = self.fc1(x)
        x = self.relu(x)
        x = self.fc2(x)
        return x

def train_model_fold(X_train, y_train, input_dim, params):
    """Treina usando params do config."""
    model = CrimeTransformer(
        input_dim=input_dim, 
        embed_dim=params['embed_dim'], 
        num_heads=params['num_heads'], 
        ff_dim=params['ff_dim'], 
        num_layers=params['num_layers'], 
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
                events.progress('train', i_batch, n_batches, model='Transformer', area=_CTX['area'], fase=_CTX['fase'],
                                epoch=epoch + 1, epochs=params['epochs'])
        if events.enabled():
            events.metric('train', 'loss', round(ep_loss.item() / max(1, n_batches), 5), model='Transformer', area=_CTX['area'],
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

def train_transformer_single_area(area_name, fast_training=False):
    print(f"\n--- Treinando Transformer: {area_name} {'[FAST]' if fast_training else '[FULL]'} ---")
    _CTX['area'] = area_name
    _t0 = time.time()
    events.emit('train', status='start', model='Transformer', area=area_name, device=DEVICE.type)
    
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
    params = config.ML_CONFIG['Transformer']
    
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
            events.metric('train', 'auc_fold', round(float(m['AUC']), 4), model='Transformer', area=area_name, fold=fold)
            del model
            torch.cuda.empty_cache()

        if metrics_history:
            df_m = pd.DataFrame(metrics_history)
            print(f"   [RESULTADOS] AUC Médio: {df_m['AUC'].mean():.3f}")
            vf.save_metrics_csv(metrics_history, "Transformer", area_name, config.DIR_METRICS)
    else:
        print("   [INFO] Modo Rápido: Pulando validação cruzada.")
    

    # --- TREINO FINAL (PRODUÇÃO) ---
    print("   -> Treinando Modelo Final (Todo Histórico)...")
    _CTX['fase'] = 'final'
    final_model = train_model_fold(X_3d, y_raw, n_features, params)
    final_probs = batch_inference(final_model, X_3d, params['batch_size'])
    
    torch.save(final_model.state_dict(), os.path.join(config.DIR_MODELS, f'transformer_{area_name}.pth'))
    params_io.salvar('Transformer', area_name, params)
    events.emit('train', status='end', model='Transformer', area=area_name, ok=True, secs=round(time.time() - _t0, 1),
                linhas=int(len(y_raw)), positivos=int(y_raw.sum()))
    joblib.dump(scaler, os.path.join(config.DIR_MODELS, f'scaler_transformer_{area_name}.pkl'))
    print(f"   -> Modelo salvo: {config.DIR_MODELS}/transformer_{area_name}.pth")
    print("   -> Previsões serão geradas pelo step9_predict (pipeline de previsão).")
    del final_model, X_3d
    torch.cuda.empty_cache()
    gc.collect()

def run_step3(target_area=None, fast_training=False):
    import random
    random.seed(config.GLOBAL_SEED)
    np.random.seed(config.GLOBAL_SEED)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(config.GLOBAL_SEED)
    torch.manual_seed(config.GLOBAL_SEED)
    torch.backends.cudnn.deterministic = True
    print("=== PASSO 3-C (Paralelo): TREINAMENTO TRANSFORMER (WALK-FORWARD) ===")
    pattern = os.path.join(config.DIR_DATASETS, "dataset_full_*.csv")
    files = glob.glob(pattern)
    areas = sorted([os.path.basename(f).replace("dataset_full_", "").replace(".csv", "") for f in files])
    
    if target_area and target_area in areas:
        train_transformer_single_area(target_area, fast_training)
    else:
        for area in areas:
            train_transformer_single_area(area, fast_training)

if __name__ == "__main__":
    run_step3(target_area=None)