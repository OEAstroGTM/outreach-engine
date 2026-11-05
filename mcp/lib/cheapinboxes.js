// ── cheapinboxes.js ──────────────────────────────────────────────────────────
// Cheap Inboxes (https://cheapinboxes.com) — mailbox reseller, same role as
// Inboxing. Auth: Authorization: Bearer ci_live_*.
//
// READ-ONLY BY DESIGN. The API can place orders, provision mailboxes, pay
// invoices, edit DNS and cancel paid resources; none of that is implemented
// here. Spending stays a human decision, so the write calls are deliberately
// absent rather than present-but-guarded — a function that does not exist
// cannot be invoked by an agent loop.
//
// Verified against the live API 2026-10-27: org resolves, 886 domains and
// 4,185 mailboxes on the account.
import * as core from "./core.js";   // namespace import: runs dotenv, tolerates differing exports

export const CHEAPINBOXES_BASE =
  (process.env.CHEAPINBOXES_API_BASE_URL || "https://api.cheapinboxes.com").replace(/\/$/, "");

const key = () =>
  (typeof core.cockpitSecret === "function" ? core.cockpitSecret("__global__", "cheapinboxes") : undefined)
  ?? process.env.CHEAPINBOXES_API_KEY;

const PAGE_LIMIT = 50;   // API default; responses carry {total, limit, offset, has_more}

async function ci(path, query) {
  const k = key();
  if (!k) throw new Error("CHEAPINBOXES_API_KEY is not set");

  const qs = new URLSearchParams();
  for (const [a, b] of Object.entries(query ?? {})) {
    if (b !== undefined && b !== null && b !== "") qs.set(a, String(b));
  }
  const url = `${CHEAPINBOXES_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${k}`, Accept: "application/json" } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }

  if (res.status === 429) throw new Error("Cheap Inboxes rate limited (429) — back off before retrying");
  if (!res.ok || data?.error) {
    const msg = data?.error?.message ?? data?.message ?? data?.raw ?? "";
    throw new Error(`Cheap Inboxes GET ${path} → HTTP ${res.status}: ${msg}`);
  }
  return data;
}

// Walk every page instead of returning the first 50 of 886 — the exact bug
// that made inboxingListDomains() silently report 50 of 406.
async function paginate(path, collection, { all = true, max = Infinity, ...query } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await ci(path, { ...query, limit: PAGE_LIMIT, offset });
    const rows = page?.[collection] ?? [];
    out.push(...rows);
    const p = page?.pagination;
    if (!all || !rows.length || !p?.has_more || out.length >= max) {
      return { [collection]: out.slice(0, max === Infinity ? undefined : max), total: p?.total ?? out.length, fetched: out.length };
    }
    offset += rows.length;
  }
}

// ── Org / usage ──────────────────────────────────────────────────────────────
export const getOrg = () => ci("/v1/org");
export const listOrgMembers = () => ci("/v1/org/members");

// NOTE: /v1/usage returned {"code":"BACKEND_ERROR"} on 2026-10-27 — a provider-
// side fault, not a bad key. Surfaced rather than swallowed.
export const getUsage = () => ci("/v1/usage");

// ── Domains ──────────────────────────────────────────────────────────────────
// `tags` is a comma-separated list matching ANY of them. Prefer the computed
// `readiness` object over parsing `status`.
export const listDomains = (opts = {}) => paginate("/v1/domains", "domains", opts);
export const getDomain = ({ id }) => ci(`/v1/domains/${encodeURIComponent(id)}`);
export const getDomainDnsRecords = ({ id }) => ci(`/v1/domains/${encodeURIComponent(id)}/dns-records`);
export const getDomainDnsHealth = ({ id }) => ci(`/v1/domains/${encodeURIComponent(id)}/dns-health`);
export const getDomainDmarc = ({ id }) => ci(`/v1/domains/${encodeURIComponent(id)}/dmarc`);
export const getDomainRuns = ({ id }) => ci(`/v1/domains/${encodeURIComponent(id)}/runs`);
export const listDomainTags = () => ci("/v1/domains/tags");

// ── Mailboxes ────────────────────────────────────────────────────────────────
export const listMailboxes = (opts = {}) => paginate("/v1/mailboxes", "mailboxes", opts);
export const getMailbox = ({ id }) => ci(`/v1/mailboxes/${encodeURIComponent(id)}`);
// Returns live sending credentials — treat the result as secret.
export const getMailboxCredentials = ({ id }) => ci(`/v1/mailboxes/${encodeURIComponent(id)}/credentials`);
export const getMailboxAppPasswordStatus = ({ id }) => ci(`/v1/mailboxes/${encodeURIComponent(id)}/app-password`);

// ── Orders (read) ────────────────────────────────────────────────────────────
export const listOrders = (opts = {}) => paginate("/v1/orders", "orders", opts);
export const getOrder = ({ id }) => ci(`/v1/orders/${encodeURIComponent(id)}`);

// ── Integrations / events / billing (read) ───────────────────────────────────
export const listIntegrations = () => ci("/v1/integrations");
export const listEvents = (opts = {}) => paginate("/v1/events", "events", opts);
export const billingSummary = () => ci("/v1/billing/summary");
export const listInvoices = (opts = {}) => paginate("/v1/billing/invoices", "invoices", opts);

// ── Discovery / pricing (read — a quote is not a purchase) ───────────────────
export const mailboxPricing = () => ci("/v1/discovery/pricing/mailboxes");
export const tldPricing = () => ci("/v1/discovery/tlds");
