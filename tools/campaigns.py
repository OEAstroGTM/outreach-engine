import requests
from config import EMAILBISON_API_KEY, INSTANTLY_API_KEY

EMAILBISON_BASE = "https://api.emailbison.com/v1"
INSTANTLY_BASE = "https://api.instantly.ai/api/v1"


def get_campaign_tools():
    return [
        {
            "name": "list_campaigns",
            "description": "List all active outreach campaigns.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison", "instantly"], "description": "Which platform to check"},
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
                    "platform": {"type": "string", "enum": ["emailbison", "instantly"]},
                    "name": {"type": "string", "description": "Campaign name"},
                    "subject": {"type": "string", "description": "Email subject line"},
                    "body": {"type": "string", "description": "Email body (plain text or HTML)"},
                },
                "required": ["platform", "name", "subject", "body"],
            },
        },
        {
            "name": "add_leads_to_campaign",
            "description": "Add a list of leads (with emails) to an existing campaign.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "platform": {"type": "string", "enum": ["emailbison", "instantly"]},
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
                    "platform": {"type": "string", "enum": ["emailbison", "instantly"]},
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
                    "platform": {"type": "string", "enum": ["emailbison", "instantly"]},
                    "campaign_id": {"type": "string"},
                },
                "required": ["platform", "campaign_id"],
            },
        },
    ]


def execute_campaign_tool(tool_name: str, tool_input: dict):
    platform = tool_input.get("platform", "emailbison")
    if tool_name == "list_campaigns":
        return _list_campaigns(platform)
    elif tool_name == "create_campaign":
        return _create_campaign(platform, tool_input)
    elif tool_name == "add_leads_to_campaign":
        return _add_leads(platform, tool_input)
    elif tool_name == "launch_campaign":
        return _launch_campaign(platform, tool_input)
    elif tool_name == "get_campaign_stats":
        return _get_stats(platform, tool_input)
    return None


def _list_campaigns(platform: str):
    try:
        if platform == "emailbison":
            r = requests.get(f"{EMAILBISON_BASE}/campaigns", headers={"Authorization": f"Bearer {EMAILBISON_API_KEY}"})
            return r.json()
        elif platform == "instantly":
            r = requests.get(f"{INSTANTLY_BASE}/campaign/list", params={"api_key": INSTANTLY_API_KEY})
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _create_campaign(platform: str, params: dict):
    try:
        if platform == "emailbison":
            r = requests.post(f"{EMAILBISON_BASE}/campaigns", headers={"Authorization": f"Bearer {EMAILBISON_API_KEY}"}, json={
                "name": params["name"],
                "subject": params["subject"],
                "body": params["body"],
            })
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _add_leads(platform: str, params: dict):
    try:
        if platform == "emailbison":
            r = requests.post(f"{EMAILBISON_BASE}/campaigns/{params['campaign_id']}/leads",
                              headers={"Authorization": f"Bearer {EMAILBISON_API_KEY}"},
                              json={"leads": params["leads"]})
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _launch_campaign(platform: str, params: dict):
    try:
        if platform == "emailbison":
            r = requests.post(f"{EMAILBISON_BASE}/campaigns/{params['campaign_id']}/launch",
                              headers={"Authorization": f"Bearer {EMAILBISON_API_KEY}"})
            return r.json()
    except Exception as e:
        return {"error": str(e)}


def _get_stats(platform: str, params: dict):
    try:
        if platform == "emailbison":
            r = requests.get(f"{EMAILBISON_BASE}/campaigns/{params['campaign_id']}/stats",
                             headers={"Authorization": f"Bearer {EMAILBISON_API_KEY}"})
            return r.json()
    except Exception as e:
        return {"error": str(e)}
