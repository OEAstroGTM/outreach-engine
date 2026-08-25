import requests
from config import (
    EMAILBISON_SEND_URL, EMAILBISON_SEND_API_KEY,
    EMAILBISON_PERSONAL_URL, EMAILBISON_PERSONAL_API_KEY,
    INSTANTLY_SUPPLY_WISDOM_API_KEY, INSTANTLY_LEND_HOME_API_KEY, INSTANTLY_SURETY_NOW_API_KEY,
)

INSTANTLY_BASE = "https://api.instantly.ai/api/v1"

INSTANTLY_KEYS = {
    "supply_wisdom": INSTANTLY_SUPPLY_WISDOM_API_KEY,
    "lend_home": INSTANTLY_LEND_HOME_API_KEY,
    "surety_now": INSTANTLY_SURETY_NOW_API_KEY,
}

# ── Client state ──────────────────────────────────────────────────────────────

_client: dict = {}

def set_client(config: dict) -> None:
    global _client
    _client = config


def get_campaign_tools():
    return [
        {
            "name": "list_campaigns",
            "description": "List all active outreach campaigns.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison_send", "emailbison_personal", "instantly"]},
                    "instantly_workspace": {"type": "string", "enum": ["supply_wisdom", "lend_home", "surety_now"], "description": "Required if platform is instantly"},
                },
                "required": ["platform"],
            },
        },
        {
            "name": "create_campaign",
            "description": "Create a new outreach campaign with a name and subject line.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison_send", "emailbison_personal", "instantly"]},
                    "instantly_workspace": {"type": "string", "enum": ["supply_wisdom", "lend_home", "surety_now"]},
                    "name": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                },
                "required": ["platform", "name", "subject", "body"],
            },
        },
        {
            "name": "add_leads_to_campaign",
            "description": "Add a list of leads to an existing campaign.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison_send", "emailbison_personal", "instantly"]},
                    "instantly_workspace": {"type": "string", "enum": ["supply_wisdom", "lend_home", "surety_now"]},
                    "campaign_id": {"type": "string"},
                    "leads": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "email": {"type": "string"},
                                "first_name": {"type": "string"},
                                "last_name": {"type": "string"},
                                "company": {"type": "string"},
                            },
                        },
                    },
                },
                "required": ["platform", "campaign_id", "leads"],
            },
        },
        {
            "name": "launch_campaign",
            "description": "Launch or resume a campaign so emails start sending.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison_send", "emailbison_personal", "instantly"]},
                    "instantly_workspace": {"type": "string", "enum": ["supply_wisdom", "lend_home", "surety_now"]},
                    "campaign_id": {"type": "string"},
                },
                "required": ["platform", "campaign_id"],
            },
        },
        {
            "name": "get_campaign_stats",
            "description": "Get open rates, reply rates, and bounce rates for a campaign.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison_send", "emailbison_personal", "instantly"]},
                    "instantly_workspace": {"type": "string", "enum": ["supply_wisdom", "lend_home", "surety_now"]},
                    "campaign_id": {"type": "string"},
                },
                "required": ["platform", "campaign_id"],
            },
        },
    ]


def _eb_headers(platform: str):
    if platform == "emailbison_send":
        return {"Authorization": f"Bearer {EMAILBISON_SEND_API_KEY}"}, EMAILBISON_SEND_URL
    return {"Authorization": f"Bearer {EMAILBISON_PERSONAL_API_KEY}"}, EMAILBISON_PERSONAL_URL


def execute_campaign_tool(tool_name: str, tool_input: dict):
    platform = tool_input.get("platform", "emailbison_send")
    if tool_name == "list_campaigns":
        return _list_campaigns(platform, tool_input)
    elif tool_name == "create_campaign":
        return _create_campaign(platform, tool_input)
    elif tool_name == "add_leads_to_campaign":
        return _add_leads(platform, tool_input)
    elif tool_name == "launch_campaign":
        return _launch_campaign(platform, tool_input)
    elif tool_name == "get_campaign_stats":
        return _get_stats(platform, tool_input)
    return None


def _list_campaigns(platform: str, params: dict):
    try:
        if platform.startswith("emailbison"):
            headers, base_url = _eb_headers(platform)
            r = requests.get(f"{base_url}/api/campaigns", headers=headers)
            return r.json()
        elif platform == "instantly":
            ws = params.get("instantly_workspace", "supply_wisdom")
            r = requests.get(f"{INSTANTLY_BASE}/campaign/list", params={"api_key": INSTANTLY_KEYS[ws]})
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _create_campaign(platform: str, params: dict):
    try:
        if platform.startswith("emailbison"):
            headers, base_url = _eb_headers(platform)
            r = requests.post(f"{base_url}/api/campaigns", headers=headers, json={
                "name": params["name"],
                "subject": params["subject"],
                "body": params["body"],
            })
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _add_leads(platform: str, params: dict):
    try:
        if platform.startswith("emailbison"):
            headers, base_url = _eb_headers(platform)
            r = requests.post(f"{base_url}/api/campaigns/{params['campaign_id']}/leads",
                              headers=headers, json={"leads": params["leads"]})
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _launch_campaign(platform: str, params: dict):
    try:
        if platform.startswith("emailbison"):
            headers, base_url = _eb_headers(platform)
            r = requests.post(f"{base_url}/api/campaigns/{params['campaign_id']}/launch", headers=headers)
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _get_stats(platform: str, params: dict):
    try:
        if platform.startswith("emailbison"):
            headers, base_url = _eb_headers(platform)
            r = requests.get(f"{base_url}/api/campaigns/{params['campaign_id']}/stats", headers=headers)
            return r.json()
    except Exception as e:
        return {"error": str(e)}
