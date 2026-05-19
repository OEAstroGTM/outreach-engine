import requests
from config import (
    EMAILBISON_SEND_URL, EMAILBISON_SEND_API_KEY,
    EMAILBISON_PERSONAL_URL, EMAILBISON_PERSONAL_API_KEY,
    INSTANTLY_KEYS,
)

# ── Client state ──────────────────────────────────────────────────────────────
# Set once per session by brain/agent.py via set_client().

_client: dict = {}

def set_client(config: dict) -> None:
    global _client
    _client = config


# ── EmailBison helpers ────────────────────────────────────────────────────────

_EB_INSTANCES = {
    "eb_send":     (EMAILBISON_SEND_URL,     EMAILBISON_SEND_API_KEY),
    "eb_personal": (EMAILBISON_PERSONAL_URL, EMAILBISON_PERSONAL_API_KEY),
}

def _eb_session() -> tuple[requests.Session, str] | tuple[None, None]:
    sequencer = _client.get("sequencer", "")
    ws_id     = _client.get("eb_ws_id")
    base_url, api_key = _EB_INSTANCES.get(sequencer, (None, None))
    if not base_url or not api_key or not ws_id:
        return None, None
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"})
    s.post(f"{base_url}/api/workspaces/v1.1/switch-workspace", json={"team_id": ws_id}, timeout=10)
    return s, f"{base_url}/api"


def _instantly_key() -> str | None:
    ws = _client.get("instantly_ws")
    return INSTANTLY_KEYS.get(ws) if ws else None


# ── Tool schemas ──────────────────────────────────────────────────────────────

def get_campaign_tools():
    return [
        {
            "name": "list_campaigns",
            "description": "List all campaigns for the current client.",
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
        {
            "name": "create_campaign",
            "description": "Create a new outreach campaign for the current client.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Campaign name"},
                },
                "required": ["name"],
            },
        },
        {
            "name": "get_campaign_stats",
            "description": "Get stats for a specific campaign (sent, replies, interested, bounces).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "campaign_id": {"type": "string"},
                },
                "required": ["campaign_id"],
            },
        },
        {
            "name": "launch_campaign",
            "description": "Launch (activate) a campaign so it starts sending.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "campaign_id": {"type": "string"},
                },
                "required": ["campaign_id"],
            },
        },
        {
            "name": "pause_campaign",
            "description": "Pause a running campaign.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "campaign_id": {"type": "string"},
                },
                "required": ["campaign_id"],
            },
        },
        {
            "name": "add_leads_to_campaign",
            "description": "Add leads to a campaign by lead IDs or a saved lead list ID.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "campaign_id": {"type": "string"},
                    "lead_ids":    {"type": "array", "items": {"type": "number"}, "description": "Individual lead IDs"},
                    "lead_list_id": {"type": "number", "description": "Saved lead list ID (adds all leads in the list)"},
                },
                "required": ["campaign_id"],
            },
        },
        {
            "name": "create_lead",
            "description": "Create a new lead (contact) for the current client.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "email":      {"type": "string"},
                    "first_name": {"type": "string"},
                    "last_name":  {"type": "string"},
                    "company":    {"type": "string"},
                    "website":    {"type": "string"},
                },
                "required": ["email"],
            },
        },
    ]


# ── Executor ──────────────────────────────────────────────────────────────────

def execute_campaign_tool(tool_name: str, tool_input: dict):
    if tool_name == "list_campaigns":       return _list_campaigns()
    if tool_name == "create_campaign":      return _create_campaign(tool_input)
    if tool_name == "get_campaign_stats":   return _get_stats(tool_input)
    if tool_name == "launch_campaign":      return _launch_campaign(tool_input)
    if tool_name == "pause_campaign":       return _pause_campaign(tool_input)
    if tool_name == "add_leads_to_campaign": return _add_leads(tool_input)
    if tool_name == "create_lead":          return _create_lead(tool_input)
    return None


# ── EmailBison implementations ────────────────────────────────────────────────

def _list_campaigns():
    sequencer = _client.get("sequencer", "")
    if sequencer in ("eb_send", "eb_personal"):
        s, base = _eb_session()
        if not s:
            return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
        try:
            return s.get(f"{base}/campaigns", timeout=10).json()
        except Exception as e:
            return {"error": str(e)}

    if sequencer == "instantly":
        key = _instantly_key()
        if not key:
            return {"error": f"Instantly API key not configured for client '{_client.get('name')}'"}
        try:
            r = requests.get(
                "https://api.instantly.ai/api/v2/campaigns",
                headers={"Authorization": f"Bearer {key}"},
                params={"limit": 100},
                timeout=10,
            )
            return r.json()
        except Exception as e:
            return {"error": str(e)}

    return {"error": f"No sequencer configured for client '{_client.get('name')}'"}


def _create_campaign(params: dict):
    s, base = _eb_session()
    if not s:
        return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
    try:
        return s.post(f"{base}/campaigns", json={"name": params["name"]}, timeout=10).json()
    except Exception as e:
        return {"error": str(e)}


def _get_stats(params: dict):
    s, base = _eb_session()
    if not s:
        return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
    try:
        return s.get(f"{base}/campaigns/{params['campaign_id']}", timeout=10).json()
    except Exception as e:
        return {"error": str(e)}


def _launch_campaign(params: dict):
    s, base = _eb_session()
    if not s:
        return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
    try:
        return s.patch(f"{base}/campaigns/{params['campaign_id']}", json={"status": "active"}, timeout=10).json()
    except Exception as e:
        return {"error": str(e)}


def _pause_campaign(params: dict):
    s, base = _eb_session()
    if not s:
        return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
    try:
        return s.post(f"{base}/campaigns/{params['campaign_id']}/pause", timeout=10).json()
    except Exception as e:
        return {"error": str(e)}


def _add_leads(params: dict):
    s, base = _eb_session()
    if not s:
        return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
    try:
        cid = params["campaign_id"]
        if "lead_list_id" in params:
            return s.post(f"{base}/campaigns/{cid}/leads/attach-lead-list",
                          json={"lead_list_id": params["lead_list_id"]}, timeout=10).json()
        return s.post(f"{base}/campaigns/{cid}/leads/attach-leads",
                      json={"lead_ids": params.get("lead_ids", [])}, timeout=10).json()
    except Exception as e:
        return {"error": str(e)}


def _create_lead(params: dict):
    s, base = _eb_session()
    if not s:
        return {"error": f"EmailBison not configured for client '{_client.get('name')}'"}
    try:
        return s.post(f"{base}/leads", json=params, timeout=10).json()
    except Exception as e:
        return {"error": str(e)}
