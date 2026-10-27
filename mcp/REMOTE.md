# Team remote MCP

The hosted endpoint is https://<your Railway domain>/mcp. It uses stateless MCP Streamable HTTP. The local Node stdio server remains available separately.

## Authentication and permissions

For Claude Team, use one strong, random bearer token as a password-like shared credential. It grants only list_clients and get_client. Claude's organization connector stores the token as a fixed Authorization request header; everyone who enables that connector has the same read-only access. It does not identify individual users.

For Claude Code operators, use a different random token per person. MCP_OPERATOR_TOKENS_JSON assigns each token a named identity and explicit scopes. Never put an operator token in the shared Claude connector. The server stores only SHA-256 token hashes in Railway variables and compares them using constant-time checks. Use at least 32 random bytes per token; a short, memorable password is too easy to guess on a public endpoint.

| Scope | Remote tools | Access |
| --- | --- | --- |
| clients:read | list_clients, get_client | Client routing metadata only; get_client omits keys and raw config. |
| research:run | run_research_agent | Apollo research and credit-consuming contact pulls. |
| inbox:run | run_inbox_agent | Reply reading and labeling. |
| campaign:run | run_campaign_agent | Campaign creation, lead pushes, launch, and pause. |

run_infra_agent and run_orchestrator_agent are never exposed by HTTP. The orchestrator can dispatch to infra, so it cannot safely be granted as a shortcut. No remote tool can register a domain. Do not configure registrar keys for this service.

The specialist scopes cover whole agents. In particular, campaign:run includes launch and research:run can spend Apollo credits. Give them only to operators who need those actions. All authorized users can see all clients available to the service; client-specific isolation is not implemented.

An OAuth 2.1 issuer remains supported for per-user sign-in in Claude or ChatGPT. When enabled, the server verifies the JWT signature, exact issuer and resource audience, expiration, subject, and the intersection of token scopes with MCP_TEAM_POLICY_JSON. Users absent from that policy cannot connect. Configure all three OAuth variables together.

## Railway setup for Claude

1. Use a team-owned Railway service connected to OEAstroGTM/outreach-engine on main, with the repository root as its source directory. Railway detects the root Dockerfile automatically. New Railway services cannot enable legacy railway.json Config as Code. Merge the MCP code, then set the service healthcheck path to /health in Railway's Deploy settings. The MCP process fails closed until its authentication variables are configured.
2. Once the MCP image is deployed, generate a Railway HTTPS service domain. Set MCP_RESOURCE_URL=https://<your Railway domain>/mcp.
3. Generate a strong random token and its SHA-256 hash locally. Put the token in the team's secret manager and the hash in Railway as MCP_TEAM_READ_TOKEN_SHA256. Do not put the token in GitHub or chat. This shared token always grants read access only, regardless of operator settings.
4. For each Claude Code operator, generate a different token. Put only its hash and scopes in Railway. Example:

   MCP_OPERATOR_TOKENS_JSON={"yusra":{"sha256":"<64-hex-character-token-hash>","scopes":["clients:read","research:run"]}}

   Store each raw token privately for its operator. Leave this variable unset if no operators need specialist tools. Add ANTHROPIC_API_KEY and only the provider credentials needed for the scopes granted. COCKPIT_URL and a narrowly scoped COCKPIT_API_KEY can supply provider keys through Cockpit. Do not add registrar credentials.
5. Redeploy and confirm GET /health returns {"ok":true}, an unauthenticated POST /mcp returns 401, and a read-token MCP client sees only list_clients and get_client. Test each operator token's tool list before distributing it.
6. A Claude Team or Enterprise owner adds a custom web connector with the MCP URL, selects No sign in, and sets a fixed request header Authorization: Bearer <shared-read-token>. Members then enable the connector. Claude Code operators configure the same MCP URL with their own token in the Authorization header. Keep tokens out of shared source files and shell history.

MCP_ALLOWED_ORIGINS is optional if a browser-based client sends an Origin header; list only trusted HTTPS origins separated by commas.

## Optional OAuth setup

For individual Claude web or ChatGPT access, configure an OAuth 2.1 provider that supports MCP clients, discovery, PKCE, and Client ID Metadata Documents or dynamic client registration. Register the exact MCP URL as the API audience/resource. Configure JWT access tokens with the scopes above. Restrict sign-in to the team and issue refresh tokens for durable connections. Set these Railway variables:

   MCP_AUTH_ISSUER=https://<your identity provider issuer>/
   MCP_AUTH_JWKS_URL=https://<your identity provider>/.../jwks.json
   MCP_TEAM_POLICY_JSON={"<stable-subject-id>":["clients:read"],"<operator-subject-id>":["clients:read","inbox:run"]}

The policy keys are OAuth sub values. The JWT must contain aud equal to MCP_RESOURCE_URL and a space-delimited scope claim (or an scp array). Both the token and policy must grant a scope. When OAuth is configured, the server publishes protected-resource metadata for client discovery.

## Local validation

From mcp/, run npm ci and npm test. The integration tests connect with the official MCP Streamable HTTP client and verify both token and OAuth modes, per-user tool discovery, and credential redaction. They use generated test credentials and no live provider calls.
