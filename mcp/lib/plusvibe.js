// ── plusvibe.js ──────────────────────────────────────────────────────────────
// PlusVibe API client. Self-sufficient in the same sense as lib/infra.js: it
// owns its base URL and key handling rather than threading them through
// core.js, so wiring PlusVibe in doesn't touch the EmailBison plumbing.
//
// Importing core.js is what loads the repo-root .env (side effect), and gives
// us getClient so pvConfig can resolve routing from clients.json exactly like
// ebConfig does.
//
// The structural difference from EmailBison: PlusVibe scopes every request with
// an explicit workspace_id. There is no "current workspace" server-side, so the
// whole class of failure that ebSwitchWorkspace exists to catch — a switch that
// fails and leaves the token pointed at the previous client's workspace — is
// not reachable here. No switch call, no ordering hazard, half the requests.
//
// Auth is ONE account-level key covering every workspace, unlike the
// per-workspace EB_SEND_KEY_* / MI_KEY_* sprawl. A per-client override is
// supported via clients.json `pv_key_env` for when that changes.
import { getClient } from "./core.js";

export const PV_BASE = "https://api.plusvibe.ai/api/v1";

// PlusVibe documents 5 req/s, with extra internal weighting on db-heavy
// endpoints. We pace at 4/s to leave headroom — reconciling a 429 that landed
// mid-batch costs far more than the seconds this adds.
const MIN_GAP_MS = 250;
let lastCall = 0;

async function pace() {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
}

// ── Credentials ──────────────────────────────────────────────────────────────
// Mirrors ebConfig: prefer the client's scoped key when clients.json names one,
// fall back to the account-level key, and carry provenance so an auth failure
// can say which key was used and why it was chosen.
export function pvConfig(client) {
  const envName   = client?.pv_key_env;
  const scopedKey = envName ? process.env[envName] : undefined;
  const masterKey = process.env.PLUSVIBE_API_KEY;
  const key       = scopedKey || masterKey;

  if (!key) {
    throw new Error(
      `No PlusVibe credentials for ${client?.name ?? "(no client)"}: ` +
      (envName ? `${envName} is not set in .env, and ` : "") +
      `neither is PLUSVIBE_API_KEY.`
    );
  }

  return {
    key,
    ws_id:          client?.pv_ws_id ?? null,
    scoped:         !!scopedKey,
    key_source:     scopedKey ? envName : "PLUSVIBE_API_KEY",
    declared_env:   envName ?? null,
    scoped_missing: !!(envName && !scopedKey),
  };
}

/** Resolve the PlusVibe workspace id for a client, with an actionable error. */
export function pvWorkspaceId(client) {
  const id = client?.pv_ws_id;
  if (!id) {
    throw new Error(
      `${client?.name ?? "client"} has no pv_ws_id in clients.json — cannot target a PlusVibe workspace. ` +
      `Run: node mcp/scripts/pv-verify-upload.js  (it lists every workspace id the key can see).`
    );
  }
  return id;
}

// ── Low-level request ────────────────────────────────────────────────────────
/**
 * One PlusVibe request.
 *  - GET  → params go on the query string
 *  - else → params go in the JSON body
 * Pass workspace_id in `params`; it is required by essentially every endpoint.
 *
 * `key` defaults to the account-level key so scripts can call this without a
 * client; pass opts.key (from pvConfig) for per-client scoping.
 */
export async function pvFetch(method, path, params = {}, { key, retries = 3 } = {}) {
  const apiKey = key || process.env.PLUSVIBE_API_KEY;
  if (!apiKey) throw new Error("PLUSVIBE_API_KEY is not set in .env");

  const url  = new URL(`${PV_BASE}${path}`);
  const init = {
    method,
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
  };

  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  } else {
    init.body = JSON.stringify(params);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace();

    let res, text;
    try {
      res  = await fetch(url, init);
      text = await res.text();
    } catch (e) {
      if (attempt === retries) throw new Error(`PlusVibe ${method} ${path} (network error): ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // Retry throttling and server faults; never retry a 4xx, which will just
    // fail identically and burn rate-limit budget.
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) {
        throw new Error(`PlusVibe ${method} ${path} failed after ${attempt + 1} attempts: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`PlusVibe ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`);

    return data;
  }
}

/** Same as pvFetch but resolves the key + workspace_id from a client name. */
export async function pvClientFetch(method, path, client_name, params = {}) {
  const client = getClient(client_name);
  const cfg    = pvConfig(client);
  return pvFetch(method, path, { workspace_id: pvWorkspaceId(client), ...params }, { key: cfg.key });
}

// ── Workspaces ───────────────────────────────────────────────────────────────
/** The key's accessible workspaces. Doubles as an auth check. */
export async function listWorkspaces({ key } = {}) {
  const data = await pvFetch("GET", "/authenticate", {}, { key });
  return (data.workspaces ?? []).map(w => ({ id: w._id, name: w.name }));
}

/** Resolve a workspace by exact-then-substring name match. */
export async function resolveWorkspace(name, { key } = {}) {
  const all   = await listWorkspaces({ key });
  const lower = String(name).toLowerCase();
  const hit =
    all.find(w => w.name.toLowerCase() === lower) ??
    all.find(w => w.name.toLowerCase().includes(lower));
  if (!hit) {
    throw new Error(`No PlusVibe workspace matching "${name}". Available: ${all.map(w => `${w.name} (${w.id})`).join(", ")}`);
  }
  return hit;
}

// ── Email accounts ───────────────────────────────────────────────────────────
/**
 * Page through every mailbox in a workspace.
 *
 * Follows ebPaginate's contract: returns `truncated` so a partial list is never
 * mistaken for a complete one. At 49 mailboxes per domain and 76 domains this
 * walks ~38 pages, so the default cap is generous but finite.
 */
export async function listAllAccounts({ workspace_id, tags, key, page_size = 100, max_pages = 200 } = {}) {
  const out = [];
  let skip = 0;

  for (let page = 0; page < max_pages; page++) {
    const data  = await pvFetch("GET", "/account/list", { workspace_id, tags, skip, limit: page_size }, { key });
    const batch = data.accounts ?? [];
    out.push(...batch);
    if (batch.length < page_size) {
      return { accounts: out, pages_fetched: page + 1, truncated: false };
    }
    skip += page_size;
  }

  return { accounts: out, pages_fetched: max_pages, truncated: true };
}

/** Split a long id list into API-sized chunks. */
export function chunk(arr, size = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Turn warmup on/off in bulk. `warmup_status` is "ACTIVE" | "INACTIVE".
 * Only the warmup status is touched; all other account config is preserved.
 * Chunks internally, so passing 3,700 ids is fine.
 */
export async function bulkSetWarmup({ workspace_id, ids, warmup_status, key, chunk_size = 100 }) {
  const results = [];
  for (const batch of chunk(ids, chunk_size)) {
    const r = await pvFetch("PATCH", "/account/bulk-update-warmup",
      { workspace_id, ids: batch, warmup_status }, { key });
    results.push({ count: batch.length, updated: r?.data?.updated_count ?? null, raw: r });
  }
  return results;
}

/**
 * Bulk-edit account settings (daily_limit, rampup, signature, …).
 * NOTE: this endpoint is PUT, not PATCH — /account/bulk-update-warmup is the
 * PATCH one. Mixing them up returns 4xx with an unhelpful body.
 * Only the fields you pass are modified.
 */
export async function bulkUpdateAccounts({ workspace_id, ids, key, chunk_size = 100, ...fields }) {
  const results = [];
  for (const batch of chunk(ids, chunk_size)) {
    const r = await pvFetch("PUT", "/account/bulk-update",
      { workspace_id, ids: batch, ...fields }, { key });
    results.push({ count: batch.length, raw: r });
  }
  return results;
}

/**
 * Pull the id off a mailbox object from /account/list.
 * The docs' example shows `_id`, but the live response uses a different key —
 * email_accounts[] rejected `undefined` with "must be a string". Try the
 * plausible names and fail loudly with the actual keys rather than passing
 * undefined into a payload.
 */
export function accountId(a) {
  const id = a?._id ?? a?.id ?? a?.account_id ?? a?.email_account_id ?? a?.uuid;
  if (!id) {
    throw new Error(
      `No id field on this mailbox object. Available keys: ${Object.keys(a ?? {}).join(", ")}. ` +
      `Add the right one to accountId() in mcp/lib/plusvibe.js.`
    );
  }
  return String(id);
}

// ── Campaigns ────────────────────────────────────────────────────────────────
export async function listCampaigns({ workspace_id, key }) {
  return pvFetch("GET", "/campaign/list", { workspace_id }, { key });
}

/**
 * Every campaign in a workspace, paginated. Used to adopt campaigns that were
 * created by an earlier run but never recorded in the resume map — without this
 * a retry creates duplicates instead of finishing the job.
 * Response envelope varies, so unwrap defensively.
 */
export async function listAllCampaigns({ workspace_id, key, page_size = 100, max_pages = 100 } = {}) {
  const out = [];
  let skip = 0;
  for (let page = 0; page < max_pages; page++) {
    const data  = await pvFetch("GET", "/campaign/list-all", { workspace_id, skip, limit: page_size }, { key });
    const batch = Array.isArray(data) ? data : (data.campaigns ?? data.data ?? data.result ?? []);
    out.push(...batch);
    if (batch.length < page_size) return { campaigns: out, truncated: false };
    skip += page_size;
  }
  return { campaigns: out, truncated: true };
}

/** Create is name-only. Everything substantive lands via updateCampaign. */
export async function createCampaign({ workspace_id, camp_name, key }) {
  return pvFetch("POST", "/campaign/add/campaign", { workspace_id, camp_name }, { key });
}

/**
 * Patch a campaign. Only the keys you pass are touched.
 *
 * `sequences`: [{ step, wait_time, variations: [{ variation, subject, name, body }] }]
 * Gotcha: `first_wait_time` is a TOP-LEVEL field, not step 1's wait_time. Setting
 * only step 1's wait_time leaves the initial delay at PlusVibe's default.
 */
export async function updateCampaign({ workspace_id, campaign_id, key, ...fields }) {
  return pvFetch("PATCH", "/campaign/update/campaign", { workspace_id, campaign_id, ...fields }, { key });
}

/**
 * Delete or archive one campaign. Ids go one per call — the endpoint takes a
 * single campaign_id string, not an array.
 *   is_archive: "no"  → hard delete (irreversible)
 *   is_archive: "yes" → archive, recoverable
 */
export async function deleteCampaign({ workspace_id, campaign_id, is_archive = "no", is_save_lead_data = "no", key }) {
  return pvFetch("DELETE", "/campaign/delete",
    { workspace_id, campaign_id, is_archive, is_save_lead_data }, { key });
}

export async function addLeads({ workspace_id, campaign_id, leads, key, ...opts }) {
  return pvFetch("POST", "/lead/add", { workspace_id, campaign_id, leads, ...opts }, { key });
}

// ── Blocklist ────────────────────────────────────────────────────────────────
/** Accepts bare emails and bare domains in the same array. */
export async function addBlocklistEntries({ workspace_id, entries, key }) {
  return pvFetch("POST", "/blocklist/add/entries", { workspace_id, entries }, { key });
}

export async function getBlocklist({ workspace_id, key }) {
  return pvFetch("GET", "/blocklist/get/entries", { workspace_id }, { key });
}
