import requests
from config import CLAY_API_KEY


def get_research_tools():
    return [
        {
            "name": "find_company",
            "description": "Find and enrich a company by name or domain. Returns firmographic data: industry, size, location, tech stack.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "company_name": {"type": "string", "description": "Company name to look up"},
                    "domain": {"type": "string", "description": "Company domain (optional, improves accuracy)"},
                },
                "required": ["company_name"],
            },
        },
        {
            "name": "find_contacts",
            "description": "Find decision-maker contacts at a company. Returns names, titles, emails, LinkedIn URLs.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "company_name": {"type": "string", "description": "Company to search within"},
                    "titles": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Target job titles, e.g. ['CEO', 'VP of Sales', 'Head of Marketing']",
                    },
                    "limit": {"type": "integer", "description": "Max contacts to return", "default": 5},
                },
                "required": ["company_name", "titles"],
            },
        },
        {
            "name": "enrich_contact",
            "description": "Enrich a specific contact with email, LinkedIn, phone, and background info.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "first_name": {"type": "string"},
                    "last_name": {"type": "string"},
                    "company": {"type": "string"},
                    "linkedin_url": {"type": "string", "description": "LinkedIn profile URL (optional)"},
                },
                "required": ["first_name", "last_name", "company"],
            },
        },
    ]


def execute_research_tool(tool_name: str, tool_input: dict):
    if tool_name == "find_company":
        return _find_company(tool_input)
    elif tool_name == "find_contacts":
        return _find_contacts(tool_input)
    elif tool_name == "enrich_contact":
        return _enrich_contact(tool_input)
    return None


def _find_company(params: dict):
    # Stub — wire to Clay or your enrichment provider
    return {
        "company": params.get("company_name"),
        "domain": params.get("domain", "unknown"),
        "industry": "Unknown — enrich via Clay API",
        "note": "Connect CLAY_API_KEY in .env to get live data",
    }


def _find_contacts(params: dict):
    return {
        "company": params.get("company_name"),
        "titles_searched": params.get("titles"),
        "contacts": [],
        "note": "Connect CLAY_API_KEY in .env to get live contacts",
    }


def _enrich_contact(params: dict):
    return {
        "name": f"{params.get('first_name')} {params.get('last_name')}",
        "company": params.get("company"),
        "email": "unknown — enrich via Clay API",
        "note": "Connect CLAY_API_KEY in .env to get live data",
    }
