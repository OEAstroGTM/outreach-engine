#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENTS = JSON.parse(readFileSync(join(__dirname, "../clients.json"), "utf8"));

const EB_SEND_BASE     = "https://send.outreachenginedashboard.co/api";
const EB_PERSONAL_BASE = "https://personal.outreachenginedashboard.co/api";
const EB_SEND_KEY      = process.env.EMAILBISON_SEND_API_KEY;
const EB_PERSONAL_KEY  = process.env.EMAILBISON_PERSONAL_API_KEY;
const MI_BASE          = "https://api.masterinbox.com";

const MI_KEYS = {
  "AskTuring":              process.env.MI_KEY_ASKTURING,
  "Braintracks":            process.env.MI_KEY_BRAINTRACKS,
  "Bravura Technologies":   process.env.MI_KEY_BRAVURA_TECHNOLOGIES,
  "Chalktalk":              process.env.MI_KEY_CHALKTALK,
  "Coffee & Contracts":     process.env.MI_KEY_COFFEE_AND_CONTRACTS,
  "Dream It Reel":          process.env.MI_KEY_DREAM_IT_REEL,
  "Hubengage":              process.env.MI_KEY_HUBENGAGE,
  "Intellectible":          process.env.MI_KEY_INTELLECTIBLE,
  "Lend Home Improvements": process.env.MI_KEY_LEND_HOME_IMPROVEMENTS,
  "Nuvo Bath":              process.env.MI_KEY_NUVO_BATH,
  "OR Trax":                process.env.MI_KEY_OR_TRAX,
  "Outreach Engine":        process.env.MI_KEY_OUTREACH_ENGINE,
  "ParGo":                  process.env.MI_KEY_PARGO,
  "Savanti Travel":         process.env.MI_KEY_SAVANTI_TRAVEL,
  "Simplexity":             process.env.MI_KEY_SIMPLEXITY,
  "Supply Wisdom":          process.env.MI_KEY_SUPPLY_WISDOM,
  "True Dial":              process.env.MI_KEY_TRUE_DIAL,
  "Westlink":               process.env.MI_KEY_WESTLINK,
  "Carengen":               process.env.MI_KEY_CARENGEN,
  "Clinintell":             process.env.MI_KEY_CLININTELL,
};

const INSTANTLY_KEYS = {
  simplexity:     process.env.INSTANTLY_SUPPLY_WISDOM_API_KEY, // placeholder
  supply_wisdom:  process.env.INSTANTLY_SUPPLY_WISDOM_API_KEY,
  lend_home:      process.env.INSTANTLY_LEND_HOME_API_KEY,
  surety_now:     process.env.INSTANTLY_SURETY_NOW_API_KEY,
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getClient(name) {
  const c = CLIENTS.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!c) throw new Error(`Unknown client: "${name}". Available: ${CLIENTS.map(c=>c.name).join(", ")}`);
  return { ...c, mi_pk: MI_KEYS[c.name] };
}

function ebConfig(client) {
  const isPersonal = client.sequencer === "eb_personal";
  return {
    base: isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE,
    key:  isPersonal ? EB_PERSONAL_KEY  : EB_SEND_KEY,
    ws_id: client.eb_ws_id,
  };
}

async function ebFetch(method, path, client, body) {
  const { base, key, ws_id } = ebConfig(client);
  // Switch workspace first
  await fetch(`${base}/workspaces/v1.1/switch-workspace`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ team_id: ws_id }),
  });
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function miFetch(method, path, client, body) {
  const key = client.mi_pk;
  if (!key) throw new Error(`No MI API key for ${client.name}`);
  const res = await fetch(`${MI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "outreach-engine", version: "1.0.0" });

// ─── Client tools ─────────────────────────────────────────────────────────────
server.tool("list_clients",
  "List all 21 Outreach Engine clients with their sequencer platform, workspace IDs, and MasterInbox config.",
  {},
  async () => ({
    content: [{ type: "text", text: JSON.stringify(
      CLIENTS.map(c => ({
        name: c.name,
        sequencer: c.sequencer,
        eb_ws_id: c.eb_ws_id ?? null,
        mi_ws_id: c.mi_ws_id ?? null,
        has_mi_key: !!MI_KEYS[c.name],
        inboxing_tags: c.inboxing_tags,
      })), null, 2
    )}]
  })
);

server.tool("get_client",
  "Get full config for a specific client by name.",
  { client_name: z.string().describe("Client name, e.g. 'AskTuring'") },
  async ({ client_name }) => {
    const c = getClient(client_name);
    return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
  }
);

// ─── Campaign tools ───────────────────────────────────────────────────────────
server.tool("list_campaigns",
  "List all campaigns for a client. Routes automatically to the correct EmailBison or Instantly workspace.",
  { client_name: z.string() },
  async ({ client_name }) => {
    const client = getClient(client_name);
    if (client.sequencer === "instantly") {
      const key = INSTANTLY_KEYS[client.instantly_ws];
      const res = await fetch(`https://api.instantly.ai/api/v1/campaign/list?api_key=${key}`);
      return { content: [{ type: "text", text: JSON.stringify(await res.json(), null, 2) }] };
    }
    const data = await ebFetch("GET", "/campaigns", client);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("get_campaign_stats",
  "Get open/reply/bounce stats for a campaign.",
  {
    client_name:  z.string(),
    campaign_id:  z.string(),
  },
  async ({ client_name, campaign_id }) => {
    const client = getClient(client_name);
    const data = await ebFetch("GET", `/campaigns/${campaign_id}/stats`, client);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("create_campaign",
  "Create a new outreach campaign for a client.",
  {
    client_name: z.string(),
    name:        z.string().describe("Campaign name"),
    subject:     z.string().describe("Email subject line"),
    body:        z.string().describe("Email body (plain text or HTML)"),
  },
  async ({ client_name, name, subject, body }) => {
    const client = getClient(client_name);
    const data = await ebFetch("POST", "/campaigns", client, { name, subject, body });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("launch_campaign",
  "Launch or resume a campaign so emails start sending.",
  { client_name: z.string(), campaign_id: z.string() },
  async ({ client_name, campaign_id }) => {
    const client = getClient(client_name);
    const data = await ebFetch("POST", `/campaigns/${campaign_id}/launch`, client);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("pause_campaign",
  "Pause an active campaign.",
  { client_name: z.string(), campaign_id: z.string() },
  async ({ client_name, campaign_id }) => {
    const client = getClient(client_name);
    const data = await ebFetch("POST", `/campaigns/${campaign_id}/pause`, client);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// ─── Inbox tools (MasterInbox, per-workspace key) ─────────────────────────────
server.tool("list_replies",
  "List recent email replies for a client from MasterInbox.",
  {
    client_name: z.string(),
    limit:       z.number().optional().default(20),
    label:       z.string().optional().describe("Filter by label, e.g. 'interested'"),
  },
  async ({ client_name, limit, label }) => {
    const client = getClient(client_name);
    const body = { page: 1, limit };
    if (label) body.label = label;
    const data = await miFetch("POST", "/api/api-webhook/v1/api/get-threads", client, body);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("get_thread",
  "Get the full conversation thread for a specific reply in MasterInbox.",
  { client_name: z.string(), thread_id: z.string() },
  async ({ client_name, thread_id }) => {
    const client = getClient(client_name);
    const data = await miFetch("POST", "/api/api-webhook/v1/api/get-thread", client, { thread_id });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("tag_reply",
  "Tag a reply thread in MasterInbox with a label.",
  {
    client_name: z.string(),
    thread_id:   z.string(),
    label:       z.string().describe("Label to apply, e.g. 'interested', 'not_interested', 'follow_up'"),
  },
  async ({ client_name, thread_id, label }) => {
    const client = getClient(client_name);
    const data = await miFetch("POST", "/api/api-webhook/v1/api/update-thread", client, { thread_id, label });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool("get_interested_replies",
  "Get all interested replies across all clients or for a specific client.",
  { client_name: z.string().optional().describe("Filter to one client, or omit for all") },
  async ({ client_name }) => {
    const targets = client_name ? [getClient(client_name)] : CLIENTS.filter(c => c.mi_ws_id && MI_KEYS[c.name]);
    const results = [];
    for (const client of targets) {
      try {
        const c = { ...client, mi_pk: MI_KEYS[client.name] };
        const data = await miFetch("POST", "/api/api-webhook/v1/api/get-threads", c, { page: 1, limit: 50, label: "interested" });
        const threads = data?.data ?? [];
        if (threads.length) results.push({ client: client.name, threads });
      } catch (e) {
        results.push({ client: client.name, error: e.message });
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
