// ── agents.js ────────────────────────────────────────────────────────────────
// The operator-facing agents. Each is a delegating sub-agent: the operator gives
// it a goal, it runs its own tool-use loop, and returns a result. Registered as
// run_<name>_agent MCP tools on the server.
import { z } from "zod";
import * as ops from "./lib/tools.js";
import { runAgent } from "./lib/agent.js";
import { listInfraTools, callInfraTool, leadgenConfigured, INFRA_REGISTRAR } from "./lib/leadgen.js";

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

// ── Infra / Provisioning agent (proxies the lead-gen MCP) ────────────────────
// Tools are discovered at run time from the configured lead-gen MCP server.
async function buildInfraAgent() {
  const infraTools = await listInfraTools();
  return {
    name: "infra",
    systemPrompt:
      "You are the Infra agent for Outreach Engine. You buy and provision cold-email sending " +
      `infrastructure using the ${INFRA_REGISTRAR} registrar + Inboxing (aerosend). Standard flow: ` +
      "1) check domain variation availability; 2) confirm picks and funds before registering; " +
      "3) register throwaway lookalike domains (default .digital); 4) provision each on Inboxing " +
      "at 49 mailboxes with the client's tag; 5) when a domain reaches UPDATE_NAMESERVERS, point " +
      "the registrar nameservers to the assigned Cloudflare pair PROMPTLY (missing the window " +
      "fails with 'Nameserver update not detected'); 6) verify at the registrar and let it " +
      "propagate to active. 1 domain = 1 Inboxing slot. Do not renew .digital throwaways. Never " +
      "register domains without an explicit go. Report exactly what you bought and provisioned.",
    tools: infraTools.map(t => tool(t.name, t.description, t.input_schema,
      (args) => callInfraTool(t.name, args))),
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
  registerAgentTool(server, "research", researchAgent,
    "Delegate a lead-research goal (find/enrich/build target lists via Apollo).");
  registerAgentTool(server, "campaign", campaignAgent,
    "Delegate a campaign goal (create/launch/pause/monitor, push leads).");
  registerAgentTool(server, "inbox", inboxAgent,
    "Delegate an inbox goal (triage/read/tag replies in MasterInbox).");
  registerAgentTool(server, "infra", buildInfraAgent,
    "Delegate an infra goal (buy domains + provision Inboxing mailboxes)." +
    (leadgenConfigured() ? "" : " [requires LEADGEN_MCP_COMMAND in .env]"));
}
