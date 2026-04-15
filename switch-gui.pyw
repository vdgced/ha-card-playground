"""
Bascule ha-card-playground : DEV ↔ HACS PROD
Double-clic sur switch-gui.pyw pour lancer (pas de fenêtre console)
"""

import tkinter as tk
import threading
import urllib.request
import json
import os
import re
import sys
import subprocess

# ── Configuration (lue depuis switch-config.json) ──────────────────────────────
_script_dir = os.path.dirname(os.path.abspath(__file__))
_cfg_path   = os.path.join(_script_dir, "switch-config.json")

if not os.path.exists(_cfg_path):
    import tkinter.messagebox as mb
    tk.Tk().withdraw()
    mb.showerror("Configuration manquante",
        "switch-config.json introuvable.\n\n"
        "Copie switch-config.example.json → switch-config.json\n"
        "et remplis tes valeurs.")
    sys.exit(1)

_cfg = json.loads(open(_cfg_path, encoding="utf-8").read())

HA_CONFIG    = _cfg["HA_CONFIG"].replace("/", "\\")
HA_URL       = _cfg["HA_URL"]
HA_TOKEN     = _cfg["HA_TOKEN"]
DEV_URL      = _cfg["DEV_URL"]
HACS_BASE    = "/local/community/ha-card-playground/ha-card-playground.js"
OLD_PROD_URL = "/local/ha-card-playground.js"   # ancienne URL prod manuelle

# Lire la version depuis package.json
try:
    _pkg = json.loads(open(os.path.join(_script_dir, "package.json"), encoding="utf-8").read())
    VERSION  = _pkg.get("version", "0.0.0")
except Exception:
    VERSION = "0.0.0"
HACS_URL = f"{HACS_BASE}?v={VERSION}"

# ── Logique ────────────────────────────────────────────────────────────────────
def read_config():
    with open(HA_CONFIG, "r", encoding="utf-8") as f:
        return f.read()

def write_config(content):
    with open(HA_CONFIG, "w", encoding="utf-8") as f:
        f.write(content)

def restart_ha():
    req = urllib.request.Request(
        f"{HA_URL}/api/services/homeassistant/restart",
        method="POST",
        headers={"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"},
        data=b"{}"
    )
    urllib.request.urlopen(req, timeout=10)

def detect_mode(config):
    if DEV_URL in config:
        return "dev"
    if HACS_BASE in config:   # substring → détecte avec ou sans ?v=
        return "hacs"
    if OLD_PROD_URL in config:
        return "old_prod"
    return "unknown"

def open_dev_console():
    """Ouvre un terminal cmd avec npm run serve dans le dossier projet."""
    cmd = f'cmd.exe /c start cmd /k "cd /d "{_script_dir}" && npm run serve"'
    subprocess.Popen(cmd, shell=False, executable='cmd.exe',
                     creationflags=subprocess.CREATE_NEW_CONSOLE)

def switch_to(target, app):
    app.set_status("En cours...", "#f0a500")
    app.btn_dev.config(state="disabled")
    app.btn_hacs.config(state="disabled")

    def run():
        try:
            config  = read_config()
            current = detect_mode(config)

            if current == target:
                app.after(0, lambda: app.set_status(
                    f"Déjà en mode {target.upper()}.", "#888888"))
                if target == "dev":
                    open_dev_console()
                return

            # Remplacer l'URL — regex pour gérer ?v=... sur l'URL HACS
            if current == "hacs" or current == "old_prod":
                # Matcher HACS_BASE avec éventuel ?v=... ou ancienne URL
                new_config = re.sub(
                    r'/local/(?:community/ha-card-playground/ha-card-playground|ha-card-playground)\.js(?:\?v=[^\s"\']*)?',
                    DEV_URL if target == "dev" else HACS_URL,
                    config
                )
            else:
                # DEV → HACS
                new_config = config.replace(DEV_URL, HACS_URL)

            write_config(new_config)
            restart_ha()

            label = "HACS PROD" if target == "hacs" else "DEV"
            app.after(0, lambda: app.update_mode(
                target, f"✅ Basculé en {label} — HA redémarre (~30s)"))

            if target == "dev":
                open_dev_console()

        except Exception as e:
            app.after(0, lambda: app.set_status(f"❌ {e}", "#e05252"))
        finally:
            app.after(0, lambda: [
                app.btn_dev.config(state="normal"),
                app.btn_hacs.config(state="normal"),
            ])

    threading.Thread(target=run, daemon=True).start()


# ── Interface ──────────────────────────────────────────────────────────────────
class App(tk.Tk):
    BG      = "#16213e"
    BTN_DEV = "#0078d4"
    BTN_HA  = "#41bdf5"

    def __init__(self):
        super().__init__()
        self.title("HA Card Playground")
        self.resizable(False, False)
        self.configure(bg=self.BG)

        try:
            current = detect_mode(read_config())
        except Exception:
            current = "unknown"

        # Titre
        tk.Label(self, text="HA Card Playground", font=("Segoe UI", 14, "bold"),
                 bg=self.BG, fg="white").pack(pady=(24, 4))

        # Mode actuel
        self.mode_lbl = tk.Label(self, text="", font=("Segoe UI", 10),
                                 bg=self.BG, fg="#aaaaaa")
        self.mode_lbl.pack(pady=(0, 18))
        self._refresh_mode(current)

        # Boutons
        frm = tk.Frame(self, bg=self.BG)
        frm.pack(padx=36, pady=(0, 10))

        self.btn_dev = tk.Button(
            frm, text="DEV", width=13, height=2,
            font=("Segoe UI", 11, "bold"),
            bg=self.BTN_DEV, fg="white", relief="flat", cursor="hand2",
            activebackground="#005ea8", activeforeground="white",
            command=lambda: switch_to("dev", self)
        )
        self.btn_dev.grid(row=0, column=0, padx=8)

        self.btn_hacs = tk.Button(
            frm, text="HACS PROD", width=13, height=2,
            font=("Segoe UI", 11, "bold"),
            bg=self.BTN_HA, fg="#16213e", relief="flat", cursor="hand2",
            activebackground="#28a8d8", activeforeground="#16213e",
            command=lambda: switch_to("hacs", self)
        )
        self.btn_hacs.grid(row=0, column=1, padx=8)

        # Status
        self.status_lbl = tk.Label(self, text="", font=("Segoe UI", 9),
                                   bg=self.BG, fg="#aaaaaa", wraplength=300)
        self.status_lbl.pack(pady=(6, 24))

    def _refresh_mode(self, mode):
        if mode == "dev":
            self.mode_lbl.config(text="● Mode actuel : DEV", fg=self.BTN_DEV)
        elif mode == "hacs":
            self.mode_lbl.config(text="● Mode actuel : HACS PROD", fg=self.BTN_HA)
        elif mode == "old_prod":
            self.mode_lbl.config(text="● Mode actuel : PROD (ancienne version)", fg="#f0a500")
        else:
            self.mode_lbl.config(text="● Mode actuel : inconnu", fg="#888888")

    def update_mode(self, mode, msg):
        self._refresh_mode(mode)
        self.set_status(msg, self.BTN_HA)

    def set_status(self, msg, color="#888888"):
        self.status_lbl.config(text=msg, fg=color)


if __name__ == "__main__":
    App().mainloop()
