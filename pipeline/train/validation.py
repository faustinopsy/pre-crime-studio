"""
Arquivo: src/validation_framework.py
Descrição: Framework de Validação Científica (Walk-Forward) + Geração de Gráficos Ricos.
"""
import pandas as pd
import numpy as np

import os
from pipeline import config
from sklearn.metrics import precision_score, recall_score, roc_auc_score, confusion_matrix, accuracy_score, f1_score
import os
from pipeline import config

class TimeSeriesValidator:
    def __init__(self, df, date_col='data'):
        self.df = df.copy()
        self.df[date_col] = pd.to_datetime(self.df[date_col])
        self.df = self.df.sort_values(date_col)
        self.date_col = date_col
        
    def walk_forward_split(self):
        """
        Gerador que cria janelas de Treino e Teste avançando no tempo.
        """
        start_date = pd.to_datetime(f"{config.VALIDATION_START_YEAR}-01-01")
        max_date = self.df[self.date_col].max()
        
        current_cutoff = start_date
        
        fold = 1
        while current_cutoff < max_date:
            # Janela de Teste: Próximo Mês (ou o horizonte definido no target t+4)
            test_end = current_cutoff + pd.DateOffset(weeks=4)
            
            train_idx = self.df[self.df[self.date_col] < current_cutoff].index
            test_idx = self.df[(self.df[self.date_col] >= current_cutoff) & 
                               (self.df[self.date_col] < test_end)].index
            
            if len(test_idx) == 0:
                break
                
            yield fold, train_idx, test_idx, current_cutoff
            
            # Avança a janela (ex: 3 meses)
            current_cutoff = current_cutoff + pd.DateOffset(months=config.VALIDATION_STEP_MONTHS)
            fold += 1

def evaluate_predictions(y_true, y_prob, threshold=None):
    """
    Calcula métricas rigorosas: Precision, Recall, Matriz de Confusão.
    """
    if threshold is None:
        threshold = np.quantile(y_prob, config.HOTSPOT_QUANTILE)
        
    y_pred = (y_prob >= threshold).astype(int)
    
    # Garante binário
    y_true_bin = (y_true > 0).astype(int)
    
    prec = precision_score(y_true_bin, y_pred, zero_division=0)
    rec = recall_score(y_true_bin, y_pred, zero_division=0)
    
    try:
        auc = roc_auc_score(y_true_bin, y_prob)
    except:
        auc = 0.5
        
    # Extrai Matriz de Confusão
    tn, fp, fn, tp = confusion_matrix(y_true_bin, y_pred, labels=[0, 1]).ravel()
    
    return {
        'Precision': prec,
        'Recall': rec,
        'AUC': auc,
        'TN': tn, 'FP': fp, 'FN': fn, 'TP': tp,
        'Threshold': threshold
    }

def plot_confusion_matrix_heatmap(y_true, y_prob, model_name, area_name, output_dir, threshold=None):
    """
    Gera e salva a Matriz de Confusão com métricas (Acurácia, F1, etc) escritas na imagem.
    """
    # Importação tardia para não poluir/desacelerar o start do pipeline
    import matplotlib
    matplotlib.use('Agg') 
    import matplotlib.pyplot as plt
    import seaborn as sns

    # Garante que o diretório existe
    os.makedirs(output_dir, exist_ok=True)

    # Recalcula o threshold se não fornecido
    if threshold is None:
        threshold = np.quantile(y_prob, config.HOTSPOT_QUANTILE)
    
    # Prepara dados
    y_pred = (y_prob >= threshold).astype(int)
    y_true_bin = (y_true > 0).astype(int)
    
    # Cálculos estatísticos
    cm = confusion_matrix(y_true_bin, y_pred)
    acc = accuracy_score(y_true_bin, y_pred)
    prec = precision_score(y_true_bin, y_pred, zero_division=0)
    rec = recall_score(y_true_bin, y_pred, zero_division=0)
    f1 = f1_score(y_true_bin, y_pred, zero_division=0)
    
    # Labels Ricos (Quantidade + Porcentagem)
    group_names = ['Verdadeiro Negativo\n(Correto)', 'Falso Positivo\n(Alarme Falso)', 
                   'Falso Negativo\n(Perdeu Crime)', 'Verdadeiro Positivo\n(Capturou)']
    group_counts = ["{0:0.0f}".format(value) for value in cm.flatten()]
    group_percentages = ["{0:.2%}".format(value) for value in cm.flatten()/np.sum(cm)]
    
    labels = [f"{v1}\n{v2}\n({v3})" for v1, v2, v3 in zip(group_names, group_counts, group_percentages)]
    labels = np.asarray(labels).reshape(2,2)

    # Limpa memória gráfica
    plt.clf()
    plt.figure(figsize=(10, 8))
    
    # Heatmap
    sns.heatmap(cm, annot=labels, fmt='', cmap='Blues', cbar=False, 
                annot_kws={"size": 11, "weight": "bold"}, 
                xticklabels=['Pred: Não Crime', 'Pred: Crime'],
                yticklabels=['Real: Não Crime', 'Real: Crime'])
    
    # Título Principal
    plt.title(f"Matriz de Confusão: {model_name} - {area_name}", fontsize=16, pad=20)
    
    # Texto de Métricas no Rodapé
    metrics_text = (
        f"METRICAS DE PERFORMANCE:\n"
        f"• Acurácia: {acc:.2%} (Acerto Geral)\n"
        f"• Precisão: {prec:.2%} (Quando alerta, é crime?)\n"
        f"• Recall:   {rec:.2%} (Quantos crimes pegou?)\n"
        f"• F1-Score: {f1:.4f} (Equilíbrio)\n"
        f"• Threshold usado: {threshold:.4f}"
    )
    plt.xlabel(f"\nPredição do Modelo\n\n{'-'*40}\n{metrics_text}", fontsize=12)
    plt.ylabel('Realidade (Verdade)', fontsize=12)
    
    # Salvar
    out_path = os.path.join(output_dir, f'cm_{model_name}_{area_name}.png')
    plt.savefig(out_path, dpi=300, bbox_inches='tight')
    plt.close() # Fecha explicitamente para liberar memória
    
    print(f"   -> Matriz de Confusão Rica salva: {out_path}")

def save_metrics_csv(metrics_list, model_name, area_name, output_dir):
    """Salva o histórico de validação (CSV) para análise científica."""
    os.makedirs(output_dir, exist_ok=True)
    df = pd.DataFrame(metrics_list)
    out_path = os.path.join(output_dir, f'metrics_{model_name}_{area_name}.csv')
    df.to_csv(out_path, index=False)
    print(f"   -> Tabela de Métricas salva: {out_path}")