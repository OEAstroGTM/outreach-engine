import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";

export const TOOL_SCOPES = Object.freeze({
  list_clients: "clients:read",
  get_client: "clients:read",
  run_research_agent: "research:run",
  run_campaign_agent: "campaign:run",
  run_inbox_agent: "inbox:run",
});

const KNOWN_SCOPES = new Set(Object.values(TOOL_SCOPES));
const READ_TOOLS = new Set(Object.entries(TOOL_SCOPES)
  .filter(([, scope]) => scope === "clients:read")
  .map(([name]) => name));

export class AccessDeniedError extends Error {}

function tokenDigest(value, name) {
  if (!/^[a-f0-9]{64}$/i.test(value || "")) {
    throw new Error(`${name} must be a SHA-256 hex digest`);
  }
  return Buffer.from(value, "hex");
}

export function parseOperatorTokens(value) {
  if (!value) return [];
  const data = JSON.parse(value);
  if (!data || Array.isArray(data) || typeof data !== "object") {
    throw new Error("MCP_OPERATOR_TOKENS_JSON must map operator names to token hashes and scopes");
  }
  const operators = [];
  const seen = new Set();
  for (const [subject, entry] of Object.entries(data)) {
    const scopes = entry?.scopes;
    if (!subject || subject === "*" || !entry || Array.isArray(entry) ||
        !Array.isArray(scopes) || !scopes.length || scopes.some(scope => !KNOWN_SCOPES.has(scope))) {
      throw new Error(`Invalid MCP_OPERATOR_TOKENS_JSON entry for ${subject || "empty subject"}`);
    }
    const digest = tokenDigest(entry.sha256, `MCP_OPERATOR_TOKENS_JSON entry for ${subject}`);
    const hex = digest.toString("hex");
    if (seen.has(hex)) throw new Error("MCP_OPERATOR_TOKENS_JSON contains a duplicate token hash");
    seen.add(hex);
    operators.push({
      subject,
      digest,
      allowedTools: new Set(Object.entries(TOOL_SCOPES)
        .filter(([, scope]) => scopes.includes(scope))
        .map(([name]) => name)),
    });
  }
  return operators;
}

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
  const resourceUrl = httpsUrl(env.MCP_RESOURCE_URL, "MCP_RESOURCE_URL").toString();
  if (new URL(resourceUrl).pathname !== "/mcp") {
    throw new Error("MCP_RESOURCE_URL must end in /mcp");
  }
  const oauthValues = [env.MCP_AUTH_ISSUER, env.MCP_AUTH_JWKS_URL, env.MCP_TEAM_POLICY_JSON];
  if (oauthValues.some(Boolean) && !oauthValues.every(Boolean)) {
    throw new Error("OAuth requires MCP_AUTH_ISSUER, MCP_AUTH_JWKS_URL, and MCP_TEAM_POLICY_JSON together");
  }
  const oauth = oauthValues.every(Boolean);
  const issuer = oauth ? httpsUrl(env.MCP_AUTH_ISSUER, "MCP_AUTH_ISSUER").toString() : null;
  const jwksUrl = oauth ? httpsUrl(env.MCP_AUTH_JWKS_URL, "MCP_AUTH_JWKS_URL") : null;
  const sharedReadDigest = env.MCP_TEAM_READ_TOKEN_SHA256
    ? tokenDigest(env.MCP_TEAM_READ_TOKEN_SHA256, "MCP_TEAM_READ_TOKEN_SHA256") : null;
  const operators = parseOperatorTokens(env.MCP_OPERATOR_TOKENS_JSON);
  if (sharedReadDigest && operators.some(operator => timingSafeEqual(operator.digest, sharedReadDigest))) {
    throw new Error("Shared read token must differ from operator tokens");
  }
  if (!oauth && !sharedReadDigest && !operators.length) {
    throw new Error("Configure OAuth or at least one team token");
  }
  return {
    issuer,
    resourceUrl,
    jwks: oauth ? createRemoteJWKSet(jwksUrl) : null,
    policy: oauth ? parseTeamPolicy(env.MCP_TEAM_POLICY_JSON) : null,
    sharedReadDigest,
    operators,
    allowedOrigins: new Set((env.MCP_ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean)),
  };
}

export async function verifyBearerToken(token, config) {
  const digest = createHash("sha256").update(token).digest();
  if (config.sharedReadDigest && timingSafeEqual(digest, config.sharedReadDigest)) {
    return { subject: "shared-reader", allowedTools: new Set(READ_TOOLS) };
  }
  for (const operator of config.operators || []) {
    if (timingSafeEqual(digest, operator.digest)) {
      return { subject: operator.subject, allowedTools: operator.allowedTools };
    }
  }
  if (!config.jwks) throw new Error("Invalid bearer token");
  return verifyAccessToken(token, config);
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
