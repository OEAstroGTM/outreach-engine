// ── leadgen.js ───────────────────────────────────────────────────────────────
// Thin MCP client that proxies to the existing lead-gen MCP server (the one that
// already exposes namesilo_*, porkbun_*, and inboxing_* tools). The Infra agent
// reuses these rather than re-implementing registrar / mailbox APIs.
//
// Configure how to launch the lead-gen server via env:
//   LEADGEN_MCP_COMMAND   e.g. "npx"           (required to enable Infra agent)
//   LEADGEN_MCP_ARGS      JSON array, e.g. '["-y","@your/lead-gen-mcp"]'
//   INFRA_REGISTRAR       "namesilo" (default) | "porkbun"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const INFRA_REGISTRAR = (process.env.INFRA_REGISTRAR || "namesilo").toLowerCase();

let _client = null;
let _tools = null;

export function leadgenConfigured() {
  return !!process.env.LEADGEN_MCP_COMMAND;
}

async function connect() {
  if (_client) return _client;
  if (!leadgenConfigured()) {
    throw new Error(
      "Lead-gen MCP not configured. Set LEADGEN_MCP_COMMAND (and LEADGEN_MCP_ARGS) " +
      "in .env so the Infra agent can reach namesilo/porkbun/inboxing tools."
    );
  }
  let args = [];
  try { args = JSON.parse(process.env.LEADGEN_MCP_ARGS || "[]"); }
  catch { throw new Error("LEADGEN_MCP_ARGS must be a JSON array, e.g. '[\"-y\",\"@your/pkg\"]'"); }

  const transport = new StdioClientTransport({
    command: process.env.LEADGEN_MCP_COMMAND,
    args,
    env: process.env,
  });
  _client = new Client({ name: "outreach-engine-infra-proxy", version: "1.0.0" });
  await _client.connect(transport);
  return _client;
}

// Which lead-gen tools to surface to the Infra agent. Registrar is selectable;
// inboxing (aerosend) tools are always included.
function infraToolFilter(name) {
  const registrarPrefix = INFRA_REGISTRAR === "porkbun" ? "porkbun_" : "namesilo_";
  return name.startsWith(registrarPrefix) || name.startsWith("inboxing_");
}

export async function listInfraTools() {
  if (_tools) return _tools;
  const client = await connect();
  const { tools } = await client.listTools();
  _tools = tools
    .filter(t => infraToolFilter(t.name))
    .map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  return _tools;
}

export async function callInfraTool(name, args) {
  const client = await connect();
  const res = await client.callTool({ name, arguments: args || {} });
  // Normalize to plain text for the agent loop.
  if (Array.isArray(res?.content)) {
    return res.content.map(c => (c.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  }
  return JSON.stringify(res);
}
