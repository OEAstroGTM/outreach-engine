import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpServer } from "../http.js";
import { parseTeamPolicy, verifyAccessToken } from "../auth.js";

const issuer = "https://identity.example.test/";
const resourceUrl = "https://mcp.example.test/mcp";
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "ES256", use: "sig" };
const config = {
  issuer,
  resourceUrl,
  jwks: createLocalJWKSet({ keys: [jwk] }),
  policy: parseTeamPolicy(JSON.stringify({
    reader: ["clients:read"],
    researcher: ["clients:read", "research:run"],
  })),
  allowedOrigins: new Set(),
};

function token(subject, scope, audience = resourceUrl) {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: "ES256", kid: "test-key" })
    .setIssuer(issuer).setAudience(audience).setSubject(subject)
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
}

test("team policy rejects wildcard and unknown privileges", () => {
  assert.throws(() => parseTeamPolicy('{"*":["clients:read"]}'));
  assert.throws(() => parseTeamPolicy('{"reader":["infra:run"]}'));
});

test("JWT verification requires audience, membership, and both scope grants", async () => {
  await assert.rejects(verifyAccessToken(await token("reader", "clients:read", "https://wrong.test/mcp"), config));
  await assert.rejects(verifyAccessToken(await token("stranger", "clients:read"), config));
  await assert.rejects(verifyAccessToken(await token("reader", "research:run"), config));
  const identity = await verifyAccessToken(await token("reader", "clients:read research:run"), config);
  assert.deepEqual([...identity.allowedTools], ["list_clients", "get_client"]);
});

test("Streamable HTTP client sees only authorized tools and never receives client credentials", async () => {
  const server = createHttpServer(config);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const close = () => new Promise(resolve => server.close(resolve));
  let client;
  try {
    const unauth = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get("www-authenticate"), /oauth-protected-resource/);
    const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", endpoint));
    assert.equal((await metadata.json()).resource, resourceUrl);

    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${await token("reader", "clients:read research:run")}` } },
    });
    client = new Client({ name: "compatibility-test", version: "1.0.0" });
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.deepEqual(names, ["list_clients", "get_client"]);
    const result = await client.callTool({ name: "get_client", arguments: { client_name: "Outreach Engine" } });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.name, "Outreach Engine");
    assert.equal("mi_pk" in data, false);
    assert.equal("eb_send_key_env" in data, false);
    assert.equal(names.includes("run_infra_agent"), false);
    assert.equal(names.includes("run_orchestrator_agent"), false);
  } finally {
    if (client) await client.close();
    await close();
  }
});
