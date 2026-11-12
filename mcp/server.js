import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CLIENTS, ok, err, ebListWorkspaces } from "./lib/core.js";
import * as ops from "./lib/tools.js";
import * as infra from "./lib/infra.js";
import * as valley from "./lib/valley.js";
import * as cheap from "./lib/cheapinboxes.js";
import * as cf from "./lib/cloudflare.js";
import * as hospital from "./lib/hospital.js";
import * as ice from "./lib/icemail.js";
import { registerAgents } from "./agents.js";

const REMOTE_ANNOTATIONS = {
  list_clients: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_client: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run_research_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run_inbox_agent: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run_campaign_agent: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export function buildServer({ allowedTools = null, remote = false } = {}) {
  const real = new McpServer({ name: "outreach-engine", version: "2.1.0" });
  const server = {
    tool(name, ...args) {
      if (allowedTools && !allowedTools.has(name)) return;
      if (remote) return real.tool(name, ...args.slice(0, -1), REMOTE_ANNOTATIONS[name], args.at(-1));
      return real.tool(name, ...args);
    },
  };

  server.tool("list_clients",
    `List all ${CLIENTS.length} Outreach Engine clients and their routing metadata.`,
    {},
    async () => ok(ops.listClients()));

  server.tool("get_client",
    "Get routing metadata for a specific client by name. Credentials are never returned remotely.",
    { client_name: z.string().describe("Client name, e.g. 'AskTuring'") },
    async ({ client_name }) => {
      try {
        if (!remote) return ok(ops.getClientInfo({ client_name }));
        const client = ops.listClients().find(c => c.name.toLowerCase() === client_name.toLowerCase());
        if (!client) throw new Error(`Unknown client: ${client_name}`);
        return ok(client);
      } catch (e) { return err(e); }
    });

  // Direct operator tools. Locally all are exposed; over HTTP the allowedTools
  // filter keeps only the scoped remote set.
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
       instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
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
       instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
    },
    async (args) => {
      try { return ok(await ops.listInboxes(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("list_leads",
    "List a client's leads (the EmailBison Leads tab). Omit campaign_id for the whole workspace, or pass one to scope to a single campaign. Paginates 15/page — a large workspace can be tens of thousands of pages, so all=true is capped by max_pages (default 200 pages ~= 3000 leads). search is the only server-side filter EmailBison honours; status, campaign_status and interested are applied to the rows actually fetched, so combine them with all=true or a search, not with a single page, before reading anything into the counts.",
    {
      client_name: z.string(),
      campaign_id: z.number().optional().describe("Scope to one campaign (uses /campaigns/{id}/leads). Omit for workspace-wide."),
      search: z.string().optional().describe("Server-side search across name/email/company."),
      status: z.string().optional().describe("Client-side filter on lead status, e.g. 'unverified', 'verified'."),
      campaign_status: z.string().optional().describe("Client-side filter on per-campaign status, e.g. 'in_sequence', 'completed'."),
      interested: z.boolean().optional().describe("Client-side filter on the interested flag."),
      page: z.number().optional(),
      all: z.boolean().optional(),
      max_pages: z.number().optional(),
      concurrency: z.number().optional().describe("Pages fetched in parallel when all=true. Default 5."),
      instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
    },
    async (args) => {
      try { return ok(await ops.listLeads(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("get_lead",
    "Get one lead by its EmailBison id (ids come from list_leads), with full custom_variables, tags, per-campaign data and overall stats.",
    {
      client_name: z.string(),
      lead_id: z.number(),
      instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
    },
    async (args) => {
      try { return ok(await ops.getLead(args)); }
      catch (e) { return err(e); }
    }
  );

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

  server.tool("replace_campaign_sequence",
    "Replace ALL sequence steps of an existing EmailBison campaign: deletes the current steps, then writes the new ones. Leads, inboxes and settings are untouched. Same step format as create_campaign_with_sequence. Use dry_run=true first to see the steps that would be removed.",
    {
      client_name: z.string(),
      campaign_id: z.number(),
      instance: z.enum(["eb_send", "eb_personal"]).optional(),
      sequence_steps: z.array(z.object({
        email_subject: z.string(),
        email_body: z.string(),
        wait_in_days: z.number(),
        order: z.number().nullable().optional(),
        variant: z.boolean().optional(),
        variant_from_step: z.number().optional(),
        thread_reply: z.boolean().optional(),
      })),
      dry_run: z.boolean().optional(),
    },
    async (args) => {
      try { return ok(await ops.replaceCampaignSequence(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("create_campaign_with_sequence",
    "Create a new EmailBison campaign (draft) and write its sequence steps in one call. No leads or inboxes. Each step: email_subject, email_body (HTML), wait_in_days, order; for an A/B variant set variant=true and variant_from_step=<parent order> (order may be omitted); set thread_reply=true for follow-ups in the same thread. Use dry_run=true to preview.",
    {
      client_name: z.string(),
      name: z.string(),
      instance: z.enum(["eb_send", "eb_personal"]).optional(),
      sequence_steps: z.array(z.object({
        email_subject: z.string(),
        email_body: z.string(),
        wait_in_days: z.number(),
        order: z.number().nullable().optional(),
        variant: z.boolean().optional(),
        variant_from_step: z.number().optional(),
        thread_reply: z.boolean().optional(),
      })),
      dry_run: z.boolean().optional(),
    },
    async (args) => {
      try { return ok(await ops.createCampaignWithSequence(args)); }
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

  server.tool("update_sender_daily_limit",
    "Update the daily_limit (send-per-day cap) on one or more sender emails (mailboxes) via EmailBison PATCH /sender-emails/{id}. IDs come from list_inboxes. PASS client_name: it selects the client's workspace-scoped token, and it is REQUIRED in practice on eb_personal, where the account master key is refused (401). Sender-email IDs are per-instance, so an ID from one instance names a different mailbox on the other — make sure instance matches where the IDs came from.",
    {
      instance: z.enum(["eb_send", "eb_personal"]),
      sender_email_ids: z.array(z.number()),
      daily_limit: z.number(),
      client_name: z.string().describe("The client these mailboxes belong to — REQUIRED. Selects that client's workspace-scoped token, which is the only credential EmailBison accepts here."),
    },
    async ({ instance, sender_email_ids, daily_limit, client_name }) => {
      // Pre-flight: GET each id with the client's scoped token before writing.
      // This doubles as the client/instance boundary check — an id belonging to
      // another workspace (or to the other instance, where ids mean something
      // else entirely) does not resolve under this key, so it is skipped rather
      // than silently rewritten.
      const writable = [], skipped = [];
      for (const id of sender_email_ids) {
        try {
          const g = await ops.getSenderEmail({ instance, sender_email_id: id, client_name });
          const email = g?.data?.data?.email ?? g?.data?.email ?? null;
          const before = g?.data?.data?.daily_limit ?? g?.data?.daily_limit ?? null;
          if (g.status >= 200 && g.status < 300) writable.push({ id, email, before });
          else skipped.push({ id, reason: `pre-flight ${g.status} — not reachable for ${client_name} on ${instance}` });
        } catch (e) {
          skipped.push({ id, reason: String(e) });
        }
      }

      const results = [];
      for (const { id } of writable) {
        try {
          const r = await ops.updateSenderEmail({ instance, sender_email_id: id, daily_limit, client_name });
          results.push({ id, status: r.status, key_source: r.key_source, ok: r.status >= 200 && r.status < 300 });
        } catch (e) {
          results.push({ id, ok: false, error: String(e) });
        }
      }
      const succeeded = results.filter(r => r.ok).length;
      const failed = results.filter(r => !r.ok);
      // Read back what EmailBison actually stored rather than trusting the PATCH
      // status — a 200 does not prove the cap changed.
      let verified = null;
      if (succeeded) {
        try {
          const ids = results.filter(r => r.ok).map(r => r.id);
          const checks = [];
          for (const id of ids.slice(0, 25)) {
            const g = await ops.getSenderEmail({ instance, sender_email_id: id, client_name });
            const got = g?.data?.data?.daily_limit ?? g?.data?.daily_limit ?? null;
            checks.push({ id, daily_limit: got, matches: got === daily_limit });
          }
          verified = {
            checked: checks.length,
            matching: checks.filter(c => c.matches).length,
            mismatched: checks.filter(c => !c.matches),
          };
        } catch (e) { verified = { error: String(e) }; }
      }
      return ok({
        requested_daily_limit: daily_limit,
        instance,
        client_name,
        key_source: results.find(r => r.key_source)?.key_source ?? null,
        requested: sender_email_ids.length,
        attempted: writable.length,
        skipped_preflight: skipped.length,
        skipped_sample: skipped.slice(0, 20),
        succeeded,
        failed: failed.length,
        failed_sample: failed.slice(0, 20),
        // before/after for the mailboxes actually written, read back from EmailBison
        changed_sample: writable.slice(0, 10).map(w => ({
          id: w.id, email: w.email, before: w.before, requested: daily_limit,
        })),
        verified,
      });
    }
  );

  server.tool("domain_bounce_rates",
    "Read-only. Bounce rate per client from EmailBison mailbox counts (lifetime sent/bounced), for Google or Outlook domains, plus the domains above min_rate. Pass only active clients.",
    {
      client_names: z.array(z.string()),
      provider: z.enum(["google", "outlook", "all"]).optional(),
      min_rate: z.number().optional(),
      min_sent: z.number().optional(),
      instance: z.enum(["eb_send", "eb_personal"]).optional(),
    },
    async (args) => {
      try { return ok(await ops.domainBounceRates(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("bounce_messages",
    "Read-only. EmailBison Bounced folder for one client, summarised: bounces per sender domain and per reason (SMTP code or the receiver's words), with 2 samples each. Filter by sender domains. Default last 7 days, 30 pages.",
    {
      client_name: z.string(),
      domains: z.array(z.string()).optional().describe("Sender domains to keep, e.g. [\"x.xyz\"]. Omit for all."),
      days: z.number().optional(),
      max_pages: z.number().optional(),
      instance: z.enum(["eb_send", "eb_personal"]).optional(),
    },
    async (args) => {
      try { return ok(await ops.bounceMessages(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("warmup_scores",
    "Warmup scores for a client's mailboxes, aggregated per domain. Scores are NOT on list_inboxes (that only has warmup_enabled) — they come from /warmup/sender-emails and are window-dependent, so this defaults to the last 30 days. Reports mailboxes below the threshold plus three readings of \"domains below\": average, all-mailboxes, any-mailbox.",
    {
      client_name: z.string(),
      days: z.number().optional().describe("Window length ending today. Default 30."),
      start_date: z.string().optional().describe("YYYY-MM-DD. Overrides days."),
      end_date: z.string().optional().describe("YYYY-MM-DD. Defaults to today."),
      below: z.number().optional().describe("Score threshold. Default 80."),
      include_domains: z.boolean().optional().describe("Include the per-domain table. Default true."),
      max_pages: z.number().optional(),
      instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
    },
    async (args) => {
      try { return ok(await ops.warmupScores(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("attach_inboxes_to_campaign",
    "Attach sender emails (inboxes) to a campaign so it can send, in one bulk call. IDs come from list_inboxes.",
    {
      client_name: z.string(),
      campaign_id: z.string(),
      sender_email_ids: z.array(z.number()),
       instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
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
       instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
    },
    async (args) => {
      try { return ok(await ops.removeInboxesFromCampaign(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("get_campaign_stats",
    "Get a single campaign's stats from EmailBison (read-only), including how many sender emails (inboxes) are currently attached — use this to check mailbox load per campaign. Optionally scope to a date range (start_date/end_date, YYYY-MM-DD) if the underlying route supports it; omit both for all-time stats.",
    {
      client_name: z.string(),
      campaign_id: z.string(),
       instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
       start_date: z.string().optional().describe("YYYY-MM-DD, inclusive. Best-effort — sent to EmailBison under several common param aliases."),
       end_date: z.string().optional().describe("YYYY-MM-DD, inclusive. Best-effort — sent to EmailBison under several common param aliases."),
    },
    async (args) => {
      try { return ok(await ops.getCampaignStats(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("get_campaign_senders",
    "Get the sender emails (mailboxes) currently attached to a campaign (read-only) — use this to measure mailbox load per campaign.",
    {
      client_name: z.string(),
      campaign_id: z.string(),
       instance: z.enum(["eb_send", "eb_personal"]).optional().describe("EmailBison instance. Omit to use the client default (its sequencer); set only for a client live on both."),
    },
    async (args) => {
      try { return ok(await ops.getCampaignSenders(args)); }
      catch (e) { return err(e); }
    }
  );

  // ── Direct infra read-only ops (cheap, no judgment needed — skip the
  //    run_infra_agent loop for investigation/status checks. Mutating/spend
  //    actions like register_domain, update_nameservers, inboxing_submit_domain
  //    stay agent-only so the "never register without an explicit go" rule and
  //    the agent's own review still gate anything that spends money.) ───────────
  // Registrar tools work against either registrar. `registrar` is optional and
  // defaults to INFRA_REGISTRAR (currently namesilo); pass it to target the other
  // without touching .env or restarting.
  const vRegistrar = z.enum(["namesilo", "porkbun", "dynadot"]).optional()
    .describe(`Which registrar to use. Defaults to INFRA_REGISTRAR (${infra.INFRA_REGISTRAR}). A domain only exists at the registrar it was bought from.`);

  server.tool("get_domain",
    "Get a domain's registrar status + current nameservers (read-only). Looks it up at one registrar only — a domain registered elsewhere will read as not found.",
    { domain: z.string(), registrar: vRegistrar },
    async ({ domain, registrar }) => {
      try { return ok(await infra.getDomain({ domain, registrar })); }
      catch (e) { return err(e); }
    }
  );

  server.tool("get_registrar_balance",
    "Get a registrar account balance (read-only). NameSilo returns a funded balance; Porkbun does not expose one via API, so it confirms credentials instead.",
    { registrar: vRegistrar },
    async ({ registrar }) => {
      try { return ok(await infra.getRegistrarBalance({ registrar })); }
      catch (e) { return err(e); }
    }
  );

  // ── NameSilo portfolios ──────────────────────────────────────────────────────
  // Portfolios are a NameSilo-only grouping for domains. No Porkbun/Dynadot
  // equivalent, so these are not part of the multi-registrar surface.
  server.tool("list_portfolios",
    "List the NameSilo account's portfolios (read-only). Portfolios group domains for organisation only — they do not affect DNS, mailboxes or billing.",
    {},
    async () => {
      try { return ok(await infra.listPortfolios()); }
      catch (e) { return err(e); }
    }
  );

  server.tool("assign_portfolio",
    "Assign NameSilo domains to a portfolio. Sends them in batches of 100 (NameSilo accepts a comma-separated list), so a large set costs a few calls rather than one per domain. Re-assigning a domain that is already in the portfolio is a harmless no-op, so you can pass a whole set without filtering first — listDomains does not expose the portfolio field, so filtering would cost one lookup per domain. Only domains registered AT NameSilo can be assigned; a Porkbun/Dynadot domain is silently ignored, which is why a sample is read back to confirm.",
    {
      portfolio: z.string().describe("Exact portfolio name, e.g. 'Outreach Engine Clients' — see list_portfolios"),
      domains: z.array(z.string()).describe("Domains to assign"),
      verify_sample: z.number().optional().describe("How many to read back afterwards to confirm it landed (default 3; 0 to skip)"),
    },
    async (args) => {
      try { return ok(await infra.assignPortfolio(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("check_domain_availability",
    "Check if domains are available + pricing (read-only). NameSilo checks the whole list in one batched call; Porkbun is one request per domain and rate-limited, so large lists are much slower there.",
    { domains: z.array(z.string()), registrar: vRegistrar },
    async ({ domains, registrar }) => {
      try { return ok(await infra.checkAvailability({ domains, registrar })); }
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

  server.tool("inboxing_download_csv",
    "Download an Inboxing domain's warmup/deliverability CSV report by domain job id (read-only). Includes columns like Warmup Score (30 days).",
    { domain_id: z.string() },
    async ({ domain_id }) => {
      try { return ok(await infra.inboxingDownloadCsv({ domain_id })); }
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

  // ── Valley (LinkedIn sequencer) ──────────────────────────────────────────────
  // Valley sends from *collaborators* (Valley users with LinkedIn attached), not
  // from provisioned domains/mailboxes — so there is no infra half here.
  //
  // READ-ONLY surface by design. Valley's write paths (create/start/pause a
  // campaign, add-lead, approve a queued message) send real LinkedIn outreach to
  // real people, and add-lead is explicitly non-idempotent, so they are not
  // exposed as one-shot tools.
  const vWorkspace = z.string().describe("Valley workspace id — from valley_list_workspaces");

  server.tool("valley_list_workspaces",
    "List every Valley workspace the API key can see. Workspace names line up with client names (Intellectible, Braintracks, Pargo AI, …), so this is how you resolve a client to its Valley workspace id.",
    {},
    async () => { try { return ok(await valley.listWorkspaces()); } catch (e) { return err(e); } }
  );

  server.tool("valley_list_collaborators",
    "List a Valley workspace's collaborators — the seats that send LinkedIn outreach. Returns identity + role (OWNER/ADMIN/MEMBER). Note Valley exposes no LinkedIn-connection field, so this does not tell you whether a seat can currently send; campaign_owner_name on a campaign is the only signal for that.",
    { workspace_id: vWorkspace },
    async (a) => { try { return ok(await valley.listCollaborators(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_list_campaigns",
    "List Valley campaigns, optionally scoped to one workspace. Includes status, type (e.g. INMAIL), prospect counts, acceptance/response rate and campaign owner.",
    { workspace_id: z.string().optional().describe("Omit for all workspaces the key can see") },
    async (a) => { try { return ok(await valley.listCampaigns(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_get_campaign",
    "Get one Valley campaign by id.",
    { campaign_id: z.string() },
    async (a) => { try { return ok(await valley.getCampaign(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_campaign_prospects",
    "List the prospects in a Valley campaign.",
    { campaign_id: z.string(), all: z.boolean().optional().describe("Page through everything (default true)") },
    async (a) => { try { return ok(await valley.getCampaignProspects(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_campaign_analytics",
    "Per-campaign analytics. startDate and endDate are REQUIRED by the API (undocumented — omitting them is a 400).",
    { campaign_id: z.string(), start_date: z.string().describe("YYYY-MM-DD"), end_date: z.string().describe("YYYY-MM-DD") },
    async (a) => { try { return ok(await valley.getCampaignAnalytics(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_analytics_overview",
    "Workspace-level analytics overview. workspaceId, startDate and endDate are all REQUIRED by the API.",
    { workspace_id: vWorkspace, start_date: z.string().describe("YYYY-MM-DD"), end_date: z.string().describe("YYYY-MM-DD") },
    async (a) => { try { return ok(await valley.analyticsOverview(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_list_conversations",
    "List LinkedIn reply threads in a Valley workspace inbox.",
    { workspace_id: vWorkspace, view: z.enum(["inbox", "archived"]).optional().describe("default inbox") },
    async (a) => { try { return ok(await valley.listConversations(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_list_approvals",
    "List AI-drafted LinkedIn messages in the approvals queue. Read-only: approving/unapproving is deliberately not exposed, since approving sends real outreach.",
    { workspace_id: vWorkspace, view: z.enum(["pending", "approved", "scheduled"]).optional().describe("default pending") },
    async (a) => { try { return ok(await valley.listApprovalMessages(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_warmlist_stats",
    "Warm-signal counts for a workspace — profile viewers, followers and engagers, each bucketed by ICP fit (low/medium/high).",
    { workspace_id: vWorkspace },
    async (a) => { try { return ok(await valley.warmlistStats(a)); } catch (e) { return err(e); } }
  );

  server.tool("valley_warmlist_segment",
    "List the people behind a warm signal: followers, profile viewers, or post engagers.",
    { workspace_id: vWorkspace, segment: z.enum(["followers", "viewers", "engagers"]),
      all: z.boolean().optional().describe("Page through everything (default true)") },
    async ({ workspace_id, segment, all }) => {
      try {
        const fn = { followers: valley.warmlistFollowers, viewers: valley.warmlistViewers, engagers: valley.warmlistEngagers }[segment];
        return ok(await fn({ workspace_id, all: all ?? true }));
      } catch (e) { return err(e); }
    }
  );

  // ── Hospital (read-only, V1) ────────────────────────────────────────────────
  server.tool("hospital_status",
    "Get current hospital run status, lock state, and recovery job progress.",
    { run_id: z.string().optional().describe("Specific run ID; omit for latest") },
    async ({ run_id }) => { try { return ok(await hospital.hospitalStatus(run_id)); } catch (e) { return err(e); } }
  );

  server.tool("hospital_report",
    "Get detailed outcome report from hospital run: domains condemned, leads recovered, errors.",
    { run_id: z.string().optional().describe("Run ID to report on") },
    async ({ run_id }) => { try { return ok(await hospital.hospitalReport(run_id)); } catch (e) { return err(e); } }
  );

  server.tool("hospital_events",
    "Get quarantine/release/recovery events timeline.",
    {
      run_id: z.string().optional().describe("Filter by run"),
      limit: z.number().optional().default(100).describe("Max events (default 100)"),
    },
    async ({ run_id, limit }) => { try { return ok(await hospital.hospitalEvents(run_id, limit)); } catch (e) { return err(e); } }
  );

  server.tool("hospital_runs",
    "List hospital runs with summary info (paginated).",
    {
      limit: z.number().optional().default(50).describe("Results per page"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ limit, offset }) => { try { return ok(await hospital.hospitalRuns(limit, offset)); } catch (e) { return err(e); } }
  );

  server.tool("hospital_retired",
    "Get archive of retired/burned domains and mailboxes.",
    {
      days: z.number().optional().default(30).describe("Look back N days"),
      client: z.string().optional().describe("Filter by client"),
    },
    async ({ days, client }) => { try { return ok(await hospital.retiredRecords(days, client)); } catch (e) { return err(e); } }
  );

  // ── Cheap Inboxes (mailbox reseller, same role as Inboxing) ──────────────────
  // READ-ONLY. The API can order, provision, pay invoices and cancel paid
  // resources; none of that is exposed. Spending stays a human decision.
  server.tool("cheapinboxes_list_domains",
    "List Cheap Inboxes domains (read-only). Pages through everything by default (886 on this account; the API returns 50 at a time). Filter with status or tags (comma-separated, matches ANY). Key on each domain's computed `readiness` object (state/owner/reason_code/next_action) rather than parsing status.",
    {
      status: z.string().optional().describe("e.g. active, provisioning, error"),
      tags: z.string().optional().describe("Comma-separated; matches ANY"),
      all: z.boolean().optional().describe("Page through everything (default true)"),
      max: z.number().optional().describe("Cap the number returned"),
    },
    async (a) => { try { return ok(await cheap.listDomains(a)); } catch (e) { return err(e); } }
  );

  server.tool("cheapinboxes_get_domain",
    "Get one Cheap Inboxes domain by id, including readiness and DNS state (read-only).",
    { id: z.string() },
    async (a) => { try { return ok(await cheap.getDomain(a)); } catch (e) { return err(e); } }
  );

  server.tool("cheapinboxes_domain_dns",
    "Inspect a domain's DNS at Cheap Inboxes (read-only): records, health check, or DMARC config.",
    { id: z.string(), view: z.enum(["records", "health", "dmarc", "runs"]).optional().describe("default records") },
    async ({ id, view = "records" }) => {
      try {
        const fn = { records: cheap.getDomainDnsRecords, health: cheap.getDomainDnsHealth,
                     dmarc: cheap.getDomainDmarc, runs: cheap.getDomainRuns }[view];
        return ok(await fn({ id }));
      } catch (e) { return err(e); }
    }
  );

  server.tool("cheapinboxes_list_mailboxes",
    "List Cheap Inboxes mailboxes (read-only). Pages through everything by default (4,185 on this account). Filter with status, tags or domain_id.",
    {
      status: z.string().optional(),
      tags: z.string().optional().describe("Comma-separated; matches ANY"),
      domain_id: z.string().optional(),
      all: z.boolean().optional().describe("Page through everything (default true)"),
      max: z.number().optional(),
    },
    async (a) => { try { return ok(await cheap.listMailboxes(a)); } catch (e) { return err(e); } }
  );

  server.tool("cheapinboxes_get_mailbox",
    "Get one Cheap Inboxes mailbox by id (read-only). Set include_credentials to also fetch live sending credentials — treat that output as secret.",
    { id: z.string(), include_credentials: z.boolean().optional().describe("Default false") },
    async ({ id, include_credentials }) => {
      try {
        const mailbox = await cheap.getMailbox({ id });
        if (!include_credentials) return ok(mailbox);
        return ok({ mailbox, credentials: await cheap.getMailboxCredentials({ id }) });
      } catch (e) { return err(e); }
    }
  );

  server.tool("cheapinboxes_account",
    "Cheap Inboxes account-level reads: org details, domain tags, mailbox pricing tiers, TLD pricing, integrations, billing summary, or orders. A pricing quote is a read, not a purchase.",
    { view: z.enum(["org", "tags", "pricing", "tlds", "integrations", "billing", "orders"]) },
    async ({ view }) => {
      try {
        const fn = { org: cheap.getOrg, tags: cheap.listDomainTags, pricing: cheap.mailboxPricing,
                     tlds: cheap.tldPricing, integrations: cheap.listIntegrations,
                     billing: cheap.billingSummary, orders: cheap.listOrders }[view];
        return ok(await fn({}));
      } catch (e) { return err(e); }
    }
  );

  // ── Cloudflare DNS (read-only) ───────────────────────────────────────────────
  // Writes are not exposed: a wrong DNS edit silently breaks mail delivery on a
  // sending domain. Only zones in THIS Cloudflare account are visible — Inboxing
  // and Cheap Inboxes provision into their own accounts.
  server.tool("cloudflare_list_zones",
    "List Cloudflare zones in this account (read-only). Only your own zones — domains whose DNS is managed by Inboxing or Cheap Inboxes live in THEIR Cloudflare accounts and will not appear here.",
    { all: z.boolean().optional(), max: z.number().optional() },
    async (a) => { try { return ok(await cf.listZones(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_dns_records",
    "List a zone's DNS records (read-only). Accepts a zone name or zone id; filter by type (A, MX, TXT, CNAME…) or exact record name.",
    {
      zone: z.string().describe("Zone name (example.com) or 32-hex zone id"),
      type: z.string().optional().describe("Record type filter, e.g. TXT or MX"),
      name: z.string().optional().describe("Exact record name filter"),
      all: z.boolean().optional(),
    },
    async (a) => { try { return ok(await cf.listDnsRecords(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_email_dns_check",
    "Check a zone's email-sending DNS posture (read-only): SPF, DKIM, DMARC and MX presence, plus the zone's activation status and warnings such as duplicate SPF records. Use this to confirm a sending domain is actually configured, rather than trusting a provisioning status.",
    { zone: z.string().describe("Zone name or zone id") },
    async (a) => { try { return ok(await cf.emailDnsCheck(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_add_domain",
    "Add domains to Cloudflare and return the nameserver pair Cloudflare assigns to each. Adding a zone is free and changes nothing on its own — Cloudflare only becomes authoritative once the REGISTRAR points at the assigned pair. Set point_registrar to also push those nameservers at the registrar in the same pass (that IS a live DNS change). Re-adding an existing zone returns it rather than erroring.",
    {
      domains: z.array(z.string()).describe("Domains to add as Cloudflare zones"),
      point_registrar: z.enum(["namesilo", "porkbun", "dynadot"]).optional()
        .describe("Also set the assigned nameservers at this registrar. Omit to only add the zones and report the pair. The domain must be registered AT that registrar."),
    },
    async ({ domains, point_registrar }) => {
      const results = [];
      for (const domain of domains) {
        const row = { domain };
        try {
          const zone = await cf.createZone({ name: domain });
          row.zone_id = zone.id;
          row.already_existed = zone.already_existed;
          row.zone_status = zone.status;
          row.nameservers = zone.name_servers ?? [];

          if (point_registrar) {
            if (!row.nameservers.length) {
              row.registrar_update = "skipped — Cloudflare returned no nameservers yet";
            } else {
              try {
                await infra.updateNameservers({ domain, nameservers: row.nameservers, registrar: point_registrar });
                // Read back from the registrar rather than trusting the write.
                const check = await infra.getDomain({ domain, registrar: point_registrar });
                row.registrar = point_registrar;
                row.registrar_nameservers = check.nameservers ?? [];
                row.registrar_update = "ok";
              } catch (e) {
                row.registrar_update = `FAILED: ${String(e).slice(0, 180)}`;
              }
            }
          }
        } catch (e) {
          row.error = String(e).slice(0, 200);
        }
        results.push(row);
      }
      return ok({
        requested: domains.length,
        added: results.filter(r => r.zone_id && !r.already_existed).length,
        already_existed: results.filter(r => r.already_existed).length,
        failed: results.filter(r => r.error).length,
        registrar_pushed: results.filter(r => r.registrar_update === "ok").length,
        results,
      });
    }
  );

  server.tool("masterinbox_connect_urls",
    "Generate MasterInbox mailbox-connect URLs, one per email, for a client's workspace. MasterInbox has NO credential upload — /add-account accepts only google or outlook and returns an OAuth URL, so each mailbox still needs a person to complete consent; this just removes the wizard clicks and preselects the account via login_hint. URLs are single-use and short-lived, so generate them when you are ready to click.",
    {
      client_name: z.string().describe("Client whose MasterInbox workspace the mailboxes land in"),
      emails: z.array(z.string()).describe("Mailbox addresses to generate connect links for"),
      provider: z.enum(["google", "outlook"]).optional().describe("Default google"),
    },
    async (a) => { try { return ok(await ops.mailboxConnectUrls(a)); } catch (e) { return err(e); } }
  );

  // ── Cloudflare email DNS writes ──────────────────────────────────────────────
  // Scoped to SPF / DKIM / DMARC / MX only. Every tool takes dry_run, and every
  // applied write is read back from Cloudflare before it reports success.
  server.tool("cloudflare_set_spf",
    "Set the SPF record on a zone (TXT at the apex). Replaces any existing SPF and collapses duplicates — RFC 7208 permits exactly one, and two SPF records make receivers fail the check outright. Pass dry_run to see the before/after without writing. LIVE DNS CHANGE: a wrong SPF stops your mail being trusted.",
    {
      zone: z.string().describe("Zone name or zone id"),
      value: z.string().describe('Full SPF record, e.g. "v=spf1 include:_spf.google.com ~all"'),
      ttl: z.number().optional().describe("TTL seconds; 1 = automatic (default)"),
      dry_run: z.boolean().optional(),
    },
    async (a) => { try { return ok(await cf.setSpf(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_set_dmarc",
    "Set the DMARC record on a zone (TXT at _dmarc). Either pass a full value, or let it build one from policy (none|quarantine|reject) plus optional rua and pct. Pass dry_run to preview. LIVE DNS CHANGE: p=reject on a domain that is not aligned will bounce your own mail.",
    {
      zone: z.string().describe("Zone name or zone id"),
      value: z.string().optional().describe('Full record, e.g. "v=DMARC1; p=none; rua=mailto:x@y.com". Overrides policy/rua/pct.'),
      policy: z.enum(["none", "quarantine", "reject"]).optional().describe("Defaults to none"),
      rua: z.string().optional().describe("Aggregate report address (bare email, mailto: is added)"),
      pct: z.number().optional().describe("Percentage of mail the policy applies to"),
      ttl: z.number().optional(),
      dry_run: z.boolean().optional(),
    },
    async (a) => { try { return ok(await cf.setDmarc(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_set_dkim",
    "Publish a DKIM key for a zone at <selector>._domainkey. Supply value for a TXT record (the key itself) or cname_target for a CNAME (what Google Workspace and most ESPs hand you) — exactly one of the two. Pass dry_run to preview. LIVE DNS CHANGE.",
    {
      zone: z.string().describe("Zone name or zone id"),
      selector: z.string().describe("Selector label, e.g. google, s1, or k1"),
      value: z.string().optional().describe("TXT content, e.g. v=DKIM1; k=rsa; p=MIGf..."),
      cname_target: z.string().optional().describe("CNAME target, e.g. s1.domainkey.u123.wl.sendgrid.net"),
      ttl: z.number().optional(),
      dry_run: z.boolean().optional(),
    },
    async (a) => { try { return ok(await cf.setDkim(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_set_mx",
    "Set the MX records on a zone. By default REPLACES the whole MX set, which is what pointing a domain at a mail provider means; set replace=false to add instead. Accepts plain hostnames (priorities default to 10, 20, 30…) or {host, priority} objects. Pass dry_run to preview. LIVE DNS CHANGE: wrong MX means inbound mail stops arriving.",
    {
      zone: z.string().describe("Zone name or zone id"),
      hosts: z.array(z.any()).describe('Hostnames or {host, priority} objects, e.g. ["aspmx.l.google.com"] or [{"host":"mx1.example.com","priority":10}]'),
      replace: z.boolean().optional().describe("Default true — delete the existing MX set first"),
      ttl: z.number().optional(),
      dry_run: z.boolean().optional(),
    },
    async (a) => { try { return ok(await cf.setMx(a)); } catch (e) { return err(e); } }
  );

  server.tool("cloudflare_delete_email_record",
    "Delete one email DNS record by id — a duplicate SPF, a dead DKIM selector. Refuses any record that is not SPF, DKIM, DMARC or MX inside the given zone. Get record ids from cloudflare_dns_records. Pass dry_run to see what would go.",
    {
      zone: z.string().describe("Zone name or zone id"),
      record_id: z.string().describe("DNS record id from cloudflare_dns_records"),
      dry_run: z.boolean().optional(),
    },
    async (a) => { try { return ok(await cf.deleteEmailRecord(a)); } catch (e) { return err(e); } }
  );

  server.tool("copy_campaign_settings",
    "Copy campaign settings (daily limits, plain text, tracking, unsubscribe, prioritization, per-domain cap) and the sending schedule from one EmailBison campaign to another on the same instance. Sequence, leads and inboxes untouched. Use dry_run=true to see what would be copied.",
    {
      client_name: z.string(),
      source_campaign_id: z.number(),
      dest_campaign_id: z.number(),
      instance: z.enum(["eb_send", "eb_personal"]).optional(),
      dry_run: z.boolean().optional(),
    },
    async (args) => {
      try { return ok(await ops.copyCampaignSettings(args)); }
      catch (e) { return err(e); }
    }
  );

  server.tool("set_nameservers",
    "Set custom nameservers on domains at a registrar (default NameSilo). Accepts ANY nameservers — e.g. the pair Cheap Inboxes assigns — unlike cloudflare_add_domain, which only points at our own Cloudflare pair. Updates each domain in turn (NameSilo changeNameServers is per-domain) and reports per-domain success/failure. A domain only exists at the registrar it was bought from.",
    {
      domains: z.array(z.string()).nonempty().describe("Domain names to update"),
      nameservers: z.array(z.string()).min(2).describe("Nameservers to set (registrar requires at least 2)"),
      registrar: vRegistrar,
    },
    async ({ domains, nameservers, registrar }) => {
      const results = [];
      for (const domain of domains) {
        try {
          const r = await infra.updateNameservers({ domain, nameservers, registrar });
          results.push({ domain, ok: true, ...r });
        } catch (e) {
          results.push({ domain, ok: false, error: String(e).slice(0, 180) });
        }
      }
      return ok({
        requested: domains.length,
        updated: results.filter(r => r.ok).length,
        failed: results.filter(r => !r.ok).length,
        nameservers, results,
      });
    }
  );

  server.tool("cheapinboxes_sync_nameservers",
    "For every Cheap Inboxes domain waiting on nameservers (status pending_ns_verification), set the pair Cheap Inboxes assigned to it at the domain's own registrar. The assigned pair differs per domain. Pass dry_run:true to see what it would change without changing anything, or a `domains` list to limit it to those. Never buys, renews, or touches Inboxing. Paused between registrar calls for NameSilo's rate limits.",
    {
      domains: z.array(z.string()).optional().describe("Limit to these domains; omit to handle every pending one"),
      dry_run: z.boolean().optional().describe("True = report planned changes, write nothing"),
    },
    async ({ domains, dry_run }) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const REGS = ["namesilo", "porkbun", "dynadot"];
      try {
        // 1) every CheapInboxes domain waiting on nameservers
        const pending = (await cheap.listDomains({ status: "pending_ns_verification", all: true })).domains || [];
        // 2) narrow to the requested names, if any
        let targets = pending, requested_not_pending = [];
        if (Array.isArray(domains) && domains.length) {
          const want = new Set(domains.map(d => d.toLowerCase()));
          targets = pending.filter(d => want.has(String(d.domain).toLowerCase()));
          const have = new Set(pending.map(d => String(d.domain).toLowerCase()));
          requested_not_pending = domains.filter(d => !have.has(d.toLowerCase()));
        }

        const results = [];
        for (const d of targets) {
          // 3) the pair CheapInboxes assigned this domain
          const ns = d.readiness?.next_action?.nameservers ?? d.nameservers ?? [];
          const row = { domain: d.domain, registrar: null, nameservers: ns, status: null };
          if (!Array.isArray(ns) || ns.length < 2) {
            row.status = "failed"; row.error = "no assigned nameserver pair on this domain";
            results.push(row); continue;
          }
          // 4) which registrar is it at? probe NameSilo, then Porkbun, then Dynadot.
          for (const r of REGS) {
            try { await infra.getDomain({ domain: d.domain, registrar: r }); row.registrar = r; break; }
            catch { /* not at this registrar */ }
            await sleep(600);
          }
          if (!row.registrar) { row.status = "skipped"; row.error = "not found at NameSilo/Porkbun/Dynadot"; results.push(row); continue; }
          // 5) set them, unless this is a dry run
          if (dry_run) { row.status = "would_update"; results.push(row); await sleep(400); continue; }
          try { await infra.updateNameservers({ domain: d.domain, nameservers: ns, registrar: row.registrar }); row.status = "updated"; }
          catch (e) { row.status = "failed"; row.error = String(e).slice(0, 180); }
          results.push(row);
          await sleep(800);   // NameSilo rate limit between writes
        }

        return ok({
          pending_total: pending.length,
          processed: targets.length,
          dry_run: !!dry_run,
          updated: results.filter(r => r.status === "updated").length,
          would_update: results.filter(r => r.status === "would_update").length,
          skipped: results.filter(r => r.status === "skipped").length,
          failed: results.filter(r => r.status === "failed").length,
          ...(requested_not_pending.length ? { requested_not_pending } : {}),
          results,
        });
      } catch (e) { return err(e); }
    }
  );

  // ── Cheap Inboxes — buying mailboxes (cost-gated) ────────────────────────────
  // A quote is free; a checkout spends. The buy tool enforces, every call: a live
  // re-quote, a hard max-spend ceiling (env CHEAPINBOXES_MAX_SPEND_CENTS, default
  // $200), and an explicit confirmation of the exact amount. No silent spend.
  server.tool("cheapinboxes_quote",
    "Get a Cheap Inboxes price quote for buying mailboxes — FREE, no charge, no order placed. One entry per domain with provider + count. Returns line items and quote.totals.total_today_cents.",
    {
      domains: z.array(z.object({
        domain: z.string().describe("Full domain, e.g. example.com or example.digital"),
        provider: z.enum(["google", "microsoft"]).optional().describe("Default google"),
        count: z.number().int().positive().describe("Mailboxes to price on this domain"),
        isExisting: z.boolean().optional().describe("Default true — a domain already in the account"),
        staged_import_id: z.string().optional(),
      })),
      promo_code: z.string().optional(),
    },
    async (a) => { try { return ok(await cheap.quoteOrder(a)); } catch (e) { return err(e); } }
  );

  server.tool("cheapinboxes_buy_mailboxes",
    "BUY mailboxes on Cheap Inboxes — SPENDS REAL MONEY. Guarded: always re-quotes live, refuses if the total exceeds the max-spend cap, and refuses unless confirm:true AND confirm_total_cents equals the live quote. Flow: call once WITHOUT confirm to get the quote + exact total, then call again with the SAME args plus confirm:true and confirm_total_cents set to that total. Provide names per domain (\"First Last\") — each becomes one mailbox.",
    {
      domains: z.array(z.object({
        domain: z.string().describe("Full domain, e.g. example.com"),
        provider: z.enum(["google", "microsoft"]).optional().describe("Default google"),
        isExisting: z.boolean().optional().describe("Default true"),
        staged_import_id: z.string().optional(),
        names: z.array(z.string()).nonempty().describe('Mailbox owners as "First Last"; mailbox count = names.length'),
      })),
      confirm: z.boolean().optional().describe("Must be true to actually place the order"),
      confirm_total_cents: z.number().optional().describe("Must equal the live quote's total_today_cents"),
      max_spend_usd: z.number().optional().describe("Tighten the cap for THIS call; cannot exceed the env ceiling"),
      order_name: z.string().optional(),
      integration_id: z.string().optional(),
      fulfillment: z.enum(["diy", "dfy"]).optional().describe("Default diy"),
      promo_code: z.string().optional(),
    },
    async ({ domains, confirm, confirm_total_cents, max_spend_usd, order_name, integration_id, fulfillment, promo_code }) => {
      try {
        if (!Array.isArray(domains) || !domains.length) throw new Error("domains must be a non-empty array");
        // Build accounts from names; count is derived, never taken on faith.
        const prepared = domains.map(d => {
          const accounts = (d.names || []).map(cheap.nameToAccount);
          if (!accounts.length) throw new Error(`domain ${d.domain}: provide at least one name`);
          return { ...d, accounts, count: accounts.length };
        });

        // 1) live re-quote — the charge is always computed fresh, never trusted from input.
        const quote = await cheap.quoteOrder({
          domains: prepared.map(d => ({ domain: d.domain, provider: d.provider, count: d.count, isExisting: d.isExisting, staged_import_id: d.staged_import_id })),
          promo_code,
        });
        const total = quote?.totals?.total_today_cents;
        if (typeof total !== "number") throw new Error("could not read total_today_cents from the quote");

        // 2) cap — env ceiling is absolute; max_spend_usd can only tighten it.
        const envCeiling = Number(process.env.CHEAPINBOXES_MAX_SPEND_CENTS ?? 20000);
        const cap = Math.min(envCeiling, max_spend_usd != null ? Math.round(max_spend_usd * 100) : Infinity);
        if (total > cap) {
          return ok({ blocked: true, reason: "exceeds_max_spend",
            total_today_cents: total, total_usd: (total / 100).toFixed(2),
            cap_cents: cap, cap_usd: (cap / 100).toFixed(2), quote,
            note: `Refusing: $${(total / 100).toFixed(2)} exceeds the cap of $${(cap / 100).toFixed(2)}. Lower the order, raise max_spend_usd (up to the env ceiling), or raise CHEAPINBOXES_MAX_SPEND_CENTS.` });
        }

        // 3) confirmation gate — no confirm, no spend. Return the quote to confirm against.
        if (confirm !== true) {
          return ok({ requires_confirmation: true,
            total_today_cents: total, total_usd: (total / 100).toFixed(2),
            cap_usd: (cap / 100).toFixed(2), mailboxes: prepared.reduce((n, d) => n + d.count, 0), quote,
            next_step: `Re-call cheapinboxes_buy_mailboxes with the SAME args plus confirm:true and confirm_total_cents:${total}` });
        }
        if (confirm_total_cents !== total) {
          return ok({ blocked: true, reason: "amount_mismatch",
            confirm_total_cents, live_total_cents: total,
            note: `Live quote is ${total} cents; you confirmed ${confirm_total_cents}. Re-confirm with confirm_total_cents:${total}.` });
        }

        // 4) checkout — spends exactly the confirmed, capped, re-quoted amount.
        const result = await cheap.checkoutOrder({
          domains: prepared.map(d => ({ domain: d.domain, provider: d.provider, isExisting: d.isExisting, staged_import_id: d.staged_import_id, accounts: d.accounts })),
          promo_code, integration_id, name: order_name, fulfillment,
        });
        return ok({ purchased: true, charged_cents: total, charged_usd: (total / 100).toFixed(2), order: result?.data ?? result });
      } catch (e) { return err(e); }
    }
  );

  // ── Cheap Inboxes — import → checkout → nameservers → order (pipeline) ────────
  server.tool("cheapinboxes_import_domains",
    "Register domains you already own with Cheap Inboxes (FREE — stages them for import, no charge). Returns an import record per domain; its id is the staged_import_id you pass to cheapinboxes_checkout. Use source_provider \"manual\" or \"external\" for a domain registered elsewhere (e.g. NameSilo).",
    {
      domains: z.array(z.string()).nonempty().describe("Domain names to stage, e.g. [\"brand01.com\", ...]"),
      source_provider: z.enum(["manual", "external", "namecheap", "godaddy", "porkbun", "cloudflare", "DIY_import", "DFY_import", "migration"]).optional().describe("Default manual"),
      metadata: z.record(z.any()).optional(),
    },
    async (a) => { try { return ok(await cheap.importDomains(a)); } catch (e) { return err(e); } }
  );

  server.tool("cheapinboxes_checkout",
    "Place a Cheap Inboxes order for staged/imported domains — SPENDS REAL MONEY (charges the saved card). Guarded exactly like cheapinboxes_buy_mailboxes: pass dry_run:true (or omit confirm) to get the total with NO charge; then re-call with confirm:true and confirm_total_cents equal to that total. Enforces the max-spend cap (env CHEAPINBOXES_MAX_SPEND_CENTS, default $200). An Idempotency-Key is sent so a retry can never double-charge — reuse the idempotency_key returned by the preview on the committing call.",
    {
      domains: z.array(z.object({
        domain: z.string().describe("Full domain, e.g. brand01.com"),
        staged_import_id: z.string().optional().describe("The import id from cheapinboxes_import_domains"),
        isExisting: z.boolean().optional().describe("Default true"),
        provider: z.enum(["google", "microsoft"]).optional().describe("Default google"),
        accounts: z.array(z.object({
          first_name: z.string(), last_name: z.string(), email_prefix: z.string(),
        })).nonempty().describe("One per mailbox"),
      })).nonempty(),
      name: z.string().optional().describe("Order name"),
      fulfillment: z.enum(["diy", "dfy"]).optional().describe("Default diy"),
      preferred_mailbox_password: z.string().optional(),
      integration_id: z.string().optional(),
      promo_code: z.string().optional(),
      dry_run: z.boolean().optional().describe("True = return the total only, never charge"),
      confirm: z.boolean().optional().describe("Must be true to actually charge"),
      confirm_total_cents: z.number().optional().describe("Must equal the live quote's total_today_cents"),
      max_spend_usd: z.number().optional().describe("Tighten the cap for THIS call; cannot exceed the env ceiling"),
      idempotency_key: z.string().optional().describe("Reuse the one from the preview so a retry can't double-charge"),
    },
    async (args) => {
      try {
        const { domains, name, fulfillment, preferred_mailbox_password, integration_id, promo_code,
                dry_run, confirm, confirm_total_cents, max_spend_usd } = args;
        const idk = args.idempotency_key || (globalThis.crypto?.randomUUID?.() ?? `idk_${Date.now()}_${Math.random().toString(36).slice(2)}`);

        // live re-quote — charge is always computed fresh from the real cart
        const quote = await cheap.quoteOrder({
          domains: domains.map(d => ({ domain: d.domain, provider: d.provider, count: d.accounts.length, isExisting: d.isExisting, staged_import_id: d.staged_import_id })),
          promo_code,
        });
        const total = quote?.totals?.total_today_cents;
        if (typeof total !== "number") throw new Error("could not read total_today_cents from the quote");
        const base = { total_today_cents: total, total_usd: (total / 100).toFixed(2), mailboxes: domains.reduce((n, d) => n + d.accounts.length, 0), idempotency_key: idk };

        // dry run: price only, no charge
        if (dry_run) return ok({ dry_run: true, ...base, quote });

        // cap
        const envCeiling = Number(process.env.CHEAPINBOXES_MAX_SPEND_CENTS ?? 20000);
        const cap = Math.min(envCeiling, max_spend_usd != null ? Math.round(max_spend_usd * 100) : Infinity);
        if (total > cap) {
          return ok({ blocked: true, reason: "exceeds_max_spend", ...base, cap_cents: cap, cap_usd: (cap / 100).toFixed(2), quote,
            note: `Refusing: $${(total / 100).toFixed(2)} exceeds the cap of $${(cap / 100).toFixed(2)}. Lower the order, raise max_spend_usd (up to the env ceiling), or raise CHEAPINBOXES_MAX_SPEND_CENTS.` });
        }

        // confirmation
        if (confirm !== true) {
          return ok({ requires_confirmation: true, ...base, cap_usd: cap === Infinity ? null : (cap / 100).toFixed(2), quote,
            next_step: `Re-call cheapinboxes_checkout with the SAME args plus confirm:true, confirm_total_cents:${total}, idempotency_key:"${idk}"` });
        }
        if (confirm_total_cents !== total) {
          return ok({ blocked: true, reason: "amount_mismatch", confirm_total_cents, live_total_cents: total, idempotency_key: idk,
            note: `Live quote is ${total} cents; you confirmed ${confirm_total_cents}. Re-confirm with confirm_total_cents:${total}.` });
        }

        // commit
        const result = await cheap.checkoutOrder({
          domains, name, fulfillment, preferred_mailbox_password, integration_id, promo_code, idempotency_key: idk,
        });
        return ok({ purchased: true, charged_cents: total, charged_usd: (total / 100).toFixed(2), idempotency_key: idk, order: result?.data ?? result });
      } catch (e) { return err(e); }
    }
  );

  server.tool("cheapinboxes_get_nameservers",
    "Get the 2 nameservers Cheap Inboxes assigns to an imported domain after its order is paid (read — no charge). Point the registrar at these with set_nameservers. Keyed on the domain id.",
    { id: z.string().describe("Cheap Inboxes domain id") },
    async (a) => { try { return ok(await cheap.getImportNameservers(a)); } catch (e) { return err(e); } }
  );

  server.tool("cheapinboxes_get_order",
    "Check a Cheap Inboxes order's progress by id (read-only), including its `readiness` status. Use to confirm mailboxes went live after checkout.",
    { id: z.string().describe("Order id from cheapinboxes_checkout") },
    async (a) => { try { return ok(await cheap.getOrder(a)); } catch (e) { return err(e); } }
  );

  // ── Icemail (read-only) ──────────────────────────────────────────────────────
  // Reseller like Inboxing / Cheap Inboxes. Spend + mutation endpoints (orders,
  // wallet top-up, prewarm buy, export, and every DNS / mailbox / domain write)
  // are deliberately not exposed — read surfaces only.
  server.tool("icemail_list_domains",
    "List Icemail domains (read-only). Pages through everything by default (API returns ≤50/page). Optional `search` filters by name.",
    { search: z.string().optional(), all: z.boolean().optional().describe("Page through everything (default true)"), max: z.number().optional() },
    async (a) => { try { return ok(await ice.listDomains(a)); } catch (e) { return err(e); } }
  );

  server.tool("icemail_get_domain",
    "Get one Icemail domain by id (read-only).",
    { id: z.string() },
    async (a) => { try { return ok(await ice.getDomain(a)); } catch (e) { return err(e); } }
  );

  server.tool("icemail_domain_dns",
    "Get an Icemail domain's DNS records by domain id (read-only).",
    { id: z.string() },
    async (a) => { try { return ok(await ice.getDomainDnsRecords(a)); } catch (e) { return err(e); } }
  );

  server.tool("icemail_check_domain",
    "Check domain availability at Icemail (read-only lookup — a quote, not a purchase). `search` is the domain to check.",
    { search: z.string().describe("Domain to check, e.g. example.com") },
    async (a) => { try { return ok(await ice.checkDomainAvailable(a)); } catch (e) { return err(e); } }
  );

  server.tool("icemail_list_mailboxes",
    "List Icemail mailboxes (read-only). Pages through everything by default. Optional `search` filter.",
    { search: z.string().optional(), all: z.boolean().optional().describe("Page through everything (default true)"), max: z.number().optional() },
    async (a) => { try { return ok(await ice.listMailboxes(a)); } catch (e) { return err(e); } }
  );

  server.tool("icemail_mailboxes_by_domain",
    "List Icemail mailboxes under one domain id (read-only).",
    { id: z.string() },
    async (a) => { try { return ok(await ice.getMailboxesByDomain(a)); } catch (e) { return err(e); } }
  );

  server.tool("icemail_get_mailbox",
    "Get one Icemail mailbox by id (read-only). Set include_credentials to also fetch its auth + app-password — treat that output as secret.",
    { id: z.string(), include_credentials: z.boolean().optional().describe("Default false") },
    async ({ id, include_credentials }) => {
      try {
        const mailbox = await ice.getMailbox({ id });
        if (!include_credentials) return ok(mailbox);
        const [auth, app_password] = await Promise.all([
          ice.getMailboxAuth({ id }).catch(e => ({ error: String(e).slice(0, 120) })),
          ice.getMailboxAppPassword({ id }).catch(e => ({ error: String(e).slice(0, 120) })),
        ]);
        return ok({ mailbox, auth, app_password });
      } catch (e) { return err(e); }
    }
  );

  server.tool("icemail_account",
    "Icemail account-level reads: workspaces, wallet balance, mailbox pricing, prewarm status, domain/mailbox tags, nameserver records, or webhooks. A balance or price read is not a spend.",
    { view: z.enum(["workspaces", "wallet", "mailbox_price", "prewarm", "domain_tags", "mailbox_tags", "ns_records", "webhooks"]) },
    async ({ view }) => {
      try {
        const fn = { workspaces: ice.listWorkspaces, wallet: ice.getWallet, mailbox_price: ice.mailboxPrice,
                     prewarm: ice.listPrewarm, domain_tags: ice.listDomainTags, mailbox_tags: ice.listMailboxTags,
                     ns_records: ice.getDomainNsRecords, webhooks: ice.listWebhooks }[view];
        return ok(await fn({}));
      } catch (e) { return err(e); }
    }
  );

  registerAgents(server);
  return real;
}
