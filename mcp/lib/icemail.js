// ── icemail.js ───────────────────────────────────────────────────────────────
// Icemail (https://app.icemail.ai) — mailbox/domain reseller, same role as
// Inboxing and Cheap Inboxes. Auth: x-api-key header.
//
// READ-ONLY BY DESIGN. The API can place orders, top up the wallet, buy
// prewarm, export mailboxes to sequencers, edit DNS/DMARC/forwarding and delete
// domains and mailboxes — none of that is implemented here. Spending and
// mutation stay human decisions, so those calls are deliberately absent rather
// than present-but-guarded: a function that does not exist cannot be invoked by
// an agent loop.
//
// Endpoints intentionally OMITTED (spend / mutate): POST /order,
// POST /wallet/topup, POST /prewarm/buy, POST /export(+republish), and every
// POST/PUT/DELETE on domain, mailbox, dns-records, forwarding, dmarc, tags,
// workspace and webhook.
//
// Verified against the live API 2026-11-12: key resolves, workspace "Aemon
// Workspace" (OWNER). Envelope is { success, data, message }; list endpoints
// nest { <collection>, total_count, page, limit } under data.
import * as core from "./core.js";   // namespace import: runs dotenv, tolerates differing exports

export const ICEMAIL_BASE =
  (process.env.ICEMAIL_API_BASE_URL || "https://app.icemail.ai/api/v1").replace(/\/$/, "");

const key = () =>
  (typeof core.cockpitSecret === "function" ? core.cockpitSecret("__global__", "icemail") : undefined)
  ?? process.env.ICEMAIL_API_KEY;

const PAGE_LIMIT = 50;   // API caps `limit` at 50; pages are 1-based via `page`.

async function ic(path, query) {
  const k = key();
  if (!k) throw new Error("ICEMAIL_API_KEY is not set");

  const qs = new URLSearchParams();
  for (const [a, b] of Object.entries(query ?? {})) {
    if (b !== undefined && b !== null && b !== "") qs.set(a, String(b));
  }
  const url = `${ICEMAIL_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;

  const res = await fetch(url, { headers: { "x-api-key": k, Accept: "application/json" } });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }

  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new Error(`Icemail rate limited (429)${retry ? `; retry after ${retry}s` : ""} — back off before retrying`);
  }
  if (!res.ok || body?.success === false) {
    throw new Error(`Icemail GET ${path} → HTTP ${res.status}: ${body?.message ?? body?.raw ?? ""}`);
  }
  return body?.data ?? body;   // unwrap the { success, data, message } envelope
}

// Walk every page rather than returning the first 10/50 — list data nests as
// data.<collection> with a sibling data.total_count. Stops when we have them all.
async function paginate(path, collection, { all = true, max = Infinity, search, ...query } = {}) {
  const out = [];
  let page = 1, total = null;
  for (;;) {
    const d = await ic(path, { ...query, search, page, limit: PAGE_LIMIT });
    const rows = d?.[collection] ?? [];
    out.push(...rows);
    total = d?.total_count ?? out.length;
    if (!all || !rows.length || out.length >= total || out.length >= max) {
      return { [collection]: out.slice(0, max === Infinity ? undefined : max), total, fetched: out.length };
    }
    page++;
  }
}

// ── Workspace / wallet (read) ────────────────────────────────────────────────
export const listWorkspaces = () => ic("/workspace");
// A balance read — not a top-up. Returns { available, auto_topup, threshold, topup_amount }.
export const getWallet = () => ic("/wallet");

// ── Domains (read) ───────────────────────────────────────────────────────────
export const listDomains = (opts = {}) => paginate("/domain", "domains", opts);
export const getDomain = ({ id }) => ic(`/domain/${encodeURIComponent(id)}`);
// Availability is a lookup, not a purchase. `search` is the domain to check.
export const checkDomainAvailable = ({ search }) => ic("/domain/available", { search });
export const getDomainNsRecords = () => ic("/domain/ns-records");
export const getDomainDnsRecords = ({ id }) => ic(`/domain/${encodeURIComponent(id)}/dns-records`);
export const listDomainTags = () => ic("/domain/tags");
export const getDomainTag = ({ id }) => ic(`/domain/tags/${encodeURIComponent(id)}`);

// ── Mailboxes (read) ─────────────────────────────────────────────────────────
export const listMailboxes = (opts = {}) => paginate("/mailbox", "mailboxes", opts);
export const getMailbox = ({ id }) => ic(`/mailbox/${encodeURIComponent(id)}`);
export const getMailboxesByDomain = ({ id }) => ic(`/mailbox/domain/${encodeURIComponent(id)}`);
// A price quote is not a purchase. Returns { direct, bundles }.
export const mailboxPrice = () => ic("/mailbox/price");
// These two return LIVE sending credentials — treat the result as secret.
export const getMailboxAuth = ({ id }) => ic(`/mailbox/${encodeURIComponent(id)}/auth`);
export const getMailboxAppPassword = ({ id }) => ic(`/mailbox/${encodeURIComponent(id)}/app-password`);
export const listMailboxTags = () => ic("/mailbox/tags");
export const getMailboxTag = ({ id }) => ic(`/mailbox/tags/${encodeURIComponent(id)}`);

// ── Prewarm / exports / webhooks (read) ──────────────────────────────────────
export const listPrewarm = () => ic("/prewarm");            // { domains, total }
export const getExport = ({ id }) => ic(`/export/${encodeURIComponent(id)}`);
export const listWebhooks = () => ic("/webhook");
