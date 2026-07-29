// ── agents.js ────────────────────────────────────────────────────────────────
// The operator-facing agents. Each is a delegating sub-agent: the operator gives
// it a goal, it runs its own tool-use loop, and returns a result. Registered as
// run_<name>_agent MCP tools on the server.
import { z } from "zod";
import * as ops from "./lib/tools.js";
import * as infra from "./lib/infra.js";
import { runAgent } from "./lib/agent.js";

// Small helper to declare a tool the agent can call.
const tool = (name, description, input_schema, handler) => ({ name, description, input_schema, handler });
const obj = (properties, required = []) => ({ type: "object", properties, required });
const S = { str: { type: "string" }, num: { type: "number" }, bool: { type: "boolean" },
            arrStr: { type: "array", items: { type: "string" } } };

const list_clients_tool = tool(
  "list_clients",
  "List all Outreach Engine clients with sequencer, workspace IDs, and MasterInbox config.",
  obj({}), async () => ops.listClients()
);

// ── Research agent ───────────────────────────────────────────────────────────
const researchAgent = {
  name: "research",
  systemPrompt:
    "You are the Research agent for Outreach Engine. You find and enrich companies and " +
    "people via Apollo to build target lists for a client's outbound. Validate ICP filters " +
    "with search_people (check total_found) BEFORE bulk_pull_contacts, which spends credits. " +
    "Prefer has_email results. Return a concise summary plus the structured list you built.",
  tools: [
    list_clients_tool,
    tool("find_company", "Search Apollo for a company by name or domain.",
      obj({ company_name: S.str, domain: S.str }, ["company_name"]), ops.findCompany),
    tool("enrich_contact", "Enrich a person in Apollo (verified email, LinkedIn, title).",
      obj({ first_name: S.str, last_name: S.str, company: S.str, domain: S.str, linkedin_url: S.str, reveal_personal_emails: S.bool }, ["first_name", "last_name", "company"]),
      ops.enrichContact),
    tool("search_people", "Search Apollo people with ICP filters (one page + pagination).",
      obj({ titles: S.arrStr, seniority_levels: S.arrStr, departments: S.arrStr, keywords: S.str, industries: S.arrStr, employee_count_ranges: S.arrStr, locations: S.arrStr, company_names: S.arrStr, has_email: S.bool, page: S.num, per_page: S.num }),
      ops.searchPeople),
    tool("bulk_pull_contacts", "Auto-paginate Apollo to pull a capped list of contacts. Spends credits.",
      obj({ titles: S.arrStr, seniority_levels: S.arrStr, departments: S.arrStr, keywords: S.str, industries: S.arrStr, employee_count_ranges: S.arrStr, locations: S.arrStr, company_names: S.arrStr, has_email_only: S.bool, max_results: S.num, start_page: S.num }),
      ops.bulkPullContacts),
  ],
};

// ── Campaign agent ───────────────────────────────────────────────────────────
const campaignAgent = {
  name: "campaign",
  systemPrompt:
    "You are the Campaign agent for Outreach Engine. You create, launch, pause, and monitor " +
    "outbound campaigns and push leads, routing automatically to the client's sequencer " +
    "(EmailBison send/personal or Instantly). Always resolve the client first. Confirm the " +
    "campaign_id via list_campaigns before mutating. Report what you changed and current stats.",
  tools: [
    list_clients_tool,
    tool("list_campaigns", "List a client's campaigns (routes to EmailBison or Instantly).",
      obj({ client_name: S.str }, ["client_name"]), ops.listCampaigns),
    tool("get_campaign_stats", "Get open/reply/bounce stats for a campaign.",
      obj({ client_name: S.str, campaign_id: S.str }, ["client_name", "campaign_id"]), ops.getCampaignStats),
    tool("create_campaign", "Create a new campaign for a client.",
      obj({ client_name: S.str, name: S.str, subject: S.str, body: S.str }, ["client_name", "name", "subject", "body"]), ops.createCampaign),
    tool("launch_campaign", "Launch or resume a campaign.",
      obj({ client_name: S.str, campaign_id: S.str }, ["client_name", "campaign_id"]), ops.launchCampaign),
    tool("pause_campaign", "Pause an active campaign.",
      obj({ client_name: S.str, campaign_id: S.str }, ["client_name", "campaign_id"]), ops.pauseCampaign),
    tool("bulk_push_to_campaign", "Create contacts as leads and attach them to a campaign in one pass.",
      obj({ client_name: S.str, campaign_id: S.str, contacts: { type: "array", items: obj({ email: S.str, first_name: S.str, last_name: S.str, company: S.str, title: S.str, website: S.str }, ["email"]) } }, ["client_name", "campaign_id", "contacts"]),
      ops.bulkPushToCampaign),
  ],
};

// ── Inbox / Reply agent ──────────────────────────────────────────────────────
const inboxAgent = {
  name: "inbox",
  systemPrompt:
    "You are the Inbox agent for Outreach Engine. You triage replies in MasterInbox: list " +
    "recent/interested replies, read threads, and tag them. Resolve the client first. When " +
    "asked for interested replies across the book, use get_interested_replies with no client. " +
    "Summarize what matters; do not send outbound mail from here.",
  tools: [
    list_clients_tool,
    tool("list_replies", "List recent replies for a client (optionally by label).",
      obj({ client_name: S.str, limit: S.num, label: S.str }, ["client_name"]), ops.listReplies),
    tool("get_thread", "Get the full conversation thread for a reply.",
      obj({ client_name: S.str, thread_id: S.str }, ["client_name", "thread_id"]), ops.getThread),
    tool("tag_reply", "Tag a reply thread with a label (e.g. interested, not_interested, follow_up).",
      obj({ client_name: S.str, thread_id: S.str, label: S.str }, ["client_name", "thread_id", "label"]), ops.tagReply),
    tool("get_interested_replies", "Get interested replies for one client, or all clients if omitted.",
      obj({ client_name: S.str }), ops.getInterestedReplies),
  ],
};

// ── Infra / Provisioning agent (self-sufficient — native registrar + Inboxing) ─
const nameObj = { type: "object", properties: { first_name: S.str, last_name: S.str } };
const infraAgent = {
  name: "infra",
  systemPrompt:
    "You are the Infra agent for Outreach Engine. You buy and provision cold-email sending " +
    `infrastructure directly via the ${infra.INFRA_REGISTRAR} registrar + Inboxing. Standard flow: ` +
    "1) check_domain_availability on variations; 2) confirm picks and check get_registrar_balance " +
    "before registering; 3) register_domain for throwaway lookalike domains (default .digital); " +
    "4) inboxing_submit_domain for each at 49 mailboxes with the client's tag and 49 sender names; " +
    "5) when inboxing_check_status shows UPDATE_NAMESERVERS, call update_nameservers to point the " +
    "registrar NS to the assigned Cloudflare pair PROMPTLY (missing the window fails with " +
    "'Nameserver update not detected'); 6) verify with get_domain and let it propagate to active. " +
    "1 domain = 1 Inboxing slot. Do not renew .digital throwaways. NEVER register domains without " +
    "an explicit go. Report exactly what you bought and provisioned.",
  tools: [
    tool("check_domain_availability", "Check if domains are available + pricing (via the configured registrar).",
      obj({ domains: S.arrStr }, ["domains"]), infra.checkAvailability),
    tool("get_registrar_balance", "Get the registrar account balance before spending.",
      obj({}), infra.getRegistrarBalance),
    tool("register_domain", "Register a domain via the configured registrar (spends funds).",
      obj({ domain: S.str, years: S.num }, ["domain"]), infra.registerDomain),
    tool("update_nameservers", "Point a domain's registrar nameservers to the given pair.",
      obj({ domain: S.str, nameservers: S.arrStr }, ["domain", "nameservers"]), infra.updateNameservers),
    tool("get_domain", "Get a domain's registrar status + current nameservers.",
      obj({ domain: S.str }, ["domain"]), infra.getDomain),
    tool("inboxing_submit_domain", "Provision mailboxes for a domain on Inboxing (user_count 25/49/99).",
      obj({ domain: S.str, user_count: S.num, tags: S.arrStr, names: { type: "array", items: nameObj } }, ["domain"]),
      infra.inboxingSubmitDomain),
    tool("inboxing_check_status", "Check an Inboxing domain job's status (pass the domain job id).",
      obj({ domain_id: S.str }, ["domain_id"]), infra.inboxingCheckStatus),
    tool("inboxing_list_domains", "List domains/jobs on Inboxing.", obj({}), infra.inboxingListDomains),
    tool("inboxing_get_slots", "Check available Inboxing mailbox/domain slots.", obj({}), infra.inboxingGetSlots),
    tool("inboxing_download_csv", "Download the mailbox credentials CSV for a domain once it's active.",
      obj({ domain_id: S.str }, ["domain_id"]), infra.inboxingDownloadCsv),
  ],
};

// ── Orchestrator agent ───────────────────────────────────────────────────────
// Takes a rough / underspecified operator prompt, resolves context, rewrites it
// into a precise goal, and dispatches to the right specialist. Its "tools" are
// the other agents — it never does the work itself.
const SPECIALISTS = {
  research: researchAgent,
  campaign: campaignAgent,
  inbox: inboxAgent,
  infra: infraAgent,
};

async function resolveSpecialist(name) {
  const a = SPECIALISTS[name];
  if (!a) throw new Error(`Unknown specialist: ${name}`);
  return typeof a === "function" ? await a() : a;
}

function dispatchTool(name, blurb) {
  return tool(
    `dispatch_to_${name}`,
    `${blurb} Pass a fully-specified, well-scoped goal: resolve the client, be explicit about ` +
    `targets/filters/IDs/constraints. The specialist runs its own loop and returns its result.`,
    obj({ goal: S.str, context: S.str }, ["goal"]),
    async ({ goal, context }) => runAgent(await resolveSpecialist(name), goal, { context })
  );
}

function buildOrchestratorAgent() {
  return {
    name: "orchestrator",
    systemPrompt:
      "You are the Orchestrator for Outreach Engine. Operators often hand you vague, " +
      "underspecified, or sloppy requests. Your ONLY job is to turn a rough request into the " +
      "right, precisely-scoped work — never to do the work yourself.\n\n" +
      "For every request:\n" +
      "1. Infer intent and target domain: research (find/enrich leads), campaign " +
      "(create/launch/monitor/push leads), inbox (triage/tag replies), or infra (buy domains + " +
      "provision mailboxes).\n" +
      "2. Resolve context FIRST — use list_clients / get_client to pin the exact client and its " +
      "routing whenever the request names or implies one.\n" +
      "3. Rewrite the request into a clear, complete goal for the specialist: explicit client, " +
      "concrete targets/filters/IDs, and constraints. This is the pre-audit — state the refined " +
      "goal you are about to dispatch.\n" +
      "4. Dispatch to exactly the right specialist via dispatch_to_<agent>. Chain multiple only " +
      "when the request truly spans domains (e.g. research then campaign).\n" +
      "5. Return a short summary: which agent(s) you routed to, the refined goal you sent, and " +
      "the specialist's result.\n\n" +
      "Guardrails: if the request is too ambiguous to route safely, or would trigger an " +
      "irreversible / money-spending action (registering domains, launching a campaign, sending " +
      "mail) without a clear go, DO NOT dispatch — ask one focused clarifying question instead.",
    tools: [
      list_clients_tool,
      tool("get_client", "Get a client's full routing config to resolve context before dispatching.",
        obj({ client_name: S.str }, ["client_name"]), ops.getClientInfo),
      dispatchTool("research", "Dispatch a lead-research goal to the Research agent."),
      dispatchTool("campaign", "Dispatch a campaign goal to the Campaign agent."),
      dispatchTool("inbox", "Dispatch an inbox/reply goal to the Inbox agent."),
      dispatchTool("infra", "Dispatch a domain/mailbox provisioning goal to the Infra agent."),
    ],
  };
}

// ── Registration ─────────────────────────────────────────────────────────────
const AGENT_INPUT = {
  goal: z.string().describe("What you want the agent to accomplish, in plain language."),
  context: z.string().optional().describe("Optional extra context (client, constraints, IDs)."),
};

function registerAgentTool(server, agentName, agentOrFactory, blurb) {
  server.tool(`run_${agentName}_agent`, blurb, AGENT_INPUT, async ({ goal, context }) => {
    try {
      const agent = typeof agentOrFactory === "function" ? await agentOrFactory() : agentOrFactory;
      const result = await runAgent(agent, goal, { context });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });
}

export function registerAgents(server) {
  registerAgentTool(server, "orchestrator", buildOrchestratorAgent,
    "Give a rough/vague goal; the orchestrator resolves context, rewrites it into a precise " +
    "prompt, and dispatches to the right specialist agent(s). Start here when unsure.");
  registerAgentTool(server, "research", researchAgent,
    "Delegate a lead-research goal (find/enrich/build target lists via Apollo).");
  registerAgentTool(server, "campaign", campaignAgent,
    "Delegate a campaign goal (create/launch/pause/monitor, push leads).");
  registerAgentTool(server, "inbox", inboxAgent,
    "Delegate an inbox goal (triage/read/tag replies in MasterInbox).");
  registerAgentTool(server, "infra", infraAgent,
    `Delegate an infra goal (buy domains + provision Inboxing mailboxes; registrar: ${infra.INFRA_REGISTRAR}).`);
}
