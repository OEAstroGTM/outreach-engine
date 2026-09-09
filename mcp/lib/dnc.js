// ── dnc.js ───────────────────────────────────────────────────────────────────
// "Every time a meeting is booked, the domain should be added to the DNC in Bison."
//
// Why this is a reconciler and not an event handler:
//   • EmailBison has no "meeting booked" webhook. Its catalog stops at
//     sent / replied / interested / unsubscribed / bounced / tag-attached.
//   • The signal actually lives in MasterInbox as the "Meeting Booked" label,
//     and MasterInbox exposes no outbound webhook for label changes.
// So instead of reacting to an event, we re-derive the desired blocklist state
// from MasterInbox on a schedule and push the diff to Bison. A missed run is
// harmless: the next one catches up.
//
// Safety posture — blocklisting is destructive and invisible, so:
//   • dry_run defaults to TRUE everywhere. You must opt in to writes.
//   • Every decision (blocked, skipped, and why) is recorded in the ledger.
//   • This module only ever ADDS. Removal is a deliberate manual act.
//   • Free-mail and own-infrastructure domains are hard-blocked from blocking.
//   • Churned clients are excluded — their workspaces are not ours to write to.
//   • Server-side label filtering is not trusted at all: it was observed to be a
//     complete no-op, so we scan and match locally (see fetchBookedProspects).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { CLIENTS, MI_KEYS, getClient, ebConfig, ebSwitchWorkspace, miFetch } from "./core.js";

const __dirname   = dirname(fileURLToPath(import.meta.url));
const DATA_DIR    = join(__dirname, "../../data");
const LEDGER_PATH = join(DATA_DIR, "dnc-ledger.json");

// MasterInbox has TWO label ID namespaces, and they do not match:
//
//   /labels           → { label_id: 6270,   label_name: "Meeting Booked" }
//   a prospect record → { labels: [155249], label_names: ["OOO Sequence"], ailabel_id: 155249 }
//
// 6270 is a catalog/template ID. What lands on a prospect is a per-workspace
// instance ID. Filtering prospects by 6270 therefore matches nothing, ever —
// which is exactly what the first live run showed: 0 hits across 2,980 rows.
//
// `label_names` is the only key that means the same thing in both namespaces, so
// that is what we match on. The numeric IDs are collected per run (see
// labelCensus) so the mapping is visible rather than folklore.
export const MEETING_BOOKED_LABEL       = "Meeting Booked";
export const MEETING_BOOKED_CATALOG_ID  = 6270;  // /labels only — NOT valid against prospects

const MI_PATH   = "/api/api-webhook/v1/api/get-prospects";
const MI_PAGE   = 100;   // MasterInbox page size

// MasterInbox is Elasticsearch-backed and enforces index.max_result_window:
//   "Result window is too large, from + size must be less than or equal to
//    [10000] but was [10100]"
// Offset paging therefore cannot reach past the 10,000th prospect, no matter
// what max_pages says. Raising the bound to 250 turned Outreach Engine's silent
// partial scan into a hard error — which is better, but the real answer is to
// clamp at the ceiling and report exactly how many prospects are unreachable.
const MI_RESULT_WINDOW = 10000;
const MI_MAX_OFFSET_PAGES = Math.floor(MI_RESULT_WINDOW / MI_PAGE);
// The server-side label filter is a no-op (see fetchBookedProspects), so every
// run is a full workspace scan. AskTuring alone is ~30 pages; the bound is
// generous and blowing through it is reported loudly rather than silently.
const MAX_PAGES = 250;

// Blocklisting one of these would silently gut a campaign: they are shared
// mailbox providers, not prospect companies. This guard is non-negotiable —
// a single prospect replying from a gmail address would otherwise blocklist
// gmail.com for the entire workspace.
const FREE_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "yahoo.com", "ymail.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
  "zoho.com", "yandex.com", "fastmail.com", "hey.com", "comcast.net",
  "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net",
  "charter.net", "earthlink.net", "btinternet.com", "sky.com", "orange.fr",
  "web.de", "t-online.de", "libero.it", "free.fr", "qq.com", "163.com",
  "126.com", "naver.com", "hanmail.net", "rediffmail.com", "duck.com",
]);

// Our own sending infrastructure and anything the operator marks off-limits.
const NEVER_BLOCK_PATTERNS = [/outreachengine/i];

// ── Domain handling ──────────────────────────────────────────────────────────

/** Normalize anything domain-ish (URL, bare host, email host) to a bare host. */
export function normalizeDomain(raw) {
  if (!raw || typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme
  d = d.split("/")[0].split("?")[0].split("#")[0]; // strip path/query/fragment
  d = d.split("@").pop();                          // tolerate a full email
  d = d.split(":")[0];                             // strip port
  d = d.replace(/^www\./, "").replace(/\.+$/, ""); // strip www. and trailing dots
  if (!d.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

/** MasterInbox gives us `website` directly; fall back to the email host. */
export function extractDomain(prospect) {
  return (
    normalizeDomain(prospect?.website) ||
    normalizeDomain(prospect?.email) ||
    normalizeDomain(prospect?.last_reply_address) ||
    null
  );
}

/** Returns null if blockable, otherwise a human-readable reason to skip. */
export function skipReason(domain, client) {
  if (!domain) return "no resolvable domain";
  if (FREE_MAIL_DOMAINS.has(domain)) return "free-mail provider";
  if (NEVER_BLOCK_PATTERNS.some(re => re.test(domain))) return "own infrastructure";
  const never = (client?.dnc_never_block ?? []).map(normalizeDomain).filter(Boolean);
  if (never.includes(domain)) return "client allowlist (dnc_never_block)";
  if (domain.split(".").some(part => part.length === 0)) return "malformed domain";
  return null;
}

// ── Ledger ───────────────────────────────────────────────────────────────────

export function loadLedger() {
  if (!existsSync(LEDGER_PATH)) return { version: 1, clients: {} };
  try {
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch (e) {
    throw new Error(`DNC ledger at ${LEDGER_PATH} is unreadable (${e.message}). Refusing to run — fix or delete it.`);
  }
}

export function saveLedger(ledger) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function clientLedger(ledger, name) {
  ledger.clients[name] ??= { last_run_at: null, blocked: {}, skipped_counts: {} };
  return ledger.clients[name];
}

// ── EmailBison: /api/blacklisted-domains ─────────────────────────────────────
// Documented contract (paths below are relative to ebConfig().base, which
// already ends in /api):
//
//   GET  /blacklisted-domains        search, pagination_type
//   POST /blacklisted-domains        {"domain":"example.com","skip_webhooks":true}
//   POST /blacklisted-domains/bulk   multipart: csv=<file>, skip_webhooks=false
//
// Two notes on turning the published docs into actual requests:
//
//  1. The GET is documented with a JSON body. HTTP forbids a body on GET and
//     fetch() throws outright if you try, so `search` / `pagination_type` go on
//     the query string instead. Laravel reads query and body identically, so
//     this is the same request the docs describe.
//  2. `pagination_type: "cursor"` implies Laravel cursor pagination, which hands
//     back a `next_cursor` rather than page numbers. We follow the cursor when
//     the instance gives us one and fall back to `?page=N` when it doesn't, so
//     this works against either paginator without a config flag.
//
// skip_webhooks defaults to FALSE everywhere in this module. That matches the
// platform's own default, and quietly suppressing downstream notifications is
// exactly the kind of invisible side effect this file exists to avoid. Pass
// true deliberately — e.g. a few hundred domains in one backfill, where you
// don't want to flood every webhook consumer.

const BLOCKLIST_PATH = "/blacklisted-domains";
const PER_PAGE       = 100;

// Ujet read exactly 3,750 rows in 250 pages — 15 per page. The instance ignores
// per_page and serves its own page size, so a bound tuned for 100-row pages
// truncates the list at a sixth of its length. The blocklist walk therefore gets
// its own generous bound; the row-id stall check still ends it early for every
// client whose list actually finishes, which is all of them but this one.
const BLOCKLIST_MAX_PAGES = 1000;

async function ebRequest(method, path, client, { body, form } = {}) {
  // Auth and workspace targeting are core.js's job, not ours:
  //   ebConfig            resolves the workspace-scoped token (eb_send_key_env /
  //                       eb_personal_key_env) with the account key as fallback,
  //                       and carries the provenance into error messages.
  //   ebSwitchWorkspace   points the token at this client's workspace and THROWS
  //                       if that fails unsafely, so a request can never execute
  //                       against whichever workspace the token was last on.
  //
  // We still issue the request ourselves rather than via ebRaw, because ebRaw
  // returns res.json() only — this module needs the status code, tolerates
  // non-JSON error bodies, and has to send multipart for the bulk endpoint.
  const cfg = ebConfig(client);
  await ebSwitchWorkspace(cfg, client);

  // Never set Content-Type for multipart — fetch has to add its own boundary.
  const headers = { Authorization: `Bearer ${cfg.key}`, Accept: "application/json" };
  let payload;
  if (form) {
    payload = form;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res  = await fetch(`${cfg.base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { ok: res.ok, status: res.status, data };
}

/** Unwrap whichever envelope the instance returns (bare array, {data}, {data:{data}}). */
export function extractRows(data) {
  if (Array.isArray(data))                      return data;
  if (Array.isArray(data?.data))                return data.data;
  if (Array.isArray(data?.data?.data))          return data.data.data;
  if (Array.isArray(data?.blacklisted_domains)) return data.blacklisted_domains;
  return [];
}

export function rowToDomain(row) {
  if (typeof row === "string") return normalizeDomain(row);
  return normalizeDomain(row?.domain ?? row?.name ?? row?.value ?? row?.blacklisted_domain);
}

function cursorFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try { return new URL(url).searchParams.get("cursor"); } catch { return null; }
}

export function nextCursor(data) {
  return (
    data?.next_cursor ??
    data?.meta?.next_cursor ??
    data?.data?.next_cursor ??
    cursorFromUrl(data?.links?.next) ??
    cursorFromUrl(data?.next_page_url) ??
    null
  );
}

/**
 * Pull the workspace's blocklist as a Set of normalized domains.
 *
 * @param {object}  client
 * @param {string} [opts.search]    Server-side substring filter (the documented `search` param).
 * @param {number} [opts.maxPages]  Hard bound; hitting it sets `truncated` rather than lying.
 */
export async function fetchExistingBlocklist(client, { search, maxPages = BLOCKLIST_MAX_PAGES } = {}) {
  const domains = new Set();
  // `mode` is what we ASKED for; `cursorSeen` is whether the server ever actually
  // handed one back. Reporting the request as though it were a confirmation is
  // how the first run produced a reassuring "cursor" against an empty response.
  let sample = null, pages = 0, cursor = null, page = 1, mode = "cursor", done = false, cursorSeen = false, stalled = false;
  let rowsRead = 0, reportedTotal = null;
  const seenRows = new Set();

  while (pages < maxPages) {
    const qs = new URLSearchParams({ per_page: String(PER_PAGE) });
    if (search) qs.set("search", search);
    if (mode === "cursor") {
      qs.set("pagination_type", "cursor");
      if (cursor) qs.set("cursor", cursor);
    } else {
      qs.set("page", String(page));
    }

    const { ok, status, data } = await ebRequest("GET", `${BLOCKLIST_PATH}?${qs}`, client);
    if (!ok) throw new Error(`GET ${BLOCKLIST_PATH} failed for ${client.name} (HTTP ${status}): ${JSON.stringify(data).slice(0, 300)}`);

    const rows = extractRows(data);
    if (pages === 0) sample = rows[0] ?? null;
    if (reportedTotal == null) {
      const t = Number(data?.meta?.total ?? data?.total ?? data?.data?.total);
      if (Number.isFinite(t)) reportedTotal = t;
    }
    pages++;
    rowsRead += rows.length;

    let freshRows = 0;
    for (const row of rows) {
      const key = row?.id ?? row?.uuid ?? rowToDomain(row) ?? JSON.stringify(row);
      if (!seenRows.has(key)) { seenRows.add(key); freshRows++; }
      const d = rowToDomain(row);
      if (d) domains.add(d);
    }

    if (!rows.length) { done = true; break; }

    // Ujet: 100 pages read, 1,500 unique domains — the instance keeps serving
    // rows we have already seen instead of ending the list.
    //
    // Counting new ROW IDS rather than new domains is what catches this. My first
    // attempt compared domain-set size and never fired, because the overlapping
    // pages still dribbled in the occasional unseen domain. A page that introduces
    // no unseen row id, on the other hand, means the walk is going in circles.
    if (freshRows === 0) {
      done    = true;
      stalled = true;
      break;
    }

    const next = nextCursor(data);
    if (next) { cursor = next; cursorSeen = true; continue; }

    // No cursor came back, so this instance is page-paginated regardless of what
    // we asked for. Switch and keep going — page 1 is already in the Set, and
    // it's a Set, so the overlap is free.
    //
    // Note what is NOT here: a `rows.length === PER_PAGE` test for "last page".
    // Ujet's instance ignores per_page and serves 15 rows no matter what, so that
    // test called page one the final page and reported a 15-domain blocklist.
    // Termination is handled by the two checks above instead — an empty page, or
    // a page that introduces no unseen row id — neither of which assumes the
    // server honoured our page size.
    if (mode === "cursor") { mode = "page"; page = 2; } else { page++; }
  }

  return {
    domains, pages, sample, truncated: !done, stalled, rows_read: rowsRead, reported_total: reportedTotal,
    page_size: pages ? Math.round(rowsRead / pages) : null,
    pagination: pages <= 1
      ? "single page — pagination behaviour not exercised"
      : (cursorSeen ? "cursor (server returned next_cursor)" : "page (server ignored pagination_type)"),
  };
}

/** Add one domain. The body shape is documented, so a failure here is a real failure. */
export async function addDomainToBlocklist(client, domain, { skip_webhooks = false } = {}) {
  const { ok, status, data } = await ebRequest("POST", BLOCKLIST_PATH, client, {
    body: { domain, skip_webhooks },
  });
  return ok
    ? { ok: true, status, data }
    : { ok: false, status, error: JSON.stringify(data).slice(0, 300) };
}

/**
 * Build the CSV payload for the bulk endpoint.
 *
 * The header row is deliberate. The docs don't say whether the importer expects
 * one, and the two failure modes are not symmetric: with a header, a parser that
 * *doesn't* skip it rejects one junk row ("domain" has no dot) and you see that
 * in the response. Without a header, a parser that *does* skip it silently drops
 * a real domain — a blocklist entry you believe exists and doesn't. Prefer the
 * loud failure.
 */
export function domainsToCsv(domains) {
  return ["domain", ...domains].join("\n") + "\n";
}

/**
 * Upload many domains in one multipart request.
 *
 * Returns `verified` / `missing` when `verify` is on: the bulk endpoint reports
 * acceptance of the *upload*, not of each row, so we re-read the blocklist and
 * confirm. Anything in `missing` was rejected by the importer without saying so.
 */
export async function bulkAddDomainsToBlocklist(client, domains, {
  skip_webhooks = false,
  filename      = "dnc-domains.csv",
  verify        = true,
} = {}) {
  const list = [...new Set(domains.filter(Boolean))];
  if (!list.length) return { ok: true, uploaded: 0, note: "nothing to upload" };

  const csv  = domainsToCsv(list);
  const form = new FormData();
  form.append("csv", new Blob([csv], { type: "text/csv" }), filename);
  form.append("skip_webhooks", skip_webhooks ? "true" : "false");

  const { ok, status, data } = await ebRequest("POST", `${BLOCKLIST_PATH}/bulk`, client, { form });
  const result = { ok, status, uploaded: list.length, data };
  if (!ok) {
    result.error = JSON.stringify(data).slice(0, 300);
    return result;
  }

  if (verify) {
    const { domains: after } = await fetchExistingBlocklist(client);
    result.verified = list.filter(d => after.has(d));
    result.missing  = list.filter(d => !after.has(d));
    if (result.missing.length) {
      result.ok      = false;
      result.warning = `Bulk upload returned HTTP ${status} but ${result.missing.length}/${list.length} domains are absent from the blocklist afterwards. The importer rejected them silently — verify the CSV shape before trusting this path.`;
    }
  }
  return result;
}

// ── Direct operator access to the three endpoints ────────────────────────────
// The reconciler is the intended path. These exist for the cases it doesn't
// cover: auditing what's already blocked, blocking a domain someone asked about
// on a call, and importing a list from outside the system.

/** GET the blocklist for one client, sorted, with the raw first row for shape debugging. */
export async function listBlockedDomains({ client_name, search, max_pages = MAX_PAGES } = {}) {
  const client = getClient(client_name);
  const { domains, pages, sample, truncated, pagination } =
    await fetchExistingBlocklist(client, { search, maxPages: max_pages });
  return {
    client: client.name,
    eb_ws_id: client.eb_ws_id,
    search: search ?? null,
    pagination,
    pages_read: pages,
    truncated,
    count: domains.size,
    domains: [...domains].sort(),
    row_sample: sample,
  };
}

/**
 * Block one domain by hand.
 *
 * The same guards the reconciler uses apply here — blocking gmail.com from a
 * chat prompt would be just as catastrophic as blocking it from a cron job.
 * `force` exists for the rare legitimate case, and says so in the result.
 */
export async function blockDomainManually({ client_name, domain, skip_webhooks = false, force = false } = {}) {
  const client     = getClient(client_name);
  const normalized = normalizeDomain(domain);
  if (!normalized) throw new Error(`"${domain}" does not normalize to a usable domain.`);

  const reason = skipReason(normalized, client);
  if (reason && !force) {
    return { ok: false, client: client.name, domain: normalized, blocked: false, refused: reason,
             hint: "Pass force:true if you are certain. Read the reason first — these guards exist because blocklisting is invisible once done." };
  }

  const res    = await addDomainToBlocklist(client, normalized, { skip_webhooks });
  const ledger = loadLedger();
  if (res.ok) {
    clientLedger(ledger, client.name).blocked[normalized] =
      { at: Date.now(), domain: normalized, mode: "live", via: "manual", forced: Boolean(reason && force) };
    saveLedger(ledger);
  }
  return { ok: res.ok, client: client.name, domain: normalized, blocked: res.ok,
           overrode_guard: reason && force ? reason : undefined,
           status: res.status, error: res.error, response: res.data };
}

/** Import a list of domains through the bulk CSV endpoint, guards and verification included. */
export async function bulkBlockDomains({ client_name, domains = [], skip_webhooks = false, force = false } = {}) {
  const client  = getClient(client_name);
  const refused = [];
  const clean   = [];

  for (const raw of domains) {
    const d = normalizeDomain(raw);
    if (!d) { refused.push({ input: raw, reason: "no resolvable domain" }); continue; }
    const reason = skipReason(d, client);
    if (reason && !force) { refused.push({ input: raw, domain: d, reason }); continue; }
    clean.push(d);
  }

  const res    = await bulkAddDomainsToBlocklist(client, clean, { skip_webhooks });
  const ledger = loadLedger();
  const cl     = clientLedger(ledger, client.name);
  for (const d of res.verified ?? []) {
    cl.blocked[d] = { at: Date.now(), domain: d, mode: "live", via: "bulk-manual" };
  }
  saveLedger(ledger);

  return {
    ok: res.ok, client: client.name,
    submitted: clean.length, refused,
    verified: res.verified ?? [], missing: res.missing ?? [],
    status: res.status, warning: res.warning, error: res.error, response: res.data,
  };
}

// ── MasterInbox: booked prospects ────────────────────────────────────────────

/** The label display names on a prospect, trimmed. */
export function prospectLabelNames(p) {
  const names = Array.isArray(p?.label_names) ? p.label_names : [];
  return names.filter(n => typeof n === "string").map(n => n.trim());
}

/**
 * Exact, case-insensitive name match.
 *
 * Exact and not substring on purpose: this workspace carries "Meeting Booked"
 * alongside "Meeting Request", and "Not Interested" alongside "Not Intrested".
 * A substring match would quietly conflate neighbours.
 */
export function hasLabelNamed(p, name) {
  const want = name.trim().toLowerCase();
  return prospectLabelNames(p).some(n => n.toLowerCase() === want);
}

/**
 * Fetch prospects carrying a given label for one client.
 *
 * We do NOT send `label_id`. It was observed to be a complete no-op: a request
 * filtered to 6270 returned all 2,980 prospects in the workspace, every sampled
 * row labelled "OOO Sequence". Sending an ignored filter only creates the
 * impression of one, so we scan the workspace and match locally on label name.
 *
 * `labelCensus` reports every label name actually seen, with the numeric IDs
 * observed alongside it. That is the diagnostic that would have caught the
 * two-namespace problem on day one, so it now ships in every run.
 */
export async function fetchBookedProspects(client, { maxPages = MAX_PAGES, labelName = MEETING_BOOKED_LABEL } = {}) {
  const booked   = [];
  const observed = new Map(); // label name -> { count, ids:Set }
  let page = 1, seen = 0, matched = 0, truncated = false, reportedTotal = null;
  const pageCap = Math.min(maxPages, MI_MAX_OFFSET_PAGES);
  const windowCapped = pageCap < maxPages;

  while (page <= pageCap) {
    const data = await miFetch("POST", MI_PATH, client, {
      workspace_id: client.mi_ws_id,
      page,
      limit: MI_PAGE,
    });
    if (data?.status === "error") {
      throw new Error(`MasterInbox get-prospects failed for ${client.name}: ${JSON.stringify(data.message)}`);
    }
    // MasterInbox reports the workspace total in metadata. Use it: "scanned
    // 10,000" is only meaningful next to "of 10,412", and a partial scan silently
    // drops booked meetings.
    if (reportedTotal == null) {
      const t = Number(data?.metadata?.total);
      if (Number.isFinite(t)) reportedTotal = t;
    }
    const rows = data?.data ?? [];
    seen += rows.length;

    for (const p of rows) {
      const names = prospectLabelNames(p);
      const ids   = Array.isArray(p.labels) ? p.labels : [];
      names.forEach((n, i) => {
        const rec = observed.get(n) ?? { count: 0, ids: new Set() };
        rec.count++;
        if (ids[i] != null) rec.ids.add(ids[i]);
        observed.set(n, rec);
      });
      if (hasLabelNamed(p, labelName)) { matched++; booked.push(p); }
    }

    if (rows.length < MI_PAGE) break;
    if (page === pageCap) truncated = true;
    page++;
  }

  const labelCensus = [...observed.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([label, r]) => ({ label, prospects: r.count, workspace_label_ids: [...r.ids] }));

  const complete    = reportedTotal == null ? !truncated : seen >= reportedTotal;
  const unreachable = reportedTotal == null ? null : Math.max(0, reportedTotal - seen);
  return {
    booked, seen, matched, pages: page, truncated, labelCensus, labelName,
    reportedTotal, complete, unreachable,
    windowCapped: windowCapped && truncated,
  };
}

// ── The reconciler ───────────────────────────────────────────────────────────

// A churned client's workspace is not ours to write to. clients.json marks them
// with status:"churned" (and sometimes churned_at); mi-check.mjs uses the same
// rule, so the two agree by construction.
export function isChurned(c) {
  return c?.status === "churned" || Boolean(c?.churned_at);
}

function eligibleClients(client_name, { include_churned = false } = {}) {
  if (client_name) {
    const c = getClient(client_name);
    if (isChurned(c) && !include_churned) {
      throw new Error(`${c.name} is marked churned in clients.json — refusing to touch its blocklist. Pass include_churned to override.`);
    }
    if (!c.mi_ws_id || !c.eb_ws_id) throw new Error(`${c.name} is missing mi_ws_id or eb_ws_id in clients.json`);
    return [{ ...c, mi_pk: MI_KEYS[c.name] }];
  }
  return CLIENTS
    .filter(c => include_churned || !isChurned(c))
    .filter(c => c.mi_ws_id && c.eb_ws_id)
    .map(c => ({ ...c, mi_pk: MI_KEYS[c.name] }));
}

/**
 * Reconcile MasterInbox "Meeting Booked" → EmailBison blocklist.
 *
 * @param {object}  opts
 * @param {string} [opts.client_name]        Single client, else every eligible client.
 * @param {boolean}[opts.dry_run=true]       TRUE = report the diff, write nothing to Bison.
 * @param {number} [opts.max_pages]          Per-client page bound; truncation is reported.
 * @param {boolean}[opts.skip_webhooks=false] Passed through to Bison on every write.
 * @param {string} [opts.label_name]         MasterInbox label to match, by display name.
 *                                           Defaults to "Meeting Booked". Names, not IDs —
 *                                           see the namespace note at the top of this file.
 * @param {number} [opts.limit]              Run-wide budget for how many domains may be written,
 *                                           summed across every client — not per client. There is
 *                                           no delete path here, so a capped first run is the only
 *                                           cheap way to test a live write. The full diff is still
 *                                           reported; `limited` says what was held back.
 * @param {boolean}[opts.use_bulk=false]     Use the multipart CSV endpoint instead of one
 *                                           POST per domain. Faster, but the importer's CSV
 *                                           expectations are undocumented, so it stays opt-in
 *                                           and every upload is verified by re-reading.
 */
export async function syncBookedMeetingsToDNC({
  client_name,
  dry_run       = true,
  max_pages     = MAX_PAGES,
  skip_webhooks = false,
  use_bulk      = false,
  label_name    = MEETING_BOOKED_LABEL,
  limit,
  include_churned = false,
} = {}) {
  const ledger  = loadLedger();
  const started = Date.now();
  const results = [];

  // Second line of defence behind the switch-workspace check. Even if a switch
  // reports success, two clients returning the identical blocklist means one of
  // them was answered in the other's workspace. Cheap to detect, catastrophic
  // to miss, so we refuse to write for the collision rather than guess which
  // one is real.
  const seenBlocklists = new Map(); // fingerprint -> client name
  let budgetSpent = 0;              // domains written so far this run, against `limit`

  for (const client of eligibleClients(client_name, { include_churned })) {
    const entry = { client: client.name, eb_ws_id: client.eb_ws_id, mi_ws_id: client.mi_ws_id };
    try {
      const scan = await fetchBookedProspects(client, { maxPages: max_pages, labelName: label_name });

      // Resolve candidates BEFORE touching the blocklist. The blocklist read
      // exists only to answer "is this domain already blocked?", so with no
      // candidates there is nothing to ask. Ujet made the cost concrete: zero
      // booked meetings, yet 1,000 paged requests to read a 15,000-entry list
      // whose answer could not have changed any outcome.
      const candidates  = new Map(); // domain -> evidence
      const skipped     = {};
      const unresolved  = []; // a booked meeting we could not turn into a domain — a human should look
      for (const p of scan.booked) {
        const domain = extractDomain(p);
        const reason = skipReason(domain, client);
        if (reason) {
          skipped[reason] = (skipped[reason] ?? 0) + 1;
          // Every other skip reason is a deliberate guard. This one is a data
          // gap: a booked meeting silently dropping out of the diff. Name it.
          if (reason === "no resolvable domain") {
            unresolved.push({ prospect_id: p._id, email: p.email, website: p.website ?? null, thread_url: p.thread_url });
          }
          continue;
        }
        if (!candidates.has(domain)) {
          candidates.set(domain, { domain, prospect_email: p.email, prospect_id: p._id, thread_url: p.thread_url });
        }
      }

      // Deliberately NOT max_pages: that bounds the MasterInbox prospect scan,
      // which is a different endpoint with a different page size and a hard
      // 10k ceiling. Sharing one number silently truncated Ujet's blocklist.
      let existing = new Set(), sample = null, blTruncated = false, blStalled = false,
          pagination = null, blRowsRead = 0, blReportedTotal = null, blPageSize = null;
      const blocklistRead = candidates.size > 0;
      if (blocklistRead) {
        ({ domains: existing, sample, truncated: blTruncated, stalled: blStalled, pagination,
           rows_read: blRowsRead, reported_total: blReportedTotal, page_size: blPageSize } =
          await fetchExistingBlocklist(client));
      }

      if (existing.size > 0) {
        const fingerprint = `${existing.size}|${sample?.id ?? "?"}|${[...existing].sort()[0]}`;
        const owner = seenBlocklists.get(fingerprint);
        if (owner) {
          entry.error =
            `Refusing to act. The blocklist returned for ${client.name} (eb_ws_id ${client.eb_ws_id}) is identical to the one ` +
            `returned for ${owner} — same size (${existing.size}) and same first row. Two different workspaces cannot have the ` +
            `same blocklist by coincidence; one of these requests was answered in the wrong workspace. Fix the workspace switch ` +
            `before writing anything for either client.`;
          entry.collides_with = owner;
          results.push(entry);
          continue;
        }
        seenBlocklists.set(fingerprint, client.name);
      }

      const toBlock = new Map(); // domain -> evidence
      for (const [domain, evidence] of candidates) {
        if (existing.has(domain)) { skipped["already in Bison blocklist"] = (skipped["already in Bison blocklist"] ?? 0) + 1; continue; }
        toBlock.set(domain, evidence);
      }

      // The full diff is always reported. `limit` only caps what gets WRITTEN,
      // so a capped run still tells you the whole truth about what it saw.
      const fullDiff = [...toBlock.keys()];
      let writeSet   = toBlock;
      // `limit` is a budget for the WHOLE RUN, not per client. Per-client was the
      // original behaviour and it silently contradicted the documented meaning:
      // --limit 1 across 18 clients with diffs would have written 18 domains,
      // which is exactly the surprise you do not want from the flag whose whole
      // purpose is bounding an irreversible first write.
      if (Number.isFinite(limit) && limit >= 0) {
        const take = Math.max(0, Math.min(limit - budgetSpent, fullDiff.length));
        if (take < fullDiff.length) {
          writeSet = new Map(fullDiff.slice(0, take).map(d => [d, toBlock.get(d)]));
          entry.limited = {
            run_cap: limit,
            already_written_this_run: budgetSpent,
            writing: take,
            held_back: fullDiff.length - take,
            note: "Capped by the run-wide `limit`. Re-run without it to write the rest.",
          };
        }
        budgetSpent += take;
      }

      const cl      = clientLedger(ledger, client.name);
      const added   = [];
      const failed  = [];

      // ── Dedupe integrity check ────────────────────────────────────────────
      // The "already blocked" skip is only as good as the GET. If the read path
      // silently returns nothing, an empty blocklist and a broken reader look
      // identical from here — and a nightly job would re-POST the same domains
      // forever without anyone noticing.
      //
      // The ledger is the independent witness: it records what we wrote. If it
      // says we blocked domains for this client and the GET now returns none of
      // them, something is wrong — either the reader is broken, or the blocklist
      // was cleared outside this tool. Both warrant a human, not another write.
      const ledgerLive = Object.entries(cl.blocked)
        .filter(([, v]) => v.mode === "live")
        .map(([d]) => d);
      if (!dry_run && ledgerLive.length > 0 && !ledgerLive.some(d => existing.has(d))) {
        entry.error =
          `Refusing to write. The ledger records ${ledgerLive.length} domain(s) blocked for ${client.name} in earlier runs, ` +
          `but GET /blacklisted-domains returned ${existing.size} entries and none of them match. ` +
          `Either the read path is broken (every run would re-submit the same domains) or the blocklist was cleared ` +
          `outside this tool. Investigate before writing again — re-run as a dry run to inspect.`;
        entry.ledger_expects   = ledgerLive.slice(0, 10);
        entry.would_block      = fullDiff;
        entry.prospects_scanned = scan.seen;
        entry.booked_matched   = scan.matched;
        results.push(entry);
        continue;
      }

      if (!dry_run && use_bulk && writeSet.size > 1) {
        const res = await bulkAddDomainsToBlocklist(client, [...writeSet.keys()], { skip_webhooks });
        entry.bulk = { status: res.status, uploaded: res.uploaded, warning: res.warning };
        // `verified` is authoritative: the upload can 200 and still drop rows.
        const landed = new Set(res.verified ?? (res.ok ? [...writeSet.keys()] : []));
        for (const [domain, evidence] of writeSet) {
          if (landed.has(domain)) {
            cl.blocked[domain] = { at: Date.now(), ...evidence, mode: "live", via: "bulk" };
            added.push(domain);
          } else {
            failed.push({ domain, via: "bulk", status: res.status, error: res.error ?? res.warning ?? "not present after upload" });
          }
        }
      } else if (!dry_run) {
        for (const [domain, evidence] of writeSet) {
          const res = await addDomainToBlocklist(client, domain, { skip_webhooks });
          if (res.ok) {
            cl.blocked[domain] = { at: Date.now(), ...evidence, mode: "live", via: "single" };
            added.push(domain);
          } else {
            failed.push({ domain, via: "single", status: res.status, error: res.error });
          }
        }
      } else {
        for (const [domain, evidence] of writeSet) {
          cl.blocked[domain] ??= { at: Date.now(), ...evidence, mode: "dry_run" };
        }
      }

      cl.last_run_at    = started;
      cl.skipped_counts = skipped;

      Object.assign(entry, {
        prospects_scanned:      scan.seen,
        prospects_total:        scan.reportedTotal,
        scan_complete:          scan.complete,
        scan_unreachable:       scan.unreachable,
        scan_window_capped:     scan.windowCapped,
        matched_label:          scan.labelName,
        booked_matched:         scan.matched,
        page_limit_hit:         scan.truncated,
        label_census:           scan.labelCensus,
        existing_blocklist:     existing.size,
        existing_row_sample:    sample,
        blocklist_pagination:   pagination,
        blocklist_truncated:    blTruncated,
        blocklist_stalled:      blStalled,
        blocklist_rows_read:    blRowsRead,
        blocklist_page_size:    blPageSize,
        blocklist_read:         blocklistRead,
        blocklist_reported_total: blReportedTotal,
        would_block:            fullDiff,
        unresolved,
        blocked:                added,
        failed,
        skipped,
      });
      if (!scan.complete && scan.reportedTotal != null) {
        entry.warning = scan.windowCapped
          ? `Scanned ${scan.seen} of ${scan.reportedTotal} prospects. The remaining ${scan.unreachable} sit past MasterInbox's ` +
            `${MI_RESULT_WINDOW}-result window and cannot be reached by offset paging at all — raising max_pages will error, not help. ` +
            `Any booked meeting in that tail is invisible to this reconciler.`
          : `Scanned ${scan.seen} of ${scan.reportedTotal} prospects — booked meetings in the unscanned remainder were missed. Raise max_pages.`;
      }
      if (scan.truncated) {
        entry.warning = `Stopped at the ${max_pages}-page bound — this client was NOT fully scanned. Raise max_pages or fix server-side label filtering.`;
      }
      if (blTruncated) {
        entry.blocklist_warning = `Only read ${max_pages} pages of the existing blocklist, so the "already blocked" check is incomplete — some domains here may be re-submitted. Raise max_pages for an exact diff.`;
      }
      // A zero match against a non-empty workspace is the failure mode that cost
      // us the first live run. Say so plainly and hand over the evidence needed
      // to fix it, rather than reporting a clean-looking no-op.
      if (scan.seen > 0 && scan.matched === 0) {
        const near = scan.labelCensus.filter(l => l.label.toLowerCase().includes("meeting")).map(l => l.label);
        entry.notice =
          `Scanned ${scan.seen} prospects and none carried a label named "${scan.labelName}". ` +
          (near.length ? `Similar labels present: ${near.join(", ")}. ` : "No label with 'meeting' in the name is present at all. ") +
          `Check label_census for the exact spelling in this workspace and pass label_name to match it.`;
      }
    } catch (e) {
      entry.error = e.message;
    }
    results.push(entry);
  }

  saveLedger(ledger);

  return {
    mode: dry_run ? "DRY RUN — nothing was written to Bison" : "LIVE",
    label: `matched by name: "${label_name}" (MasterInbox catalog ID ${MEETING_BOOKED_CATALOG_ID} does not appear on prospects — see the note in dnc.js)`,
    ran_at: new Date(started).toISOString(),
    write_path: use_bulk ? "POST /blacklisted-domains/bulk (multipart CSV)" : "POST /blacklisted-domains (one per domain)",
    skip_webhooks,
    ledger_path: LEDGER_PATH,
    totals: {
      clients:      results.length,
      would_block:  results.reduce((n, r) => n + (r.would_block?.length ?? 0), 0),
      blocked:      results.reduce((n, r) => n + (r.blocked?.length ?? 0), 0),
      failed:       results.reduce((n, r) => n + (r.failed?.length ?? 0), 0),
      errored:      results.filter(r => r.error).length,
    },
    results,
  };
}

/** Read-only view of what the reconciler has done so far. */
export function dncStatus({ client_name } = {}) {
  const ledger = loadLedger();
  const names  = client_name ? [getClient(client_name).name] : Object.keys(ledger.clients);
  return {
    ledger_path: LEDGER_PATH,
    clients: names.map(n => {
      const cl = ledger.clients[n] ?? { blocked: {}, last_run_at: null, skipped_counts: {} };
      const rows = Object.entries(cl.blocked);
      return {
        client: n,
        last_run_at: cl.last_run_at ? new Date(cl.last_run_at).toISOString() : null,
        total_domains: rows.length,
        live: rows.filter(([, v]) => v.mode === "live").length,
        dry_run_only: rows.filter(([, v]) => v.mode === "dry_run").length,
        skipped_counts: cl.skipped_counts,
        recent: rows.sort((a, b) => b[1].at - a[1].at).slice(0, 10)
          .map(([d, v]) => ({ domain: d, at: new Date(v.at).toISOString(), mode: v.mode, prospect_email: v.prospect_email })),
      };
    }),
  };
}
