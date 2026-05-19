from rich.console import Console
from rich.table import Table
from rich.text import Text
from tools.status import build_client_status

console = Console()


def _check(val: bool) -> Text:
    return Text("✓", style="green") if val else Text("✗", style="red")


def run():
    console.print("\n[bold]Fetching client status...[/bold]\n")
    statuses = build_client_status()

    # ── Summary table ──────────────────────────────────────────────────────
    table = Table(title="Client Status", show_lines=True)
    table.add_column("Client",      style="bold")
    table.add_column("Sequencer",   style="dim")
    table.add_column("EB",          justify="center")
    table.add_column("MI",          justify="center")
    table.add_column("MI Key",      justify="center")
    table.add_column("Domains",     justify="right")
    table.add_column("Mailboxes",   justify="right")

    for s in statuses:
        sequencer_label = {
            "eb_send":     "EB Send",
            "eb_personal": "EB Personal",
            "instantly":   "Instantly",
            "none":        "—",
        }.get(s["sequencer"], s["sequencer"])

        domains_cell = (
            f"{s['active_domains']}/{s['total_domains']}"
            if s["total_domains"] > 0
            else Text("—", style="dim")
        )

        table.add_row(
            s["name"],
            sequencer_label,
            _check(s["eb_connected"]) if s["sequencer"].startswith("eb_") else Text("n/a", style="dim"),
            _check(s["mi_connected"]),
            _check(s["mi_key"]),
            str(domains_cell),
            str(s["total_mailboxes"]) if s["total_mailboxes"] > 0 else Text("—", style="dim"),
        )

    console.print(table)

    # ── Domain detail (clients with domains) ──────────────────────────────
    clients_with_domains = [s for s in statuses if s["total_domains"] > 0]
    if clients_with_domains:
        console.print()
        dom_table = Table(title="Domains by Client", show_lines=True)
        dom_table.add_column("Client",    style="bold")
        dom_table.add_column("Domain")
        dom_table.add_column("Status",    justify="center")
        dom_table.add_column("Mailboxes", justify="right")

        for s in clients_with_domains:
            for i, d in enumerate(sorted(s["domains"], key=lambda x: x["domain"])):
                status_color = "green" if d["status"] == "active" else "yellow"
                dom_table.add_row(
                    s["name"] if i == 0 else "",
                    d["domain"],
                    Text(d["status"], style=status_color),
                    str(d.get("mailbox_count", 0)),
                )

        console.print(dom_table)


if __name__ == "__main__":
    run()
