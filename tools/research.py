import os
import requests

# ── Client state ──────────────────────────────────────────────────────────────

_client: dict = {}

def set_client(config: dict) -> None:
    global _client
    _client = config


# ── Provider config ───────────────────────────────────────────────────────────
# Wire APOLLO_API_KEY in .env to enable live enrichment.

APOLLO_API_KEY = os.getenv("APOLLO_API_KEY")
APOLLO_BASE    = "https://api.apollo.io/api/v1"


# ── Tool schemas ──────────────────────────────────────────────────────────────

def get_research_tools():
    return [
        {
            "name": "find_company",
            "description": "Find and enrich a company by name or domain. Returns industry, size, location, tech stack.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "company_name": {"type": "string"},
                    "domain":       {"type": "string", "description": "Company domain — improves accuracy"},
                },
                "required": ["company_name"],
            },
        },
        {
            "name": "find_contacts",
            "description": "Find decision-maker contacts at a company matching target titles.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "company_name": {"type": "string"},
                    "domain":       {"type": "string"},
                    "titles": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Target job titles, e.g. ['VP of BD', 'Capture Director']",
                    },
                    "limit": {"type": "integer", "default": 5},
                },
                "required": ["company_name", "titles"],
            },
        },
        {
            "name": "enrich_contact",
            "description": "Enrich a specific contact — get verified email, LinkedIn, phone, and background.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "first_name":   {"type": "string"},
                    "last_name":    {"type": "string"},
                    "company":      {"type": "string"},
                    "domain":       {"type": "string"},
                    "linkedin_url": {"type": "string"},
                },
                "required": ["first_name", "last_name", "company"],
            },
        },
    ]


# ── Executor ──────────────────────────────────────────────────────────────────

def execute_research_tool(tool_name: str, tool_input: dict):
    if tool_name == "find_company":   return _find_company(tool_input)
    if tool_name == "find_contacts":  return _find_contacts(tool_input)
    if tool_name == "enrich_contact": return _enrich_contact(tool_input)
    return None


# ── Apollo implementations ────────────────────────────────────────────────────

def _find_company(params: dict):
    if not APOLLO_API_KEY:
        return {"error": "APOLLO_API_KEY not set — add it to .env"}
    try:
        r = requests.post(
            f"{APOLLO_BASE}/mixed_companies/search",
            headers={"Content-Type": "application/json", "x-api-key": APOLLO_API_KEY},
            json={
                "q_organization_name": params.get("company_name"),
                "q_organization_domains": [params["domain"]] if params.get("domain") else [],
                "per_page": 1,
            },
            timeout=15,
        )
        data = r.json()
        orgs = data.get("organizations", [])
        return orgs[0] if orgs else {"note": "No company found", "query": params}
    except Exception as e:
        return {"error": str(e)}


def _find_contacts(params: dict):
    if not APOLLO_API_KEY:
        return {"error": "APOLLO_API_KEY not set — add it to .env"}
    try:
        r = requests.post(
            f"{APOLLO_BASE}/mixed_people/search",
            headers={"Content-Type": "application/json", "x-api-key": APOLLO_API_KEY},
            json={
                "q_organization_name":    params.get("company_name"),
                "q_organization_domains": [params["domain"]] if params.get("domain") else [],
                "person_titles":          params.get("titles", []),
                "per_page":               params.get("limit", 5),
            },
            timeout=15,
        )
        data = r.json()
        return {"contacts": data.get("people", []), "total": data.get("pagination", {}).get("total_entries", 0)}
    except Exception as e:
        return {"error": str(e)}


def _enrich_contact(params: dict):
    if not APOLLO_API_KEY:
        return {"error": "APOLLO_API_KEY not set — add it to .env"}
    try:
        r = requests.post(
            f"{APOLLO_BASE}/people/match",
            headers={"Content-Type": "application/json", "x-api-key": APOLLO_API_KEY},
            json={
                "first_name":          params.get("first_name"),
                "last_name":           params.get("last_name"),
                "organization_name":   params.get("company"),
                "domain":              params.get("domain"),
                "linkedin_url":        params.get("linkedin_url"),
                "reveal_personal_emails": params.get("reveal_personal_emails", False),
            },
            timeout=15,
        )
        return r.json().get("person", r.json())
    except Exception as e:
        return {"error": str(e)}
