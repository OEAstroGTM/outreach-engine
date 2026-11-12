// ── cheapinboxes.js ──────────────────────────────────────────────────────────
// Cheap Inboxes (https://cheapinboxes.com) — mailbox reseller, same role as
// Inboxing. Auth: Authorization: Bearer ci_live_*.
//
// READ-ONLY, with ONE cost-gated exception: buying mailboxes.
//
// Everything else that spends or mutates (wallet, pay-now, DNS edits, cancels,
// transfers, integrations) stays unimplemented — absent, not present-but-
// guarded, so an agent loop cannot invoke it. The single exception, added
// 2026-11-12 at the user's explicit request, is the quote→checkout pair at the
// bottom of this file. It is deliberately built so the free `quoteOrder` gates
// the paid `checkoutOrder`, and the index.js tool enforces three things the
// user asked for: a live re-quote, a hard max-spend ceiling, and an explicit
// per-call confirmation of the exact charge. No silent spend is possible.
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

// ── Writes: domain import (free) + buying mailboxes (cost-gated) ──────────────
// POST helper, kept separate from the GET `ci()` so the write path is obvious.
// `extraHeaders` carries the checkout Idempotency-Key. A body of undefined
// sends no JSON body (setup/nameservers is a bodyless POST).
async function ciWrite(method, path, body, extraHeaders = {}) {
  const k = key();
  if (!k) throw new Error("CHEAPINBOXES_API_KEY is not set");
  const res = await fetch(`${CHEAPINBOXES_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", Accept: "application/json", ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (res.status === 429) throw new Error("Cheap Inboxes rate limited (429) — back off before retrying");
  if (!res.ok || data?.error) {
    const msg = data?.error?.message ?? data?.message ?? data?.raw ?? "";
    throw new Error(`Cheap Inboxes ${method} ${path} → HTTP ${res.status}: ${msg}`);
  }
  return data;
}

// FREE. Stage domains we own for import. source_provider is an enum; "manual"
// or "external" fit a domain we registered elsewhere (e.g. NameSilo). Returns
// an import record per domain (its id becomes staged_import_id at checkout).
export async function importDomains({ domains, source_provider = "manual", metadata } = {}) {
  if (!Array.isArray(domains) || !domains.length) throw new Error("domains must be a non-empty array");
  return ciWrite("POST", "/v1/domain-imports/bulk", { domains, source_provider, ...(metadata ? { metadata } : {}) });
}

// After an order is paid, the 2 nameservers CheapInboxes assigns to an imported
// domain (point the registrar at these). Bodyless POST keyed on domain id.
export const getImportNameservers = ({ id }) => ciWrite("POST", `/v1/domains/${encodeURIComponent(id)}/setup/nameservers`);
// Order progress incl. `readiness` is the existing getOrder() in the reads section.

// Split "example.digital" → { name: "example", tld: "digital" }. The API wants
// the bare label and the TLD as separate fields.
function splitDomain(d) {
  if (d.tld && d.domain && !d.domain.includes(".")) return { name: d.domain, tld: d.tld };
  const full = String(d.domain || "").trim().toLowerCase();
  const i = full.lastIndexOf(".");
  if (i < 0) throw new Error(`domain "${full}" needs a TLD (e.g. example.com)`);
  return { name: full.slice(0, i), tld: full.slice(i + 1) };
}

// "Jane Doe" → { first_name:"Jane", last_name:"Doe", email_prefix:"jane.doe" }.
export function nameToAccount(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) throw new Error(`name "${name}" must be "First Last"`);
  const first = parts[0], last = parts.slice(1).join(" ");
  const prefix = `${first}.${last}`.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return { first_name: first, last_name: last, email_prefix: prefix };
}

// FREE. Maps a friendly [{domain, isExisting?, provider?, count}] into the
// quote cart and returns the quote. quote.totals.total_today_cents is the
// number that gates the purchase.
export async function quoteOrder({ domains, promo_code } = {}) {
  if (!Array.isArray(domains) || !domains.length) throw new Error("domains must be a non-empty array");
  const cart = {
    domains: domains.map(d => {
      const { name, tld } = splitDomain(d);
      return {
        domain: name, tld,
        isExisting: d.isExisting ?? true,
        ...(d.staged_import_id ? { staged_import_id: d.staged_import_id } : {}),
        mailboxes: { provider: d.provider ?? "google", count: Number(d.count) },
      };
    }),
  };
  const r = await ciWrite("POST", "/v1/orders/quote", { cart, promo_code: promo_code ?? null });
  return r.quote ?? r;
}

// SPENDS MONEY. Takes the same friendly domain shape as quoteOrder, but each
// domain carries `accounts` (from nameToAccount) instead of a bare count. The
// cost gate (re-quote, cap, confirmation) lives in the index.js tool and is
// the only caller — this just builds the API payload and sends it.
export async function checkoutOrder({ domains, promo_code, integration_id, name, fulfillment, preferred_mailbox_password, idempotency_key } = {}) {
  if (!Array.isArray(domains) || !domains.length) throw new Error("domains must be a non-empty array");
  const payload = {
    domains: domains.map(d => {
      const { name: dn, tld } = splitDomain(d);
      if (!Array.isArray(d.accounts) || !d.accounts.length) throw new Error(`domain ${dn}.${tld}: accounts required`);
      return {
        domain: dn, tld,
        isExisting: d.isExisting ?? true,
        ...(d.staged_import_id ? { staged_import_id: d.staged_import_id } : {}),
        mailboxes: { provider: d.provider ?? "google", accounts: d.accounts },
      };
    }),
    ...(promo_code ? { promo_code } : {}),
    ...(integration_id ? { integration_id } : {}),
    ...(name ? { name } : {}),
    ...(preferred_mailbox_password ? { preferred_mailbox_password } : {}),
    fulfillment: fulfillment ?? "diy",
  };
  // Idempotency-Key makes a retried checkout a no-op server-side instead of a
  // second charge. The tool reuses one key across its preview and its commit.
  const headers = idempotency_key ? { "Idempotency-Key": String(idempotency_key) } : {};
  return ciWrite("POST", "/v1/orders/checkout", payload, headers);
}
