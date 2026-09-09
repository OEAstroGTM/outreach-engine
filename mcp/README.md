# Outreach Engine MCP

Exposes Outreach Engine as a small **collection of delegating agents**. The
operator hands an agent a goal in plain language; the agent runs its own
tool-use loop and reports back.

## Tools (operator surface)

| Tool | Delegates to |
|---|---|
| `run_orchestrator_agent` | **Start here.** Reads a rough/vague prompt, resolves context, rewrites it, and routes to the right specialist(s) |
| `run_research_agent` | Find/enrich companies & people, build target lists (Apollo) |
| `run_campaign_agent` | Create/launch/pause/monitor campaigns, push leads (EmailBison + Instantly) |
| `run_inbox_agent` | Triage/read/tag replies (MasterInbox) |
| `run_infra_agent` | Buy domains + provision Inboxing mailboxes, point nameservers (self-sufficient — see below) |
| `list_clients` / `get_client` | Cheap read helpers, non-delegating |

Each `run_*_agent` tool takes `{ goal: string, context?: string }`.

## Orchestrator (recommended entrypoint)

`run_orchestrator_agent` exists for the common case: an operator gives a rough,
underspecified prompt. The orchestrator reads it, resolves context
(`list_clients` / `get_client`), rewrites it into a precise, well-scoped goal —
that rewrite is the pre-audit — then dispatches to the right specialist via
`dispatch_to_<agent>` and returns the result. It never does the work itself, and
it asks a clarifying question rather than dispatch when a request is too
ambiguous or would trigger an irreversible/spend action without a clear go. Point
operators at this tool; the four specialists remain callable directly for
power users.

## Setup

```bash
cd mcp
npm install
cp ../.env.example ../.env   # then fill in real values
```

Requires `ANTHROPIC_API_KEY` (each agent runs a Claude loop). Per-service keys
gate individual agents:

| Agent | Needs |
|---|---|
| research | `APOLLO_API_KEY` |
| campaign | `EMAILBISON_SEND_API_KEY` / `EMAILBISON_PERSONAL_API_KEY`, or `INSTANTLY_*` |
| inbox | `MASTERINBOX_API_KEY` + per-client `MI_KEY_*` |
| infra | `INFRA_REGISTRAR` + registrar keys (`NAMESILO_API_KEY` or `PORKBUN_API_KEY`/`PORKBUN_SECRET_API_KEY`) + `INBOXING_API_KEY` |

Optional agent tuning: `AGENT_MODEL` (default `claude-sonnet-4-6`),
`AGENT_MAX_TURNS` (25), `AGENT_MAX_TOKENS` (4096).

## Credentials: Cockpit keychain, then `.env`

Cockpit (`OEAstroGTM/cockpit`) is now the source of truth for API keys,
including ones it provisions itself (Add Client's live EmailBison workspace +
token) that never land in this repo's `.env` at all. At startup, `lib/core.js`
fetches `/api/secrets` once, caches it in memory, and every key lookup
(`ebConfig`, `cockpitSecret`, the Inboxing call in `lib/infra.js`) tries
Cockpit first and falls back to the matching `.env` var. A Cockpit outage never
takes the process down — it just falls back silently (logged to stderr).

```bash
COCKPIT_URL=https://your-cockpit-deployment.vercel.app
COCKPIT_API_KEY=...                  # scoped key from Cockpit's /api-keys
# COCKPIT_VERCEL_BYPASS=...          # only if Deployment Protection is on
```

Both are optional — omit them and everything resolves from `.env` exactly as
before. Run `node mcp/cockpit-check.mjs` to see where each client's key is
actually resolving from (Cockpit vs `.env` vs missing).

## MCP client config

Add this to your MCP client (Claude Code / Cowork `mcpServers`, or a project
`.mcp.json`). Secrets come from `.env` via dotenv, so nothing sensitive lives in
this file.

```json
{
  "mcpServers": {
    "outreach-engine": {
      "command": "node",
      "args": ["mcp/index.js"]
    }
  }
}
```

Use an absolute path to `mcp/index.js` if your client's working directory isn't
the repo root.

## Architecture

```
mcp/index.js       server: read helpers + registerAgents()
mcp/agents.js      the 4 agent definitions (system prompt + toolset)
mcp/lib/agent.js   generic Anthropic tool-use runner (runAgent)
mcp/lib/tools.js   operation functions — business logic, one source of truth
mcp/lib/core.js    config, client resolution, fetch helpers
mcp/lib/infra.js   self-sufficient registrar (NameSilo/Porkbun) + Inboxing calls
```

Client routing derives from `../clients.json` (single source of truth). Adding a
client is a `clients.json` + `.env` edit — no code change.

## The Infra agent (self-sufficient)

The Infra agent talks **directly** to the registrar and Inboxing — no external
lead-gen MCP to configure. Pick the registrar and provide its keys:

```bash
INFRA_REGISTRAR=namesilo          # namesilo (default) | porkbun
NAMESILO_API_KEY=...              # if namesilo
PORKBUN_API_KEY=... ; PORKBUN_SECRET_API_KEY=...   # if porkbun
INBOXING_API_KEY=...
INBOXING_API_BASE_URL=https://v2.inboxing.com/api/v2
```

Both registrars are implemented natively against their public APIs (NameSilo's
`?type=json` GET API; Porkbun v3 REST — register requires the exact price in
pennies, handled for you). Inboxing uses its API v2 (`X-API-Key` auth, base
`.../api/v2`): `POST /domains`, `GET /domains/{id}/status`, `GET /slots`,
`GET /domains/{id}/csv`. Set `INBOXING_API_BASE_URL` to your dashboard host + `/api/v2`
(the Inboxing key itself resolves from Cockpit's `__global__.inboxing` slot first).

## Operational scripts (`mcp/scripts/`)

Standalone tools run directly with `node`, not exposed as MCP tools:

| Script | What it does |
|---|---|
| `dnc-sync.js` (+ `dnc-nightly.sh`, `co.outreachengine.dnc-sync.plist`) | Reconciles MasterInbox "Meeting Booked" prospects into each client's EmailBison blocklist. Runs nightly via launchd; dry-run by default — see `lib/dnc.js` for the safety notes on why this is a reconciler, not an event handler. |
| `pv-verify-upload.js` | Reconciles an Inboxing → PlusVibe mailbox upload by reading accounts back out of PlusVibe and diffing against the expected domain list — `inboxing_upload_to_platform` returns 200 for "queued," not "landed." |
| `pv-fix-mailboxes.js`, `pv-replay-sequences.js`, `pv-translate-copy.js`, `pv-delete-campaigns.js`, `pv-smoke-test.js` | PlusVibe migration/cleanup tooling. |
| `eb-export-sequences.js`, `instantly-export-sequences.js` | Export campaign sequence copy out of EmailBison / Instantly. |

## Smoke test

With `ANTHROPIC_API_KEY` set, `node index.js` should boot and expose seven tools
(`run_orchestrator_agent` + four specialists + `list_clients`/`get_client`). A
minimal end-to-end check is to call `run_research_agent` with a goal that only
needs `list_clients` (no Apollo credits spent).

For lower-level checks against live services (gitignored, local-only —
`node mcp/<script>.mjs` from the `mcp/` dir):

| Script | Checks |
|---|---|
| `cockpit-check.mjs` | Where every client's EmailBison/MasterInbox key actually resolves from (Cockpit vs `.env`) |
| `smoketest.mjs [client ...]` | Real EmailBison calls per client — pagination is fully walked, and calls land in that client's own workspace, not whichever one the token was last switched to |
| `mi-check.mjs` | MasterInbox connectivity per client |
| `inboxing-check.mjs` | Inboxing `/slots` and `/domains` — handy right after a key rotation |
