# Team remote MCP

The hosted endpoint is `https://<your Railway domain>/mcp`. It uses stateless MCP Streamable HTTP. The local `node mcp/index.js` stdio server remains available separately.

## Authentication and permissions

The HTTP service is an OAuth resource server. An external team identity provider handles sign-in and issues short-lived JWT access tokens. The server verifies the JWT signature against the provider's JWKS, exact issuer, exact audience, expiration, and subject on every request. It then intersects token scopes with the explicit server-side subject policy. Users absent from the policy cannot connect. No shared MCP bearer secret is supported.

| Scope | Remote tools | Access |
| --- | --- | --- |
| `clients:read` | `list_clients`, `get_client` | Client routing metadata only; `get_client` omits keys and raw config. |
| `research:run` | `run_research_agent` | Apollo research and credit-consuming contact pulls. |
| `inbox:run` | `run_inbox_agent` | Reply reading and labeling. |
| `campaign:run` | `run_campaign_agent` | Campaign creation, lead pushes, launch, and pause. |

`run_infra_agent` and `run_orchestrator_agent` are never exposed by HTTP. The orchestrator can dispatch to infra, so it cannot safely be granted as a shortcut. No remote tool can register a domain. The remote endpoint does not load registrar keys as an access requirement; do not configure them for this service.

The scopes above are access boundaries for whole specialist agents. In particular, `campaign:run` includes launch and `research:run` can spend Apollo credits. Grant them only to operators who need those capabilities. All authorized users can see all clients available to the service; client-specific isolation is not implemented.

## Owner setup

1. Use a team-owned Railway service connected to `OEAstroGTM/outreach-engine` on the `main` branch, with the repository root as its source directory. Railway detects the root `Dockerfile` automatically. Railway no longer enables legacy `railway.json` Config as Code on new services. Merge the MCP code, then set the service healthcheck path to `/health` in Railway's Deploy settings. The MCP process fails closed until its authentication variables are configured.
2. Once the MCP image is deployed, generate a Railway HTTPS service domain. Configure an OAuth 2.1 provider that supports MCP clients, OAuth discovery, PKCE, and Client ID Metadata Documents or dynamic client registration. Register the exact MCP URL as the API audience/resource. Configure JWT access tokens with the scopes above. Restrict sign-in to the team in the provider and issue refresh tokens for clients that need durable connections.
3. Set these Railway variables and redeploy:

   ```text
   MCP_RESOURCE_URL=https://<your Railway domain>/mcp
   MCP_AUTH_ISSUER=https://<your identity provider issuer>/
   MCP_AUTH_JWKS_URL=https://<your identity provider>/.../jwks.json
   MCP_TEAM_POLICY_JSON={"<stable-subject-id>":["clients:read"],"<operator-subject-id>":["clients:read","inbox:run"]}
   ```

   The policy keys are OAuth `sub` values, not display names. Add each team member explicitly. The JWT must contain `aud` equal to `MCP_RESOURCE_URL` and a space-delimited `scope` claim (or an `scp` array). Both the token and policy must grant a scope. The service refuses to start with missing or malformed configuration. `MCP_ALLOWED_ORIGINS` is optional if a browser-based client sends an `Origin` header; list only trusted HTTPS origins separated by commas.
4. For specialist agents, add `ANTHROPIC_API_KEY` and only the provider credentials needed for the scopes granted. `COCKPIT_URL` and a narrowly scoped `COCKPIT_API_KEY` can supply provider keys through Cockpit. Keep every credential in Railway variables or the identity provider, never in GitHub, connector URLs, screenshots, or chat.
5. Deploy and confirm `GET /health` returns `{"ok":true}`, protected-resource metadata is available at `GET /.well-known/oauth-protected-resource/mcp`, and an unauthenticated `POST /mcp` returns `401` with a `WWW-Authenticate` discovery link. Then sign in as a read-only member and confirm only the two client tools appear. Test a separately authorized operator before granting specialist scopes to the rest of the team.
6. A Claude Team or Enterprise owner can add a custom web connector using the MCP URL, select OAuth sign-in, and make it available to members. Members connect with their own accounts. A ChatGPT Business or Enterprise/Edu admin can create and publish the custom MCP connection and configure workspace access. Refresh the tool catalog after changing the server's advertised tools.

## Local validation

From `mcp/`, run `npm ci` and `npm test`. The integration test connects with the official MCP Streamable HTTP client and verifies token rejection, per-user tool discovery, and redaction. It uses generated test keys and no live provider calls.
