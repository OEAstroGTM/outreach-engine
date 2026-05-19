import os

_CLIENTS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "clients")

_CONTEXT_FILES = [
    "overview.md",
    "positioning.md",
    "icp.md",
    "voice.md",
    "intelligence/objections.md",
    "intelligence/winning-themes.md",
]


def load_client_context(client_name: str) -> str:
    slug = client_name.lower().replace(" ", "-").replace("&", "and")
    client_dir = os.path.join(_CLIENTS_DIR, slug)
    if not os.path.exists(client_dir):
        return ""

    sections = []
    for filename in _CONTEXT_FILES:
        filepath = os.path.join(client_dir, filename)
        if os.path.exists(filepath):
            content = open(filepath).read().strip()
            if content:
                sections.append(f"### {filename}\n{content}")

    if not sections:
        return ""

    return f"## Client Context: {client_name}\n\n" + "\n\n".join(sections)
