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

// ── Keys ───────────────────────────────────────────────────────────────────
export const APOLLO_KEY     = process.env.APOLLO_API_KEY;
export const EB_SEND_KEY     = process.env.EMAILBISON_SEND_API_KEY;
export const EB_PERSONAL_KEY = process.env.EMAILBISON_PERSONAL_API_KEY;

// MasterInbox per-client public keys, derived from clients.json (single source
// of truth). New clients only need a clients.json edit — never a code change.
export const MI_KEYS = Object.fromEntries(
  CLIENTS.filter(c => c.mi_key_env).map(c => [c.name, process.env[c.mi_key_env]])
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
export function ebConfig(client) {
  const isPersonal = client.sequencer === "eb_personal";
  const envName    = isPersonal ? client.eb_personal_key_env : client.eb_send_key_env;
  const scopedKey  = envName ? process.env[envName] : undefined;
  const masterName = isPersonal ? "EMAILBISON_PERSONAL_API_KEY" : "EMAILBISON_SEND_API_KEY";
  const masterKey  = isPersonal ? EB_PERSONAL_KEY : EB_SEND_KEY;
  const key        = scopedKey || masterKey;

  if (!key) {
    throw new Error(
      `No EmailBison credentials for ${client.name}: ` +
      (envName ? `${envName} is not set in .env, and ` : "") +
      `neither is ${masterName}.`
    );
  }

  return {
    base:  isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE,
    key,
    ws_id: client.eb_ws_id,
    scoped:         !!scopedKey,
    key_source:     scopedKey ? envName : masterName,
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

export async function miFetch(method, path, client, body) {
  const key = client.mi_pk;
  if (!key) throw new Error(`No MI API key for ${client.name}`);
  const res = await fetch(`${MI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── MCP response shapers ─────────────────────────────────────────────────────
export function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}
