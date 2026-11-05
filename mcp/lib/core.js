// ── core.js ─────────────────────────────────────────────────────────────────
// Shared config, client resolution, and low-level fetch helpers. Single source
// of truth for API bases and keys; imported by tools.js, agents, and index.js.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the repo-root .env BEFORE reading any process.env below, regardless of
// the process's cwd (the MCP client may launch us from mcp/ or the repo root).
dotenv.config({ path: join(__dirname, "../../.env") });

// clients.json is the source of truth for client routing + which env var holds
// each client's keys.
export const CLIENTS = JSON.parse(
  readFileSync(join(__dirname, "../../clients.json"), "utf8")
);

// ── API bases ────────────────────────────────────────────────────────────────
export const APOLLO_BASE     = "https://api.apollo.io/api/v1";
export const EB_SEND_BASE     = "https://send.outreachenginedashboard.co/api";
export const EB_PERSONAL_BASE = "https://personal.outreachenginedashboard.co/api";
// MasterInbox routes all live under this prefix — the bare host 404s. The route
// names below are the ones the API actually serves (get-prospects/get-messages/
// add-prospect-label/get-labels), verified against the live API; the previous
// get-threads/get-thread/update-thread names did not exist and 404'd for every
// client, which made every MasterInbox tool silently useless.
export const MI_BASE          = "https://api.masterinbox.com";
export const APOLLO_THROTTLE_MS = 300;

// ── Cockpit secrets API ──────────────────────────────────────────────────────
// Cockpit's keychain is the place keys are managed now — notably, keys it
// creates itself (Add Client's live EmailBison workspace + token provisioning)
// never land in this repo's .env at all. Per docs/connecting-to-secrets-api.md:
// fetch once at startup, cache in memory, fall back to env vars, and never let
// a Cockpit outage take this process down.
const COCKPIT_URL     = process.env.COCKPIT_URL?.replace(/\/$/, "");
const COCKPIT_API_KEY = process.env.COCKPIT_API_KEY;

async function loadCockpitSecrets() {
  if (!COCKPIT_URL || !COCKPIT_API_KEY) return {};
  try {
    const headers = { "x-api-key": COCKPIT_API_KEY };
    // Vercel Deployment Protection sits in front of the app and answers with an
    // SSO page before Cockpit ever sees the request. This token lets automated
    // callers through without disabling protection for humans.
    if (process.env.COCKPIT_VERCEL_BYPASS) {
      headers["x-vercel-protection-bypass"] = process.env.COCKPIT_VERCEL_BYPASS;
      headers["x-vercel-set-bypass-cookie"] = "false";
    }
    const res = await fetch(`${COCKPIT_URL}/api/secrets`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const hint = res.status === 403 ? " (key has no secret_scopes — check /api-keys)"
                 : res.status === 401 ? " (key missing, invalid, or revoked)" : "";
      throw new Error(`HTTP ${res.status}${hint}`);
    }
    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      // A 200 carrying HTML means something in front of the app answered — on
      // Vercel that's Deployment Protection serving an SSO page. The API key is
      // irrelevant here; the request never reached Cockpit.
      throw new Error(
        `${COCKPIT_URL} returned HTML, not JSON — the request is being intercepted before it ` +
        `reaches Cockpit (on Vercel this is Deployment Protection on a preview deployment). ` +
        `Use the production URL, disable protection, or set a bypass token.`
      );
    }
    const { secrets } = JSON.parse(text);
    return secrets ?? {};
  } catch (e) {
    // stderr only — stdout is the MCP stdio channel and must stay clean.
    console.error(`[cockpit] /api/secrets failed, falling back to .env: ${e.message}`);
    return {};
  }
}

export const COCKPIT_SECRETS = await loadCockpitSecrets();

const slugify = n => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Cockpit keys its response by client_name; its own examples look slugified, so
// accept either rather than silently missing every lookup.
export function cockpitSecret(clientName, system) {
  const s = COCKPIT_SECRETS;
  if (!s) return undefined;
  return s[clientName]?.[system] ?? s[slugify(clientName)]?.[system] ?? undefined;
}

const globalSecret = system => COCKPIT_SECRETS?.__global__?.[system];

// ── Keys ───────────────────────────────────────────────────────────────────
export const APOLLO_KEY      = process.env.APOLLO_API_KEY;
export const EB_SEND_KEY     = globalSecret("emailbison_send_master")     ?? process.env.EMAILBISON_SEND_API_KEY;
export const EB_PERSONAL_KEY = globalSecret("emailbison_personal_master") ?? process.env.EMAILBISON_PERSONAL_API_KEY;

// Which store each account-level key actually came from, so key_source doesn't
// claim ".env" for something Cockpit supplied.
const MASTER_SOURCE = {
  send:     globalSecret("emailbison_send_master")     ? "cockpit:emailbison_send_master"     : "EMAILBISON_SEND_API_KEY",
  personal: globalSecret("emailbison_personal_master") ? "cockpit:emailbison_personal_master" : "EMAILBISON_PERSONAL_API_KEY",
};

// MasterInbox per-client public keys: Cockpit's keychain first, then the env
// var named in clients.json. New clients need no code change either way.
export const MI_KEYS = Object.fromEntries(
  CLIENTS
    .filter(c => c.mi_key_env || cockpitSecret(c.name, "masterinbox"))
    .map(c => [c.name, cockpitSecret(c.name, "masterinbox") ?? (c.mi_key_env ? process.env[c.mi_key_env] : undefined)])
);

export const INSTANTLY_KEYS = {
  simplexity:    process.env.INSTANTLY_SIMPLEXITY_API_KEY,
  supply_wisdom: process.env.INSTANTLY_SUPPLY_WISDOM_API_KEY,
  lend_home:     process.env.INSTANTLY_LEND_HOME_API_KEY,
  surety_now:    process.env.INSTANTLY_SURETY_NOW_API_KEY,
};

// ── Client resolution ────────────────────────────────────────────────────────
export function getClient(name) {
  const c = CLIENTS.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!c) throw new Error(`Unknown client: "${name}". Available: ${CLIENTS.map(c => c.name).join(", ")}`);
  return { ...c, mi_pk: MI_KEYS[c.name] };
}

// ── EmailBison instances ─────────────────────────────────────────────────────
// A client may be reachable on BOTH instances (send + personal), not just the
// one named by `sequencer`. `sequencer` is now only the DEFAULT instance — the
// one used when a caller does not name one explicitly.
//
// Workspace IDs are per-instance: eb_send_ws_id / eb_personal_ws_id. The legacy
// single `eb_ws_id` field is honoured ONLY for the client's default instance.
// It must never be reused across instances: workspace 5 on send and workspace 5
// on personal are different workspaces belonging to different clients, so
// falling back across instances would target the wrong one — exactly the class
// of silent mis-routing that ebSwitchWorkspace exists to prevent.
export const EB_INSTANCES = ["eb_send", "eb_personal"];

export function ebDefaultInstance(client) {
  return client.sequencer === "eb_personal" ? "eb_personal" : "eb_send";
}

// Which instances this client is actually configured for — a scoped key env or
// an explicit per-instance workspace id counts as configured. The default
// instance always counts, so existing single-instance clients are unchanged.
export function ebConfiguredInstances(client) {
  // A client whose sequencer is neither EmailBison instance (instantly, none)
  // uses no EmailBison workspace at all — reporting its default here would
  // imply an eb_send route that does not exist.
  const usesEb = client.sequencer === "eb_send" || client.sequencer === "eb_personal";
  const out = new Set(usesEb ? [ebDefaultInstance(client)] : []);
  if (client.eb_send_key_env || client.eb_send_ws_id != null) out.add("eb_send");
  if (client.eb_personal_key_env || client.eb_personal_ws_id != null) out.add("eb_personal");
  return [...out];
}

// Resolve the EmailBison credentials for a client on a given instance.
//
// Prefer the client's workspace-scoped token, named by clients.json in
// eb_send_key_env / eb_personal_key_env. Fall back to the account-level master
// key so clients that never had a scoped token keep working exactly as before.
//
// We carry the provenance (key_source, scoped, scoped_missing) so that when a
// call fails the error can say which key was used and why it was chosen —
// previously an auth failure gave no way to tell these cases apart.
export function ebConfig(client, instance) {
  const fallback = ebDefaultInstance(client);
  // A client whose sequencer is not an EmailBison instance (instantly, none) has
  // no EmailBison default. Requiring an explicit instance stops a call meant for
  // Instantly from silently resolving to eb_send and running against whatever
  // workspace happened to be configured.
  if (instance == null && client.sequencer !== "eb_send" && client.sequencer !== "eb_personal") {
    throw new Error(
      `${client.name} runs on ${client.sequencer}, not EmailBison, so it has no default ` +
      `EmailBison instance. Pass instance ("eb_send" or "eb_personal") to target one explicitly.`
    );
  }
  // Accept the short "send"/"personal" names used on main as well.
  const alias = { send: "eb_send", personal: "eb_personal" };
  const inst = alias[instance] ?? instance ?? fallback;
  if (!EB_INSTANCES.includes(inst)) {
    throw new Error(`Unknown EmailBison instance "${inst}". Expected one of: ${EB_INSTANCES.join(", ")}.`);
  }

  const isPersonal = inst === "eb_personal";
  const envName    = isPersonal ? client.eb_personal_key_env : client.eb_send_key_env;
  const system     = isPersonal ? "emailbison_personal" : "emailbison_send";

  // Cockpit keychain → clients.json's env var → account-level master key.
  const vaultKey   = cockpitSecret(client.name, system);
  const envKey     = envName ? process.env[envName] : undefined;
  const scopedKey  = vaultKey ?? envKey;
  const masterName = isPersonal ? MASTER_SOURCE.personal : MASTER_SOURCE.send;
  const masterKey  = isPersonal ? EB_PERSONAL_KEY : EB_SEND_KEY;
  const key        = scopedKey || masterKey;

  if (!key) {
    throw new Error(
      `No EmailBison credentials for ${client.name} on ${inst}: ` +
      (envName ? `${envName} is not set in .env, and ` : "") +
      `neither is ${masterName}.`
    );
  }

  // Per-instance id first; legacy eb_ws_id only for the default instance.
  const perInstance = isPersonal ? client.eb_personal_ws_id : client.eb_send_ws_id;
  const ws_id = perInstance ?? (inst === fallback ? client.eb_ws_id : null) ?? null;

  return {
    base:  isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE,
    key,
    ws_id,
    instance:       inst,
    is_default:     inst === fallback,
    scoped:         !!scopedKey,
    key_source:     vaultKey ? `cockpit:${system}` : envKey ? envName : masterName,
    declared_env:   envName ?? null,
    scoped_missing: !!(envName && !scopedKey),
  };
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

// Point the token at the client's workspace before any workspace-scoped call.
//
// This response used to be discarded. That was the dangerous bug: if the switch
// failed, the request that followed still went out and executed against
// whichever workspace the token happened to be on — so a campaign meant for one
// client could be created in another client's workspace, silently.
export async function ebSwitchWorkspace(cfg, client) {
  if (cfg.ws_id == null) {
    const field = cfg.instance === "eb_personal" ? "eb_personal_ws_id" : "eb_send_ws_id";
    throw new Error(
      `${client.name} has no workspace id for instance ${cfg.instance} in clients.json — ` +
      `cannot target an EmailBison workspace. Set ${field}` +
      (cfg.is_default ? " (or the legacy eb_ws_id)" : "") + `.`
    );
  }

  let res;
  try {
    res = await fetch(`${cfg.base}/workspaces/v1.1/switch-workspace`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ team_id: cfg.ws_id }),
    });
  } catch (e) {
    throw new Error(`EmailBison workspace switch failed for ${client.name} (network error): ${e.message}`);
  }

  if (res.ok) return;

  // A workspace-scoped token is already bound to its own workspace and may
  // legitimately reject switch-workspace — that case is safe to continue.
  // A master key that cannot switch is NOT safe: the next call would run
  // against the wrong workspace.
  //
  // But 401/403 means the token did not authenticate at all, which is never the
  // benign "already bound" case. Swallowing it here made a revoked scoped key
  // look like a successful switch, and the failure only surfaced later as an
  // unrelated crash while parsing the next response.
  if (cfg.scoped && res.status !== 401 && res.status !== 403) return;

  const detail = await res.text().catch(() => "");
  throw new Error(
    `EmailBison workspace switch failed for ${client.name} on ${cfg.instance} ` +
    `(team_id ${cfg.ws_id}, HTTP ${res.status}, using ${cfg.key_source}). ` +
    (cfg.scoped_missing
      ? `clients.json declares ${cfg.declared_env} but it is not set in .env, so the ` +
        `account-level key was used and it cannot reach this workspace. ` +
        `Add ${cfg.declared_env} to .env. `
      : `Either grant this API user access to the workspace, or add a workspace-scoped ` +
        `token and name it in clients.json. `) +
    `Response: ${detail.slice(0, 300)}`
  );
}

// One request against an already-switched workspace. Use via ebFetch for
// one-offs, or after a single ebSwitchWorkspace when walking pages — re-switching
// per page doubles the request count for no benefit.
export async function ebRaw(cfg, method, path, body) {
  const res = await fetch(`${cfg.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export async function ebFetch(method, path, client, body, instance) {
  const cfg = ebConfig(client, instance);
  await ebSwitchWorkspace(cfg, client);
  return ebRaw(cfg, method, path, body);
}

// Walk a paginated EmailBison index route, switching workspace exactly once.
// Returns every row up to `maxPages` and reports whether it was truncated, so a
// partial list is never mistaken for a complete one.
// `concurrency` fetches pages in parallel batches. Default 1 keeps the original
// sequential behaviour for every existing caller; raise it for routes with a
// hundred-plus pages, where one-at-a-time is the difference between seconds and
// minutes.
export async function ebPaginate(client, path, { page = 1, all = false, maxPages = 200, instance, concurrency = 1 } = {}) {
  const cfg = ebConfig(client, instance);
  await ebSwitchWorkspace(cfg, client);

  const sep = path.includes("?") ? "&" : "?";
  const first = await ebRaw(cfg, "GET", `${path}${sep}page=${page}`);
  if (first?.message && !first?.data) {
    throw new Error(`EmailBison rejected ${path} for ${client.name} on ${cfg.instance}: ${first.message}`);
  }
  // EmailBison also returns errors nested as {data: {success: false, message}},
  // which the guard above does not catch. Without this the spread below threw
  // "((intermediate value) ?? []) is not iterable" — a parser error that hid a
  // plain authentication failure.
  if (first?.data && !Array.isArray(first.data)) {
    const msg = first.data.message ?? JSON.stringify(first.data).slice(0, 200);
    throw new Error(
      `EmailBison rejected ${path} for ${client.name} on ${cfg.instance} ` +
      `(workspace ${cfg.ws_id}, using ${cfg.key_source}): ${msg}`
    );
  }

  const rows = [...(first?.data ?? [])];
  const lastPage = first?.meta?.last_page ?? 1;
  let pagesFetched = 1;

  if (all) {
    const stopAt = Math.min(lastPage, page + maxPages - 1);
    const todo = [];
    for (let p = page + 1; p <= stopAt; p++) todo.push(p);
    const width = Math.max(1, concurrency);
    for (let i = 0; i < todo.length; i += width) {
      const batch = todo.slice(i, i + width);
      const results = await Promise.all(
        batch.map(p => ebRaw(cfg, "GET", `${path}${sep}page=${p}`))
      );
      for (const r of results) {
        rows.push(...(r?.data ?? []));
        pagesFetched++;
      }
    }
  }

  return {
    rows,
    raw: first,
    instance: cfg.instance,
    ws_id: cfg.ws_id,
    total: first?.meta?.total ?? rows.length,
    last_page: lastPage,
    pages_fetched: pagesFetched,
    truncated: all && lastPage > pagesFetched,
  };
}

// List every workspace on an EmailBison instance (account-level key, not a
// client's scoped one) — the only way to see workspaces no client is routed
// to, e.g. a shared/default workspace an external integration uploads into.
export async function ebListWorkspaces(instance) {
  const isPersonal = instance === "eb_personal";
  const base = isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE;
  const key = isPersonal ? EB_PERSONAL_KEY : EB_SEND_KEY;
  if (!key) throw new Error(`No account-level EmailBison key for instance "${instance}"`);
  const res = await fetch(`${base}/workspaces`, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  const data = await res.json();
  // This used to return the error body as if it were data, so a dead account key
  // looked like an empty/odd result instead of an auth failure.
  const envName = isPersonal ? "EMAILBISON_PERSONAL_API_KEY" : "EMAILBISON_SEND_API_KEY";
  if (!res.ok || data?.success === false) {
    throw new Error(
      `EmailBison ${instance} rejected the account-level key (HTTP ${res.status}): ` +
      `${data?.message ?? "unknown error"}. ${envName} in .env is stale or revoked — ` +
      `replace it with a fresh account-level key from the ${isPersonal ? "personal" : "send"} dashboard. ` +
      `Per-client scoped keys are unaffected.`
    );
  }
  return Array.isArray(data) ? data : (data?.data ?? data);
}

export async function ebSenderFetch(method, sender_email_id, instance, body, client) {
  // Validate instead of falling back. This used to compare against "personal",
  // which callers never send — the canonical form is "eb_personal" (see
  // EB_INSTANCES and every other comparison in this file). So every
  // personal-instance call silently resolved to the SEND base and SEND master
  // key. Sender-email ids are per-instance, so id 42 on personal is a different
  // mailbox than id 42 on send: a PATCH could rewrite an unrelated client's
  // daily_limit, and a DELETE could remove their mailbox, both returning 200.
  // A wrong/unknown value must fail loudly rather than quietly hit send.
  if (!EB_INSTANCES.includes(instance)) {
    throw new Error(
      `Unknown EmailBison instance "${instance}". Expected one of: ${EB_INSTANCES.join(", ")}.`
    );
  }
  const isPersonal = instance === "eb_personal";
  const base = isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE;

  // Prefer the client's scoped key when we know the client. The account master
  // key is NOT universally accepted here: on the personal instance
  // /sender-emails/{id} answers 401 to the master key and 200 to the client's
  // scoped key, so master-only made every personal-instance call fail.
  let key = isPersonal ? EB_PERSONAL_KEY : EB_SEND_KEY;
  let key_source = isPersonal ? "EMAILBISON_PERSONAL_API_KEY" : "EMAILBISON_SEND_API_KEY";
  if (client) {
    const cfg = ebConfig(client, instance);
    key = cfg.key;
    key_source = cfg.key_source;
  }
  if (!key) {
    throw new Error(
      `No EmailBison credentials for the ${instance} instance (${key_source} is not set).`
    );
  }
  const res  = await fetch(`${base}/sender-emails/${sender_email_id}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, key_source };
}

export async function apolloFetch(path, body) {
  if (!APOLLO_KEY) throw new Error("APOLLO_API_KEY is not set in the MCP env config");
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": APOLLO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Cockpit names this slot masterinbox_master (the per-client slot is plain
// "masterinbox") — accept both rather than depending on that distinction.
export const MI_MASTER_KEY =
  globalSecret("masterinbox_master") ?? globalSecret("masterinbox") ?? process.env.MASTERINBOX_API_KEY;
export const MI_MASTER_SOURCE =
  globalSecret("masterinbox_master") || globalSecret("masterinbox") ? "cockpit" : "MASTERINBOX_API_KEY";

async function miCall(key, method, path, body) {
  const res = await fetch(`${MI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: method === "GET" || !body ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(
      `MasterInbox ${method} ${path} -> HTTP ${res.status}: ` +
      (data?.message || text.slice(0, 200))
    );
  }
  return data;
}

// The workspace a MasterInbox call targets. Every workspace-scoped route needs
// it explicitly — the key alone does not select one.
export function miWorkspaceId(client) {
  if (client?.mi_ws_id == null) {
    throw new Error(`${client?.name ?? "client"} has no mi_ws_id in clients.json — cannot target a MasterInbox workspace.`);
  }
  return String(client.mi_ws_id);
}

// List every MasterInbox workspace (account-level master key).
export async function miListWorkspaces() {
  if (!MI_MASTER_KEY) throw new Error("MASTERINBOX_API_KEY is not set in .env");
  const res = await fetch(`${MI_BASE}/api/api-webhook/v1/api/get-all-workspaces`, {
    headers: { Authorization: `Bearer ${MI_MASTER_KEY}`, "Content-Type": "application/json" },
  });
  const data = await res.json();
  return data?.data ?? data;
}

const MI_AUTH_REJECTED = /invalid api credentials|unauthori[sz]ed/i;

// Try the client's workspace-scoped pk_ key first. Several of those keys have
// been rotated on MasterInbox's side and now return "Invalid API credentials";
// when that happens, fall back to the account-level key WITH an explicit
// workspace_id. Verified that the master key honours workspace_id — it returns
// prospect IDs prefixed with the requested workspace, not a default one.
//
// The fallback is deliberately refused when it cannot be scoped, because an
// unscoped master-key call would hand back some other client's inbox.
export async function miFetch(method, path, client, body) {
  const scoped = client.mi_pk;

  if (!scoped && !MI_MASTER_KEY) {
    throw new Error(
      `No MasterInbox credentials for ${client.name}: ` +
      `${client.mi_key_env ?? "mi_key_env"} is not set in .env, and neither is MASTERINBOX_API_KEY.`
    );
  }

  if (scoped) {
    const r = await miCall(scoped, method, path, body);
    if (!MI_AUTH_REJECTED.test(String(r?.message ?? ""))) return r;
    if (!MI_MASTER_KEY) return r;
  }

  if (client.mi_ws_id == null) {
    throw new Error(
      `MasterInbox rejected the key for ${client.name} and no mi_ws_id is set in clients.json, ` +
      `so the master key cannot be scoped safely. Re-issue ${client.mi_key_env ?? "the client key"}.`
    );
  }

  if (!body) {
    throw new Error(
      `MasterInbox rejected ${client.mi_key_env ?? "the client key"} for ${client.name}. ` +
      `The master-key fallback needs a request body carrying workspace_id, and ${path} takes none — ` +
      `re-issue this client's key in MasterInbox.`
    );
  }

  return miCall(MI_MASTER_KEY, method, path, { ...body, workspace_id: String(client.mi_ws_id) });
}

// ── MCP response shapers ─────────────────────────────────────────────────────
export function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

// Master-key-first MasterInbox call (the account key reaches every workspace).
// Used by mailbox connect links, where a per-client key is often rejected on
// workspace-scoped routes and the GET has no body for miFetch's fallback.
export async function miFetchMaster(method, path, client) {
  const key = MI_MASTER_KEY || client?.mi_pk;
  if (!key) throw new Error(`No MasterInbox key for ${client?.name ?? "request"} (MASTERINBOX_API_KEY not set).`);
  const res = await fetch(`${MI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`MasterInbox ${method} ${path} -> HTTP ${res.status}: ${data?.message || text.slice(0, 200)}`);
  return data;
}
