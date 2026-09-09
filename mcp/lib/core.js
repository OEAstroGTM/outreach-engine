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

// Resolve the EmailBison credentials for a client.
//
// Prefer the client's workspace-scoped token, named by clients.json in
// eb_send_key_env / eb_personal_key_env. Fall back to the account-level master
// key so clients that never had a scoped token keep working exactly as before.
//
// We carry the provenance (key_source, scoped, scoped_missing) so that when a
// call fails the error can say which key was used and why it was chosen —
// previously an auth failure gave no way to tell these cases apart.
// `instance` is optional: "send" | "personal". When omitted it follows the
// client's sequencer, which is the legacy behaviour.
//
// Cockpit's "Configure systems" panel writes eb_send_ws_id / eb_personal_ws_id
// and treats Send and Personal as two independent systems a client can be on
// simultaneously (Abra is on both: send 50, personal 9). The old single
// sequencer + eb_ws_id pair is still what most clients have, so resolve the
// new fields first and fall back to eb_ws_id.
export function ebConfig(client, instance) {
  const isPersonal = instance === "personal" || (!instance && client.sequencer === "eb_personal");
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
      `No EmailBison credentials for ${client.name}: nothing in Cockpit's keychain for ` +
      `${system}, ` + (envName ? `${envName} is not set in .env, ` : "") +
      `and neither is ${masterName}.`
    );
  }

  // Prefer the explicit per-instance id; fall back to the legacy eb_ws_id, but
  // only when that legacy id actually refers to this instance.
  const legacyMatches = isPersonal
    ? client.sequencer === "eb_personal"
    : client.sequencer !== "eb_personal";
  const ws_id = (isPersonal ? client.eb_personal_ws_id : client.eb_send_ws_id)
    ?? (legacyMatches ? client.eb_ws_id : null);

  return {
    base:  isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE,
    key,
    ws_id,
    instance:       isPersonal ? "personal" : "send",
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
    throw new Error(
      `${client.name} has no eb_ws_id in clients.json — cannot target an EmailBison workspace.`
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
  if (cfg.scoped) return;

  const detail = await res.text().catch(() => "");
  throw new Error(
    `EmailBison workspace switch failed for ${client.name} ` +
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

export async function ebFetch(method, path, client, body) {
  const cfg = ebConfig(client);
  await ebSwitchWorkspace(cfg, client);
  return ebRaw(cfg, method, path, body);
}

// Walk a paginated EmailBison index route, switching workspace exactly once.
// Returns every row up to `maxPages` and reports whether it was truncated, so a
// partial list is never mistaken for a complete one.
export async function ebPaginate(client, path, { page = 1, all = false, maxPages = 200 } = {}) {
  const cfg = ebConfig(client);
  await ebSwitchWorkspace(cfg, client);

  const sep = path.includes("?") ? "&" : "?";
  const first = await ebRaw(cfg, "GET", `${path}${sep}page=${page}`);
  if (first?.message && !first?.data) {
    throw new Error(`EmailBison rejected ${path} for ${client.name}: ${first.message}`);
  }

  const rows = [...(first?.data ?? [])];
  const lastPage = first?.meta?.last_page ?? 1;
  let pagesFetched = 1;

  if (all) {
    const stopAt = Math.min(lastPage, page + maxPages - 1);
    for (let p = page + 1; p <= stopAt; p++) {
      const r = await ebRaw(cfg, "GET", `${path}${sep}page=${p}`);
      rows.push(...(r?.data ?? []));
      pagesFetched++;
    }
  }

  return {
    rows,
    raw: first,
    total: first?.meta?.total ?? rows.length,
    last_page: lastPage,
    pages_fetched: pagesFetched,
    truncated: all && lastPage > pagesFetched,
  };
}

export async function ebSenderFetch(method, sender_email_id, instance, body) {
  const base = instance === "personal" ? EB_PERSONAL_BASE : EB_SEND_BASE;
  const key  = instance === "personal" ? EB_PERSONAL_KEY  : EB_SEND_KEY;
  const res  = await fetch(`${base}/sender-emails/${sender_email_id}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
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
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
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
