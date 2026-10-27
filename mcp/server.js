import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CLIENTS, ok, err } from "./lib/core.js";
import * as ops from "./lib/tools.js";
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

  registerAgents(server);
  return real;
}
