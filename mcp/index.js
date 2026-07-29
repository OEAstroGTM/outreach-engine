#!/usr/bin/env node
// ── Outreach Engine MCP ──────────────────────────────────────────────────────
// Operator surface = a small collection of delegating agents plus two read
// helpers. Each agent (research, campaign, inbox, infra) takes a natural-language
// goal and runs its own tool-use loop. Business logic lives in lib/tools.js;
// agent definitions in agents.js; the runner in lib/agent.js.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "dotenv/config";

import { CLIENTS, ok, err } from "./lib/core.js";
import * as ops from "./lib/tools.js";
import { registerAgents } from "./agents.js";

const server = new McpServer({ name: "outreach-engine", version: "2.0.0" });

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

// ── Delegating agents: run_research_agent, run_campaign_agent,
//    run_inbox_agent, run_infra_agent ──────────────────────────────────────────
registerAgents(server);

// ── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
