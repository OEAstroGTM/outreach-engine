// ── core.js ─────────────────────────────────────────────────────────────────
// Shared config, client resolution, and low-level fetch helpers. Single source
// of truth for API bases and keys; imported by tools.js, agents, and index.js.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

export function ebConfig(client) {
  const isPersonal = client.sequencer === "eb_personal";
  return {
    base:  isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE,
    key:   isPersonal ? EB_PERSONAL_KEY  : EB_SEND_KEY,
    ws_id: client.eb_ws_id,
  };
}

// ── Fetch helpers ────────────────────────────────────────────────────────────
export async function ebFetch(method, path, client, body) {
  const { base, key, ws_id } = ebConfig(client);
  await fetch(`${base}/workspaces/v1.1/switch-workspace`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ team_id: ws_id }),
  });
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
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
