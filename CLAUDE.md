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

## Tools available

- **Research**: `find_company`, `find_contacts`, `enrich_contact` (wire to Clay via `CLAY_API_KEY`)
- **Campaigns**: `list_campaigns`, `create_campaign`, `add_leads_to_campaign`, `launch_campaign`, `get_campaign_stats` (EmailBison + Instantly)
- **Inbox**: `list_replies`, `get_reply_thread`, `tag_reply`, `send_reply` (MasterInbox)

## Environment

Copy `.env.example` to `.env` and fill in your API keys before running.
