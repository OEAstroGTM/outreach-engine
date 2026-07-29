# Outreach Engine

AI-powered outreach system for end-to-end campaign work across multiple clients. Combines an agentic Python brain (research, campaign orchestration, inbox management) with per-client context (positioning, ICP, voice, campaign history).

## Repo structure

```
brain/          — Claude agent + context loader + prompts
tools/          — Tool implementations (research, campaigns, inbox)
workflows/      — High-level workflow scripts
clients/        — Per-client context (one folder per client)
clients.json    — Client routing config (sequencer, workspace IDs)
config.py       — API keys loaded from .env
main.py         — CLI entry point
```

## Per-client context

Each client has a folder under `clients/{slug}/`:

| File | What it holds |
|---|---|
| `overview.md` | Company, product, pricing, team |
| `positioning.md` | Messaging angles, proof points, what we lead with |
| `icp.md` | Target personas, company profile, trigger signals |
| `voice.md` | Tone, banned words, email length guidance |
| `intelligence/objections.md` | Recurring objections from calls/replies |
| `intelligence/winning-themes.md` | What's resonating in outbound |
| `campaigns/` | Campaign briefs and results |
| `calls/` | Call transcripts and summaries |

The agent loads the relevant client folder into its system prompt automatically when a client is selected at startup.

## Running the agent

```bash
python main.py
```

Select a client (or general mode), then type your goal. The agent will research, strategize, and act using its tools.

## Working with context files

- **After a notable call**: drop transcript in `clients/{slug}/calls/`, update `intelligence/objections.md` if new patterns emerged
- **After a campaign**: add results to `clients/{slug}/campaigns/` and update `intelligence/winning-themes.md`
- **When positioning evolves**: update `positioning.md` and `icp.md`
- **Keep it current** — stale context produces confident wrong answers

## Adding a new client

1. Add entry to `clients.json` with sequencer, workspace IDs, and inboxing tags
2. Create `clients/{slug}/` folder with context files (copy the structure from an existing client)
3. Fill in `overview.md` and `icp.md` at minimum before running any campaigns

## MCP server — operator agents

The MCP (`mcp/`) exposes Outreach Engine as a small **collection of delegating
agents** rather than a flat tool list. The operator hands an agent a goal in
plain language; the agent runs its own tool-use loop and reports back.

Surface (see `mcp/index.js`):

| Tool | What it delegates |
|---|---|
| `run_orchestrator_agent` | **Start here.** Takes a rough/vague prompt, resolves context, rewrites it, and routes to the right specialist(s) |
| `run_research_agent` | Find/enrich companies & people, build target lists (Apollo) |
| `run_campaign_agent` | Create/launch/pause/monitor campaigns, push leads (EmailBison + Instantly) |
| `run_inbox_agent` | Triage/read/tag replies (MasterInbox) |
| `run_infra_agent` | Buy domains + provision Inboxing mailboxes, point nameservers |
| `list_clients`, `get_client` | Cheap read helpers (non-delegating) |

Architecture:

```
mcp/index.js      — server: read helpers + registerAgents()
mcp/agents.js     — the 4 agent definitions (prompt + toolset)
mcp/lib/agent.js  — generic Anthropic tool-use runner (runAgent)
mcp/lib/tools.js  — operation functions (business logic, one source of truth)
mcp/lib/core.js   — config, client resolution, fetch helpers
mcp/lib/infra.js  — self-sufficient registrar (NameSilo/Porkbun) + Inboxing calls
```

- Client routing is derived from `clients.json` (single source of truth); adding
  a client is a `clients.json` + `.env` edit only — no code change.
- The Infra agent is **self-sufficient** — it calls the registrar (NameSilo or
  Porkbun, `INFRA_REGISTRAR`) and Inboxing directly from `lib/infra.js` using the
  keys in `.env`. No external lead-gen MCP required.
- Running the agents requires `ANTHROPIC_API_KEY` (they each run a Claude loop).

## Tools available (Python brain — `tools/`)

- **Research**: `find_company`, `find_contacts`, `enrich_contact` (Apollo via `APOLLO_API_KEY`)
- **Campaigns**: `list_campaigns`, `create_campaign`, `add_leads_to_campaign`, `launch_campaign`, `pause_campaign`, `get_campaign_stats`, `create_lead` (EmailBison + Instantly; auto-detected from client sequencer)
- **Inbox**: `list_replies`, `list_labels`, `get_reply_thread`, `tag_reply`, `send_reply`, `find_prospect` (MasterInbox)

## Environment

Copy `.env.example` to `.env` and fill in your API keys before running. For the
MCP agents, install deps once: `cd mcp && npm install`.
