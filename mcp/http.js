#!/usr/bin/env node
import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadAuthConfig, verifyAccessToken } from "./auth.js";
import { buildServer } from "./server.js";

const MAX_BODY_BYTES = 1_000_000;

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    const error = new Error("Content-Type must be application/json");
    error.status = 415;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

export function createHttpServer(config) {
  const metadataPath = "/.well-known/oauth-protected-resource/mcp";
  const metadataUrl = new URL(metadataPath, config.resourceUrl).toString();
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;
  return http.createServer(async (req, res) => {
    const path = new URL(req.url || "/", config.resourceUrl).pathname;
    try {
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && (path === metadataPath || path === "/.well-known/oauth-protected-resource")) {
        return json(res, 200, {
          resource: config.resourceUrl,
          authorization_servers: [config.issuer],
          scopes_supported: ["clients:read", "research:run", "campaign:run", "inbox:run"],
        });
      }
      if (path !== "/mcp") return json(res, 404, { error: "not found" });

      const origin = req.headers.origin;
      if (origin && origin !== new URL(config.resourceUrl).origin && !config.allowedOrigins.has(origin)) {
        return json(res, 403, { error: "origin not allowed" });
      }
      const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/.exec(req.headers.authorization || "");
      if (!match) return json(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge });
      let identity;
      try { identity = await verifyAccessToken(match[1], config); }
      catch { return json(res, 401, { error: "unauthorized" }, { "www-authenticate": challenge }); }

      if (req.method !== "POST") {
        return json(res, 405, { error: "method not allowed" }, { allow: "POST" });
      }
      const body = await readJson(req);
      const server = buildServer({ allowedTools: identity.allowedTools, remote: true });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.once("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        json(res, error.status || 500, { error: error.status ? error.message : "internal error" });
      }
      if (!error.status) console.error("[mcp-http] request failed:", error?.name || "Error");
    }
  });
}

export function startHttpServer(env = process.env) {
  const config = loadAuthConfig(env);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
  return createHttpServer(config).listen(port, "0.0.0.0", () => {
    console.error(`Outreach Engine MCP listening on port ${port}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startHttpServer();
}
