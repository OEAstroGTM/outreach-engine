import requests
from config import MASTERINBOX_API_KEY

MASTERINBOX_BASE = "https://api.masterinbox.io/v1"


def get_inbox_tools():
    return [
        {
            "name": "list_replies",
            "description": "List recent email replies across all inboxes.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Max replies to return", "default": 20},
                    "label": {"type": "string", "description": "Filter by label, e.g. 'interested', 'not_interested'"},
                },
                "required": [],
            },
        },
        {
            "name": "get_reply_thread",
            "description": "Get the full conversation thread for a specific reply.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                },
                "required": ["thread_id"],
            },
        },
        {
            "name": "tag_reply",
            "description": "Tag a reply as interested, not interested, follow-up, etc.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "tag": {"type": "string", "enum": ["interested", "not_interested", "follow_up", "wrong_person", "timing"]},
                },
                "required": ["thread_id", "tag"],
            },
        },
        {
            "name": "send_reply",
            "description": "Send a reply to a prospect in an existing thread.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "thread_id": {"type": "string"},
                    "message": {"type": "string", "description": "The reply message to send"},
                },
                "required": ["thread_id", "message"],
            },
        },
    ]


def execute_inbox_tool(tool_name: str, tool_input: dict):
    if tool_name == "list_replies":
        return _list_replies(tool_input)
    elif tool_name == "get_reply_thread":
        return _get_thread(tool_input)
    elif tool_name == "tag_reply":
        return _tag_reply(tool_input)
    elif tool_name == "send_reply":
        return _send_reply(tool_input)
    return None


def _list_replies(params: dict):
    try:
        r = requests.get(f"{MASTERINBOX_BASE}/replies",
                         headers={"Authorization": f"Bearer {MASTERINBOX_API_KEY}"},
                         params={"limit": params.get("limit", 20), "label": params.get("label")})
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def _get_thread(params: dict):
    try:
        r = requests.get(f"{MASTERINBOX_BASE}/threads/{params['thread_id']}",
                         headers={"Authorization": f"Bearer {MASTERINBOX_API_KEY}"})
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def _tag_reply(params: dict):
    try:
        r = requests.post(f"{MASTERINBOX_BASE}/threads/{params['thread_id']}/tag",
                          headers={"Authorization": f"Bearer {MASTERINBOX_API_KEY}"},
                          json={"tag": params["tag"]})
        return r.json()
    except Exception as e:
        return {"error": str(e)}


def _send_reply(params: dict):
    try:
        r = requests.post(f"{MASTERINBOX_BASE}/threads/{params['thread_id']}/reply",
                          headers={"Authorization": f"Bearer {MASTERINBOX_API_KEY}"},
                          json={"message": params["message"]})
        return r.json()
    except Exception as e:
        return {"error": str(e)}
