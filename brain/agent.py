import anthropic
from config import ANTHROPIC_API_KEY, CLAUDE_MODEL, CLIENTS
from brain.prompts import build_system_prompt
from brain.context import load_client_context
from tools.research import get_research_tools
from tools.campaigns import get_campaign_tools
from tools.inbox import get_inbox_tools
import tools.research as _t_research
import tools.campaigns as _t_campaigns
import tools.inbox as _t_inbox
from rich.console import Console
from rich.markdown import Markdown

console = Console()
client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def get_all_tools():
    return [
        *get_research_tools(),
        *get_campaign_tools(),
        *get_inbox_tools(),
    ]


def _wire_client(client_name: str) -> None:
    config = next((c for c in CLIENTS if c["name"] == client_name), {})
    _t_research.set_client(config)
    _t_campaigns.set_client(config)
    _t_inbox.set_client(config)


def run_agent(user_message: str, conversation_history: list = None, client_name: str = None):
    if conversation_history is None:
        conversation_history = []

    if client_name:
        _wire_client(client_name)

    context = load_client_context(client_name) if client_name else ""
    system = build_system_prompt(context)

    conversation_history.append({"role": "user", "content": user_message})

    tools = get_all_tools()

    while True:
        response = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=4096,
            system=system,
            tools=tools,
            messages=conversation_history,
        )

        assistant_content = response.content
        conversation_history.append({"role": "assistant", "content": assistant_content})

        if response.stop_reason == "end_turn":
            for block in assistant_content:
                if hasattr(block, "text"):
                    console.print(Markdown(block.text))
            break

        if response.stop_reason == "tool_use":
            tool_results = []
            for block in assistant_content:
                if block.type == "tool_use":
                    console.print(f"\n[bold cyan]Using tool:[/bold cyan] {block.name}")
                    result = _execute_tool(block.name, block.input)
                    console.print(f"[dim]{str(result)[:200]}...[/dim]" if len(str(result)) > 200 else f"[dim]{result}[/dim]")
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(result),
                    })

            conversation_history.append({"role": "user", "content": tool_results})

    return conversation_history


def _execute_tool(tool_name: str, tool_input: dict):
    from tools.research import execute_research_tool
    from tools.campaigns import execute_campaign_tool
    from tools.inbox import execute_inbox_tool

    for executor in [execute_research_tool, execute_campaign_tool, execute_inbox_tool]:
        result = executor(tool_name, tool_input)
        if result is not None:
            return result

    return {"error": f"Unknown tool: {tool_name}"}
