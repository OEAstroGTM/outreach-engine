import { createRemoteJWKSet, jwtVerify } from "jose";

export const TOOL_SCOPES = Object.freeze({
  list_clients: "clients:read",
  get_client: "clients:read",
  run_research_agent: "research:run",
  run_campaign_agent: "campaign:run",
  run_inbox_agent: "inbox:run",
});

const KNOWN_SCOPES = new Set(Object.values(TOOL_SCOPES));

export class AccessDeniedError extends Error {}

function httpsUrl(value, name) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query, or fragment`);
  }
  return url;
}

export function parseTeamPolicy(value) {
  const data = JSON.parse(value);
  if (!data || Array.isArray(data) || typeof data !== "object" || !Object.keys(data).length) {
    throw new Error("MCP_TEAM_POLICY_JSON must map OAuth subject IDs to allowed scopes");
  }
  const policy = new Map();
  for (const [subject, scopes] of Object.entries(data)) {
    if (!subject || subject === "*" || !Array.isArray(scopes) || !scopes.length ||
        scopes.some(scope => !KNOWN_SCOPES.has(scope))) {
      throw new Error(`Invalid MCP_TEAM_POLICY_JSON entry for ${subject || "empty subject"}`);
    }
    policy.set(subject, new Set(scopes));
  }
  return policy;
}

export function loadAuthConfig(env = process.env) {
  const issuer = httpsUrl(env.MCP_AUTH_ISSUER, "MCP_AUTH_ISSUER").toString();
  const resourceUrl = httpsUrl(env.MCP_RESOURCE_URL, "MCP_RESOURCE_URL").toString();
  const jwksUrl = httpsUrl(env.MCP_AUTH_JWKS_URL, "MCP_AUTH_JWKS_URL");
  if (new URL(resourceUrl).pathname !== "/mcp") {
    throw new Error("MCP_RESOURCE_URL must end in /mcp");
  }
  return {
    issuer,
    resourceUrl,
    jwks: createRemoteJWKSet(jwksUrl),
    policy: parseTeamPolicy(env.MCP_TEAM_POLICY_JSON),
    allowedOrigins: new Set((env.MCP_ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean)),
  };
}

export async function verifyAccessToken(token, config) {
  const { payload } = await jwtVerify(token, config.jwks, {
    issuer: config.issuer,
    audience: config.resourceUrl,
    algorithms: ["RS256", "ES256", "EdDSA"],
    requiredClaims: ["sub", "exp"],
  });
  const policyScopes = config.policy.get(payload.sub);
  if (!policyScopes) throw new AccessDeniedError("Subject is not a team member");
  const granted = new Set([
    ...(typeof payload.scope === "string" ? payload.scope.split(/\s+/) : []),
    ...(Array.isArray(payload.scp) ? payload.scp : []),
  ]);
  const allowedTools = new Set(Object.entries(TOOL_SCOPES)
    .filter(([, scope]) => granted.has(scope) && policyScopes.has(scope))
    .map(([name]) => name));
  if (!allowedTools.size) throw new AccessDeniedError("No permitted MCP scope");
  return { subject: payload.sub, allowedTools };
}
