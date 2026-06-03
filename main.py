import json
import os
import sys
from rich.console import Console
from rich.prompt import Prompt
from brain.agent import run_agent

console = Console()

_CLIENTS_PATH = os.path.join(os.path.dirname(__file__), "clients.json")
_DEFAULT_CLIENT = "Intellectible"


def _load_clients() -> list[dict]:
    with open(_CLIENTS_PATH) as f:
        return json.load(f)


def _select_client(clients: list[dict]) -> str:
    """Default to Intellectible. Pass --client=Name to override."""
    for arg in sys.argv[1:]:
        if arg.startswith("--client="):
            name = arg.split("=", 1)[1]
            if any(c["name"] == name for c in clients):
                return name
            console.print(f"[yellow]Unknown client '{name}', defaulting to {_DEFAULT_CLIENT}[/yellow]")
    return _DEFAULT_CLIENT


def main():
    clients = _load_clients()
    client_name = _select_client(clients)

    console.print(f"\n[bold green]Outreach Engine[/bold green]  [dim]·[/dim]  [bold]{client_name}[/bold]")
    console.print("[dim]Ask anything about the GTM — campaigns, replies, pipeline, strategy.[/dim]")
    console.print("[dim]Commands: /status · /client <name> · exit[/dim]\n")

    history = []

    while True:
        try:
            user_input = Prompt.ask("[bold blue]>[/bold blue]")
        except (KeyboardInterrupt, EOFError):
            console.print("\n[dim]Shutting down.[/dim]")
            break

        if not user_input.strip():
            continue

        if user_input.lower() in ("exit", "quit"):
            console.print("[dim]Shutting down.[/dim]")
            break

        if user_input.strip() == "/status":
            from workflows.client_status import run as show_status
            show_status()
            continue

        if user_input.strip().startswith("/client "):
            new_name = user_input.strip()[8:].strip()
            if any(c["name"] == new_name for c in clients):
                client_name = new_name
                history = []
                console.print(f"[bold]Switched to {client_name}[/bold] — history cleared.\n")
            else:
                names = [c["name"] for c in clients]
                console.print(f"[yellow]Unknown client. Available: {', '.join(names)}[/yellow]")
            continue

        history = run_agent(user_input, history, client_name=client_name)


if __name__ == "__main__":
    main()
