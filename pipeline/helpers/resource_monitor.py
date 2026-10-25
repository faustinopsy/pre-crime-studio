"""
Arquivo: src/resource_monitor.py
Descrição: Monitor de recursos (Tempo, RAM, CPU) implementado como Context Manager.
Permite medir blocos de código usando a sintaxe 'with'.
"""

import time
import os
import psutil
from datetime import datetime
from pipeline.bridge import events

class ResourceMonitor:
    def __init__(self, task_name):
        self.task_name = task_name
        self.process = psutil.Process(os.getpid())
        self.start_time = None
        self.start_cpu = None
        
    def __enter__(self):
        # Captura estado inicial
        print(f"\n" + "="*60)
        print(f"⏱️  INICIANDO: {self.task_name}")
        print(f"    Data/Hora: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("="*60)
        
        self.start_time = time.time()
        self.start_cpu = time.process_time() # Tempo de CPU do processo
        events.stage_start(self.task_name, self.task_name)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # Captura estado final
        end_time = time.time()
        end_cpu = time.process_time()
        
        # Cálculos de Tempo
        duration = end_time - self.start_time
        cpu_duration = end_cpu - self.start_cpu
        
        # Cálculos de Memória (RAM usada pelo processo atual)
        mem_info = self.process.memory_info()
        rss_mb = mem_info.rss / (1024 * 1024)  # Resident Set Size em MB
        
        # Formatação
        status = "❌ FALHA" if exc_type else "✅ SUCESSO"
        
        print("-" * 60)
        print(f"🏁 FIM: {self.task_name} [{status}]")
        print(f"    ⏳ Duração Real:   {self._format_duration(duration)}")
        print(f"    💻 Tempo de CPU:   {cpu_duration:.2f}s")
        print(f"    🧠 Uso de RAM:     {rss_mb:.2f} MB (Atual do Processo)")
        print("-" * 60 + "\n")
        events.stage_end(self.task_name, ok=exc_type is None, secs=round(duration, 2),
                         cpu_secs=round(cpu_duration, 2), rss_mb=round(rss_mb, 1))

        # Não suprime exceções (deixa o erro subir se houver)
        return False

    def _format_duration(self, seconds):
        if seconds < 60:
            return f"{seconds:.2f} segundos"
        else:
            m, s = divmod(seconds, 60)
            return f"{int(m)}m {int(s)}s"

# Função auxiliar para imprimir headers simples se não quiser medir
def print_simple_header(msg):
    print("\n" + "="*60)
    print(f"{msg.center(60)}")
    print("="*60 + "\n")