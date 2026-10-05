#!/usr/bin/env node
// ── Outreach Engine MCP ──────────────────────────────────────────────────────
// Operator surface = a small collection of delegating agents plus two read
// helpers. Each agent (research, campaign, inbox, infra) takes a natural-language
// goal and runs its own tool-use loop. Business logic lives in lib/tools.js;
// agent definitions in agents.js; the runner in lib/agent.js.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// core.js loads the repo-root .env (regardless of cwd) at import time, before
// any env var is read — keep it the first local import.
import { CLIENTS, ok, err, ebListWorkspaces } from "./lib/core.js";
import * as ops from "./lib/tools.js";
import * as infra from "./lib/infra.js";
import { registerAgents } from "./agents.js";

const server = new McpServer({ name: "outreach-engine", version: "2.0.0" });
// dev workflow check: ~/dev/oe -> push -> runtime mirror auto-sync (no functional change)

// ── Read helpers (cheap, non-delegating — handy for the operator directly) ────
server.tool("list_clients",
  `List all ${CLIENTS.length} Outreach Engine clients with sequencer, workspace IDs, and MasterInbox config.`,
  {},
  async () => ok(ops.listClients())
);

server.tool("get_client",
  "Get full routing config for a specific client by name.",
  { client_name: z.string().describe("Client name, e.g. 'AskTuring'") },
  async ({ client_name }) => {
    try { return ok(ops.getClientInfo({ client_name })); }
    catch (e) { return err(e); }
  }
);

// ── Direct campaign/inbox ops (cheap, deterministic — no LLM judgment needed,
//    so these skip the run_campaign_agent loop entirely for speed/reliability) ──
server.tool("list_campaigns",
  "List a client's campaigns (routes to EmailBison or Instantly). EmailBison paginates 15/page — pass all=true for the full list. Filter with status.",
  {
    client_name: z.string(),
    page: z.number().optional(),
    all: z.boolean().optional(),
    max_pages: z.number().optional(),
    status: z.string().optional(),
  },
  async (args) => {
    try { return ok(await ops.listCampaigns(args)); }
    catch (e) { return err(e); }
  }
);

server.tool("list_inboxes",
  "List the sender emails (inboxes) in a client's EmailBison workspace. Paginated 15/page; pass all=true to walk pages. Filter with status, e.g. 'Connected' or 'Not connected' (case-sensitive, matches EmailBison's own casing).",
  {
    client_name: z.string(),
    page: z.number().optional(),
    all: z.boolean().optional(),
    max_pages: z.number().optional(),
    status: z.string().optional(),
  },
  async (args) => {
    try { return ok(await ops.listInboxes(args)); }
    catch (e) { return err(e); }
  }
);

server.tool("attach_inboxes_to_campaign",
  "Attach sender emails (inboxes) to a campaign so it can send, in one bulk call. IDs come from list_inboxes.",
  {
    client_name: z.string(),
    campaign_id: z.string(),
    sender_email_ids: z.array(z.number()),
  },
  async (args) => {
    try { return ok(await ops.attachInboxesToCampaign(args)); }
    catch (e) { return err(e); }
  }
);

server.tool("remove_inboxes_from_campaign",
  "Detach sender emails (inboxes) from a campaign.",
  {
    client_name: z.string(),
    campaign_id: z.string(),
    sender_email_ids: z.array(z.number()),
  },
  async (args) => {
    try { return ok(await ops.removeInboxesFromCampaign(args)); }
    catch (e) { return err(e); }
  }
);

// ── Direct infra read-only ops (cheap, no judgment needed — skip the
//    run_infra_agent loop for investigation/status checks. Mutating/spend
//    actions like register_domain, update_nameservers, inboxing_submit_domain
//    stay agent-only so the "never register without an explicit go" rule and
//    the agent's own review still gate anything that spends money.) ───────────
server.tool("get_sequence_steps",
  "Read a campaign's EmailBison sequence steps (subjects, bodies, wait days, variants).",
  {
    client_name: z.string(),
    campaign_id: z.number(),
    instance: z.enum(["eb_send", "eb_personal"]).optional(),
  },
  async (args) => {
    try { return ok(await ops.getSequenceSteps(args)); }
    catch (e) { return err(e); }
  }
);

server.tool("copy_campaign_sequence",
  "Copy the sequence steps from one EmailBison campaign to another (works across eb_send/eb_personal). Steps only — no leads, inboxes, or status changes. Refuses if the destination already has steps unless allow_existing=true. Use dry_run=true to preview.",
  {
    client_name: z.string(),
    source_campaign_id: z.number(),
    source_instance: z.enum(["eb_send", "eb_personal"]),
    dest_campaign_id: z.number(),
    dest_instance: z.enum(["eb_send", "eb_personal"]),
    allow_existing: z.boolean().optional(),
    dry_run: z.boolean().optional(),
  },
  async (args) => {
    try { return ok(await ops.copyCampaignSequence(args)); }
    catch (e) { return err(e); }
  }
);

server.tool("get_domain",
  "Get a domain's registrar status + current nameservers (read-only).",
  { domain: z.string() },
  async ({ domain }) => {
    try { return ok(await infra.getDomain({ domain })); }
    catch (e) { return err(e); }
  }
);

server.tool("get_registrar_balance",
  "Get the configured registrar account balance (read-only).",
  {},
  async () => {
    try { return ok(await infra.getRegistrarBalance()); }
    catch (e) { return err(e); }
  }
);

server.tool("check_domain_availability",
  "Check if domains are available + pricing via the configured registrar (read-only).",
  { domains: z.array(z.string()) },
  async ({ domains }) => {
    try { return ok(await infra.checkAvailability({ domains })); }
    catch (e) { return err(e); }
  }
);

server.tool("inboxing_list_domains",
  "List domains/jobs on Inboxing (read-only). Paginated (50/page) — pass all=true to walk every page (guarded by max_pages), or page to fetch a specific one.",
  {
    page: z.number().optional(),
    all: z.boolean().optional(),
    max_pages: z.number().optional(),
  },
  async ({ page, all, max_pages }) => {
    try { return ok(await infra.inboxingListDomains({ page, all, maxPages: max_pages })); }
    catch (e) { return err(e); }
  }
);

server.tool("inboxing_check_status",
  "Check an Inboxing domain job's status by domain job id (read-only).",
  { domain_id: z.string() },
  async ({ domain_id }) => {
    try { return ok(await infra.inboxingCheckStatus({ domain_id })); }
    catch (e) { return err(e); }
  }
);

server.tool("inboxing_get_slots",
  "Check available Inboxing mailbox/domain slots (read-only).",
  {},
  async () => {
    try { return ok(await infra.inboxingGetSlots()); }
    catch (e) { return err(e); }
  }
);

server.tool("list_workspaces",
  "List every workspace on an EmailBison instance, account-wide (not scoped to a client) — the only way to see a workspace no client is routed to, e.g. a shared/default workspace an external integration (like Inboxing's platform connection) uploads mailboxes into.",
  { instance: z.enum(["eb_send", "eb_personal"]) },
  async ({ instance }) => {
    try { return ok(await ebListWorkspaces(instance)); }
    catch (e) { return err(e); }
  }
);

// ── Delegating agents: run_research_agent, run_campaign_agent,
//    run_inbox_agent, run_infra_agent ──────────────────────────────────────────
registerAgents(server);

// ── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
