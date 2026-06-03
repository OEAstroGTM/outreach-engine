import requests
from config import MASTERINBOX_API_KEY

_MI_BASE = "https://api.masterinbox.com/api/api-webhook/v1/api"

# ── Client state ──────────────────────────────────────────────────────────────

_client: dict = {}

def set_client(config: dict) -> None:
    global _client
    _client = config


def _headers() -> dict:
    return {"Authorization": f"Bearer {MASTERINBOX_API_KEY}", "Content-Type": "application/json"}


def _ws_id() -> str | None:
    ws = _client.get("mi_ws_id")
    return str(ws) if ws else None


# ── Tool schemas ──────────────────────────────────────────────────────────────

def get_inbox_tools():
    return [
        {
            "name": "list_replies",
            "description": "List replies/messages for the current client in MasterInbox. Optionally filter by label.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "label_id": {"type": "string", "description": "Filter by label ID — use list_labels to get IDs"},
                    "page":     {"type": "integer", "description": "Page number"},
                    "limit":    {"type": "integer", "description": "Results per page"},
                },
                "required": [],
            },
        },
        {
            "name": "list_labels",
            "description": "List all labels in MasterInbox (e.g. Interested, Not Interested, Demo Booked).",
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
        {
            "name": "get_reply_thread",
            "description": "Get the full conversation thread for a prospect by email or prospect ID.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prospect_email": {"type": "string"},
                    "prospect_id":    {"type": "string"},
                },
                "required": [],
            },
        },
        {
            "name": "tag_reply",
            "description": "Assign a label to a prospect (e.g. mark as Interested).",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prospect_id": {"type": "string"},
                    "label_id":    {"type": "string", "description": "Get label IDs from list_labels"},
                },
                "required": ["prospect_id", "label_id"],
            },
        },
        {
            "name": "send_reply",
            "description": "Send a reply message to a prospect in MasterInbox.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "prospect_id": {"type": "string"},
                    "message":     {"type": "string"},
                },
                "required": ["prospect_id", "message"],
            },
        },
        {
            "name": "find_prospect",
            "description": "Search for a prospect by name, email, or label in the current client workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "search":   {"type": "string", "description": "Name or email to search"},
                    "label_id": {"type": "string"},
                    "page":     {"type": "integer"},
                    "limit":    {"type": "integer"},
                },
                "required": [],
            },
        },
    ]


# ── Executor ──────────────────────────────────────────────────────────────────

def execute_inbox_tool(tool_name: str, tool_input: dict):
    if tool_name == "list_replies":    return _list_replies(tool_input)
    if tool_name == "list_labels":     return _list_labels()
    if tool_name == "get_reply_thread": return _get_thread(tool_input)
    if tool_name == "tag_reply":       return _tag_reply(tool_input)
    if tool_name == "send_reply":      return _send_reply(tool_input)
    if tool_name == "find_prospect":   return _find_prospect(tool_input)
    return None


# ── Implementations ───────────────────────────────────────────────────────────

def _list_replies(params: dict):
    # /get-messages requires a prospect_id (thread lookup only).
    # /get-prospects is the correct endpoint for listing all replies in a workspace.
    try:
        return requests.post(
            f"{_MI_BASE}/get-prospects",
            headers=_headers(),
            json={
                "workspace_id": _ws_id(),
                "label_id":     params.get("label_id"),
                "page":         params.get("page"),
                "limit":        params.get("limit", 20),
            },
            timeout=10,
        ).json()
    except Exception as e:
        return {"error": str(e)}


def _list_labels():
    try:
        return requests.get(f"{_MI_BASE}/get-labels", headers=_headers(), timeout=10).json()
    except Exception as e:
        return {"error": str(e)}


def _get_thread(params: dict):
    try:
        return requests.post(
            f"{_MI_BASE}/get-messages",
            headers=_headers(),
            json={
                "prospect_email": params.get("prospect_email"),
                "prospect_id":    params.get("prospect_id"),
            },
            timeout=10,
        ).json()
    except Exception as e:
        return {"error": str(e)}


def _tag_reply(params: dict):
    try:
        return requests.post(
            f"{_MI_BASE}/add-prospect-label",
            headers=_headers(),
            json={"prospect_id": params["prospect_id"], "label_id": params["label_id"]},
            timeout=10,
        ).json()
    except Exception as e:
        return {"error": str(e)}


def _send_reply(params: dict):
    try:
        return requests.post(
            f"{_MI_BASE}/send-message",
            headers=_headers(),
            json={
                "prospect_id":  params["prospect_id"],
                "message":      params["message"],
                "workspace_id": _ws_id(),
            },
            timeout=10,
        ).json()
    except Exception as e:
        return {"error": str(e)}


def _find_prospect(params: dict):
    try:
        return requests.post(
            f"{_MI_BASE}/get-prospects",
            headers=_headers(),
            json={
                "workspace_id": _ws_id(),
                "search":       params.get("search"),
                "label_id":     params.get("label_id"),
                "page":         params.get("page"),
                "limit":        params.get("limit", 20),
            },
            timeout=10,
        ).json()
    except Exception as e:
        return {"error": str(e)}
