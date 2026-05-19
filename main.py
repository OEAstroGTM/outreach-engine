import json
import os
from rich.console import Console
from rich.prompt import Prompt
from brain.agent import run_agent

console = Console()

_CLIENTS_PATH = os.path.join(os.path.dirname(__file__), "clients.json")


def _load_client_names() -> list[str]:
    with open(_CLIENTS_PATH) as f:
        return [c["name"] for c in json.load(f)]


def _select_client() -> str | None:
    names = _load_client_names()
    console.print("\n[bold]Available clients:[/bold]")
    for i, name in enumerate(names, 1):
        console.print(f"  [dim]{i}.[/dim] {name}")
    console.print(f"  [dim]{len(names) + 1}.[/dim] No client (general mode)\n")

    choice = Prompt.ask("Select a client", default=str(len(names) + 1))
    try:
        idx = int(choice) - 1
        if 0 <= idx < len(names):
            return names[idx]
    except ValueError:
        # Allow typing the name directly
        if choice in names:
            return choice
    return None


def main():
    console.print("\n[bold green]Outreach Engine[/bold green]")

    client_name = _select_client()
    if client_name:
        console.print(f"\n[bold]Client:[/bold] {client_name}")
    else:
        console.print("\n[dim]Running in general mode — no client context loaded.[/dim]")

    console.print("Type your goal or command. Type [bold]exit[/bold] to quit.\n")

    history = []

    while True:
        user_input = Prompt.ask("[bold blue]You[/bold blue]")

        if user_input.lower() in ("exit", "quit"):
            console.print("[dim]Shutting down.[/dim]")
            break

        history = run_agent(user_input, history, client_name=client_name)


if __name__ == "__main__":
    main()
