import requests
from config import (
    EMAILBISON_SEND_URL, EMAILBISON_SEND_API_KEY,
    EMAILBISON_PERSONAL_URL, EMAILBISON_PERSONAL_API_KEY,
    MASTERINBOX_API_KEY, MI_KEYS,
    INBOXING_API_KEY,
    CLIENTS,
)

# ── EmailBison ────────────────────────────────────────────────────────────────

_EB_INSTANCES = {
    "eb_send":     (EMAILBISON_SEND_URL,     EMAILBISON_SEND_API_KEY),
    "eb_personal": (EMAILBISON_PERSONAL_URL, EMAILBISON_PERSONAL_API_KEY),
}


def _eb_headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def fetch_eb_workspaces(instance: str) -> list[dict]:
    base_url, api_key = _EB_INSTANCES.get(instance, (None, None))
    if not base_url or not api_key:
        return []
    try:
        r = requests.get(f"{base_url}/api/workspaces", headers=_eb_headers(api_key), timeout=10)
        r.raise_for_status()
        data = r.json()
        return data.get("data", data) if isinstance(data, dict) else data
    except Exception:
        return []


def fetch_eb_mailboxes(instance: str, team_id: int) -> list[dict]:
    base_url, api_key = _EB_INSTANCES.get(instance, (None, None))
    if not base_url or not api_key:
        return []
    try:
        session = requests.Session()
        session.headers.update(_eb_headers(api_key))
        session.post(
            f"{base_url}/api/workspaces/v1.1/switch-workspace",
            json={"team_id": team_id}, timeout=10
        )
        all_accounts = []
        page = 1
        while True:
            r = session.get(
                f"{base_url}/api/sender-emails",
                params={"page": page, "per_page": 100},
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            # Check for API-reported total first (avoids unnecessary pages)
            if isinstance(data, dict) and "total" in data and page == 1:
                total = data["total"]
                accounts = data.get("data", [])
                all_accounts.extend(accounts if isinstance(accounts, list) else [])
                if len(all_accounts) >= total:
                    break
            else:
                accounts = data.get("data", data) if isinstance(data, dict) else data
                if not isinstance(accounts, list) or not accounts:
                    break
                all_accounts.extend(accounts)
                if len(accounts) < 100:
                    break
            page += 1
        return all_accounts
    except Exception:
        return []


# ── MasterInbox ───────────────────────────────────────────────────────────────

_MI_BASE = "https://api.masterinbox.com/api/api-webhook/v1/api"


def fetch_mi_workspaces() -> dict[int, str]:
    """Returns {workspace_id: name}"""
    if not MASTERINBOX_API_KEY:
        return {}
    try:
        r = requests.get(
            f"{_MI_BASE}/get-all-workspaces",
            headers={"Authorization": f"Bearer {MASTERINBOX_API_KEY}"},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        workspaces = data.get("data", []) if isinstance(data, dict) else data
        return {ws["workspace_id"]: ws["name"] for ws in workspaces if "workspace_id" in ws}
    except Exception:
        return {}


# ── Inboxing ──────────────────────────────────────────────────────────────────

def fetch_inboxing_domains() -> list[dict]:
    if not INBOXING_API_KEY:
        return []
    domains = []
    page = 1
    while True:
        try:
            r = requests.get(
                "https://v2.inboxing.com/api/v2/domains",
                headers={"X-API-Key": INBOXING_API_KEY},
                params={"per_page": 100, "page": page},
                timeout=10,
            )
            r.raise_for_status()
            data = r.json()
            batch = data.get("data", []) if isinstance(data, dict) else data
            if not batch:
                break
            domains.extend(batch)
            if len(batch) < 100:
                break
            page += 1
        except Exception:
            break
    return domains


# ── Aggregated status ─────────────────────────────────────────────────────────

def build_client_status() -> list[dict]:
    """
    Returns a list of status dicts, one per client in CLIENTS.
    Fetches EB/MI/Inboxing data once and joins on client config.
    """
    # Fetch all data up front
    eb_send_ws    = {ws.get("id") or ws.get("team_id"): ws for ws in fetch_eb_workspaces("eb_send")}
    eb_personal_ws = {ws.get("id") or ws.get("team_id"): ws for ws in fetch_eb_workspaces("eb_personal")}
    mi_ws         = fetch_mi_workspaces()
    inboxing_doms = fetch_inboxing_domains()

    # Group inboxing domains by tag → {tag: [domain_dict, ...]}
    from collections import defaultdict
    inboxing_by_tag: dict[str, list[dict]] = defaultdict(list)
    for d in inboxing_doms:
        for tag in d.get("tags", []):
            inboxing_by_tag[tag.lower()].append(d)

    statuses = []
    for client in CLIENTS:
        name      = client["name"]
        sequencer = client["sequencer"]
        eb_ws_id  = client.get("eb_ws_id")
        mi_ws_id  = client.get("mi_ws_id")
        tags      = [t.lower() for t in client.get("inboxing_tags", [])]

        # EmailBison
        eb_instance  = sequencer if sequencer in ("eb_send", "eb_personal") else None
        eb_ws_map    = eb_send_ws if sequencer == "eb_send" else eb_personal_ws
        eb_connected = eb_ws_id is not None and eb_ws_id in eb_ws_map
        eb_mailboxes = fetch_eb_mailboxes(eb_instance, eb_ws_id) if eb_connected else []
        eb_mailbox_count = len(eb_mailboxes)
        eb_connected_count = sum(1 for m in eb_mailboxes if m.get("status", "").lower() == "connected")

        # MasterInbox
        mi_connected = mi_ws_id is not None and mi_ws_id in mi_ws
        mi_name      = mi_ws.get(mi_ws_id, "") if mi_connected else ""
        mi_key_ok    = bool(MI_KEYS.get(name))

        # Inboxing — match on any of the client's tags
        client_domains: list[dict] = []
        for tag in tags:
            client_domains.extend(inboxing_by_tag.get(tag, []))
        # Deduplicate by domain name
        seen = set()
        unique_domains = []
        for d in client_domains:
            if d["domain"] not in seen:
                seen.add(d["domain"])
                unique_domains.append(d)

        total_mailboxes = sum(d.get("mailbox_count", 0) for d in unique_domains)
        active_domains  = [d for d in unique_domains if d.get("status") == "active"]

        statuses.append({
            "name":               name,
            "sequencer":          sequencer,
            "eb_ws_id":           eb_ws_id,
            "eb_connected":       eb_connected,
            "eb_instance":        eb_instance,
            "eb_mailbox_count":   eb_mailbox_count,
            "eb_connected_count": eb_connected_count,
            "mi_ws_id":           mi_ws_id,
            "mi_connected":       mi_connected,
            "mi_name":            mi_name,
            "mi_key":             mi_key_ok,
            "domains":            unique_domains,
            "active_domains":     len(active_domains),
            "total_domains":      len(unique_domains),
            "total_mailboxes":    total_mailboxes,
        })

    return statuses
