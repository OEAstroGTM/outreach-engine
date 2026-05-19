import json
import os
from dotenv import load_dotenv

load_dotenv()

# ── Anthropic ──────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

# ── EmailBison ─────────────────────────────────────────────────────────────
EMAILBISON_SEND_URL     = os.getenv("EMAILBISON_SEND_URL", "https://send.outreachenginedashboard.co")
EMAILBISON_SEND_API_KEY = os.getenv("EMAILBISON_SEND_API_KEY")

EMAILBISON_PERSONAL_URL     = os.getenv("EMAILBISON_PERSONAL_URL", "https://personal.outreachenginedashboard.co")
EMAILBISON_PERSONAL_API_KEY = os.getenv("EMAILBISON_PERSONAL_API_KEY")

# ── Instantly ──────────────────────────────────────────────────────────────
INSTANTLY_SUPPLY_WISDOM_API_KEY = os.getenv("INSTANTLY_SUPPLY_WISDOM_API_KEY")
INSTANTLY_LEND_HOME_API_KEY     = os.getenv("INSTANTLY_LEND_HOME_API_KEY")
INSTANTLY_SURETY_NOW_API_KEY    = os.getenv("INSTANTLY_SURETY_NOW_API_KEY")

# ── MasterInbox ────────────────────────────────────────────────────────────
MASTERINBOX_API_KEY = os.getenv("MASTERINBOX_API_KEY")
MI_JWT              = os.getenv("MI_JWT")   # session JWT — expires periodically

# Per-workspace public keys, keyed by client name
MI_KEYS = {
    "AskTuring":              os.getenv("MI_KEY_ASKTURING"),
    "Braintracks":            os.getenv("MI_KEY_BRAINTRACKS"),
    "Bravura Technologies":   os.getenv("MI_KEY_BRAVURA_TECHNOLOGIES"),
    "Chalktalk":              os.getenv("MI_KEY_CHALKTALK"),
    "Coffee & Contracts":     os.getenv("MI_KEY_COFFEE_AND_CONTRACTS"),
    "Dream It Reel":          os.getenv("MI_KEY_DREAM_IT_REEL"),
    "Hubengage":              os.getenv("MI_KEY_HUBENGAGE"),
    "Intellectible":          os.getenv("MI_KEY_INTELLECTIBLE"),
    "Lend Home Improvements": os.getenv("MI_KEY_LEND_HOME_IMPROVEMENTS"),
    "Nuvo Bath":              os.getenv("MI_KEY_NUVO_BATH"),
    "OR Trax":                os.getenv("MI_KEY_OR_TRAX"),
    "Outreach Engine":        os.getenv("MI_KEY_OUTREACH_ENGINE"),
    "ParGo":                  os.getenv("MI_KEY_PARGO"),
    "Savanti Travel":         os.getenv("MI_KEY_SAVANTI_TRAVEL"),
    "Simplexity":             os.getenv("MI_KEY_SIMPLEXITY"),
    "Supply Wisdom":          os.getenv("MI_KEY_SUPPLY_WISDOM"),
    "True Dial":              os.getenv("MI_KEY_TRUE_DIAL"),
    "Westlink":               os.getenv("MI_KEY_WESTLINK"),
    "Carengen":               os.getenv("MI_KEY_CARENGEN"),
    "Clinintell":             os.getenv("MI_KEY_CLININTELL"),
}

# ── Porkbun ────────────────────────────────────────────────────────────────
PORKBUN_API_KEY        = os.getenv("PORKBUN_API_KEY")
PORKBUN_SECRET_API_KEY = os.getenv("PORKBUN_SECRET_API_KEY")

# ── Winnr ──────────────────────────────────────────────────────────────────
WINNR_LEND_HOME_API_KEY = os.getenv("WINNR_LEND_HOME_API_KEY")

# ── Inboxing ───────────────────────────────────────────────────────────────
INBOXING_API_KEY = os.getenv("INBOXING_API_KEY")

# ── Client manifest ────────────────────────────────────────────────────────
# Non-secret workspace IDs and routing config. Loaded from clients.json.
# Each entry has: name, sequencer, eb_ws_id, mi_ws_id, mi_key_env, inboxing_tags
_CLIENTS_PATH = os.path.join(os.path.dirname(__file__), "clients.json")
with open(_CLIENTS_PATH) as _f:
    CLIENTS_RAW = json.load(_f)

# Resolve mi_pk from env for each client
CLIENTS = []
for _c in CLIENTS_RAW:
    _c = dict(_c)
    _c["mi_pk"] = MI_KEYS.get(_c["name"])
    CLIENTS.append(_c)

# ── Model ──────────────────────────────────────────────────────────────────
CLAUDE_MODEL = "claude-sonnet-4-6"
