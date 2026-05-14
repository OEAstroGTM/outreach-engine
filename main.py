from rich.console import Console
from rich.prompt import Prompt
from brain.agent import run_agent

console = Console()


def main():
    console.print("\n[bold green]Outreach Engine — Brain[/bold green]")
    console.print("Type your goal or command. Type [bold]exit[/bold] to quit.\n")

    history = []

    while True:
        user_input = Prompt.ask("[bold blue]You[/bold blue]")

        if user_input.lower() in ("exit", "quit"):
            console.print("[dim]Shutting down.[/dim]")
            break

        history = run_agent(user_input, history)


if __name__ == "__main__":
    main()
