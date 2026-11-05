// ── infra.js ─────────────────────────────────────────────────────────────────
// Self-sufficient infrastructure layer for the Infra agent — no external MCP.
// Talks directly to the registrar (NameSilo or Porkbun, selectable) and to
// Inboxing, using the keys already in .env. Registrar interface is unified so
// the agent tools are registrar-agnostic.
//
// Env:
//   INFRA_REGISTRAR        "namesilo" (default) | "porkbun"
//   NAMESILO_API_KEY
//   PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY
//   INBOXING_API_KEY, INBOXING_API_BASE_URL

export const INFRA_REGISTRAR = (process.env.INFRA_REGISTRAR || "namesilo").toLowerCase();

// ── NameSilo (GET API, ?type=json, reply.code 300 == success) ────────────────
const NS_BASE = "https://www.namesilo.com/api";

async function namesilo(operation, params = {}) {
  const key = process.env.NAMESILO_API_KEY;
  if (!key) throw new Error("NAMESILO_API_KEY is not set");
  const qs = new URLSearchParams({ version: "1", type: "json", key, ...params });
  const res = await fetch(`${NS_BASE}/${operation}?${qs.toString()}`);
  const data = await res.json();
  const reply = data?.reply ?? {};
  if (String(reply.code) !== "300") {
    throw new Error(`NameSilo ${operation} failed (code ${reply.code}): ${reply.detail || "unknown"}`);
  }
  return reply;
}

const namesiloRegistrar = {
  name: "namesilo",
  async checkAvailability(domains) {
    const reply = await namesilo("checkRegisterAvailability", { domains: domains.join(",") });
    const avail = [].concat(reply.available?.domain ?? reply.available ?? []);
    const unavail = [].concat(reply.unavailable?.domain ?? reply.unavailable ?? []);
    return {
      available: avail.map(d => (typeof d === "string" ? { domain: d } : { domain: d.domain, price: d.price, renew: d.renew })),
      unavailable: unavail.map(d => (typeof d === "string" ? d : d.domain)),
      errors: [],   // NameSilo checks the batch in one call: it throws on failure rather than per-domain
    };
  },
  async registerDomain({ domain, years = 1, nameservers }) {
    const params = { domain, years: String(years), private: "1", auto_renew: "0" };
    (nameservers || []).forEach((ns, i) => { params[`ns${i + 1}`] = ns; });
    const reply = await namesilo("registerDomain", params);
    return { domain, registrar: "namesilo", amount: reply.order_amount, message: reply.message ?? reply.detail };
  },
  async updateNameservers({ domain, nameservers }) {
    if (!nameservers || nameservers.length < 2) throw new Error("NameSilo requires at least 2 nameservers");
    const params = { domain };
    nameservers.forEach((ns, i) => { params[`ns${i + 1}`] = ns; });
    await namesilo("changeNameServers", params);
    return { domain, registrar: "namesilo", nameservers, updated: true };
  },
  async getDomain(domain) {
    const reply = await namesilo("getDomainInfo", { domain });
    const ns = [].concat(reply.nameservers?.nameserver ?? []);
    return {
      domain, registrar: "namesilo", status: reply.status, expires: reply.expires,
      traffic_type: reply.traffic_type,
      // Portfolios are a NameSilo-only concept; "N/A" means unassigned.
      portfolio: reply.portfolio && reply.portfolio !== "N/A" ? reply.portfolio : null,
      nameservers: ns.map(n => (typeof n === "string" ? n : n.nameserver ?? n["#text"] ?? n)),
    };
  },
  async getBalance() {
    const reply = await namesilo("getAccountBalance");
    return { registrar: "namesilo", balance: reply.balance };
  },
};

// ── Porkbun (v3 REST, header auth, status SUCCESS/ERROR, prices in pennies) ───
const PB_BASE = "https://api.porkbun.com/api/json/v3";

async function porkbun(path, body = {}) {
  const apikey = process.env.PORKBUN_API_KEY;
  const secretapikey = process.env.PORKBUN_SECRET_API_KEY;
  if (!apikey || !secretapikey) throw new Error("PORKBUN_API_KEY / PORKBUN_SECRET_API_KEY not set");
  const res = await fetch(`${PB_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apikey, secretapikey, ...body }),
  });
  const data = await res.json();
  if (data?.status && data.status !== "SUCCESS") {
    throw new Error(`Porkbun ${path} failed: ${data.message || data.code || "unknown"}`);
  }
  return data;
}

const porkbunRegistrar = {
  name: "porkbun",
  // Porkbun checks one domain per call (rate-limited); loop and normalize.
  async checkAvailability(domains) {
    // A failed request must NOT be reported as "unavailable" — that made a bad
    // key, a rate limit, or a network blip indistinguishable from "taken", so
    // a caller sourcing domains would silently skip ones that are actually free.
    const available = [], unavailable = [], errors = [];
    for (const domain of domains) {
      try {
        const d = await porkbun(`/domain/checkDomain/${domain}`);
        const r = d.response ?? {};
        if (r.avail === "yes" || r.available === "yes") {
          available.push({ domain, price: r.price, renew: r.regularPrice ?? r.renew });
        } else {
          unavailable.push(domain);
        }
      } catch (e) {
        errors.push({ domain, error: e.message });
      }
    }
    // Every lookup failing is a credential/connectivity problem, not a result.
    // Throwing beats handing back an empty list that reads like "nothing free".
    if (errors.length === domains.length && domains.length > 0) {
      throw new Error(
        `Porkbun availability check failed for all ${domains.length} domain(s) — ` +
        `likely credentials or rate limiting. First error: ${errors[0].error}`
      );
    }
    return { available, unavailable, errors };
  },
  async registerDomain({ domain, whoisPrivacy = true }) {
    // Porkbun requires the exact current price (pennies) — fetch it first.
    const check = await porkbun(`/domain/checkDomain/${domain}`);
    const priceUsd = check?.response?.price;
    if (priceUsd == null) throw new Error(`Porkbun: no price for ${domain} (may be unavailable/premium)`);
    const cost = Math.round(parseFloat(priceUsd) * 100);
    const d = await porkbun(`/domain/create/${domain}`, { cost, agreeToTerms: "yes", whoisPrivacy });
    return { domain, registrar: "porkbun", amount: (d.cost / 100).toFixed(2), orderId: d.orderId };
  },
  async updateNameservers({ domain, nameservers }) {
    await porkbun(`/domain/updateNs/${domain}`, { ns: nameservers });
    return { domain, registrar: "porkbun", nameservers, updated: true };
  },
  async getDomain(domain) {
    const list = await porkbun(`/domain/listAll`, { domain });
    const rec = (list.domains || [])[0] || {};
    let ns = [];
    try { ns = (await porkbun(`/domain/getNs/${domain}`)).ns ?? []; } catch { /* ignore */ }
    return { domain, registrar: "porkbun", status: rec.status, expires: rec.expireDate, nameservers: ns };
  },
  async getBalance() {
    // Porkbun exposes balance via /pricing or account endpoints; ping confirms auth.
    await porkbun(`/ping`);
    return { registrar: "porkbun", balance: "see porkbun.com/account (not exposed via this endpoint)" };
  },
};

// ── Dynadot (RESTful v1 — Bearer key + HMAC-SHA256 X-Signature) ──────────────
// Unlike NameSilo/Porkbun, every request is signed: X-Signature is
// base64(HMAC-SHA256(secret, apiKey \n pathAndQuery \n requestId \n body)).
// Each request also needs a UNIQUE X-Request-ID — Dynadot rejects a reused one
// with "this request ID has been assigned to another request already".
// Base is /restful/v1: the documented v2 rejects production keys today.
// Dynadot also serves one request at a time; concurrency earns a 10-min ban,
// so callers must stay sequential.
const DYNADOT_BASE = (process.env.DYNADOT_API_BASE_URL || "https://api.dynadot.com/restful/v1")
  .replace(/\/$/, "");
const DYNADOT_HOST = DYNADOT_BASE.replace(/\/restful\/v\d+$/, "");
const DYNADOT_PREFIX = DYNADOT_BASE.slice(DYNADOT_HOST.length);

async function dynadot(path, { method = "GET", body } = {}) {
  const key = process.env.DYNADOT_API_KEY;
  const secret = process.env.DYNADOT_API_SECRET;
  if (!key || !secret) throw new Error("DYNADOT_API_KEY / DYNADOT_API_SECRET not set");

  const { randomUUID, createHmac } = await import("crypto");
  const fullPath = `${DYNADOT_PREFIX}${path}`;
  const requestId = randomUUID();
  const payload = body ? JSON.stringify(body) : "";
  const signature = createHmac("sha256", secret)
    .update([key, fullPath, requestId, payload].join("\n"), "utf8")
    .digest("base64");

  const res = await fetch(`${DYNADOT_HOST}${fullPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "X-Signature": signature,
      "X-Request-ID": requestId,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: payload || undefined,
  });

  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  // Dynadot returns HTTP 200 with the real status in the body, so the HTTP
  // code alone is not a success signal — check data.code too.
  const code = data?.code ?? res.status;
  if (code !== 200) {
    throw new Error(`Dynadot ${method} ${path} → ${code}: ${data?.error?.description ?? data?.message ?? text.slice(0, 160)}`);
  }
  return data.data ?? data;
}

const dynadotRegistrar = {
  name: "dynadot",
  // One domain per call, like Porkbun. Errors are kept separate from
  // "unavailable" so a failure never reads as "taken".
  async checkAvailability(domains) {
    const available = [], unavailable = [], errors = [];
    for (const domain of domains) {
      try {
        const d = await dynadot(`/domains/${encodeURIComponent(domain)}/search`);
        const avail = String(d?.available ?? "").toLowerCase() === "yes";
        if (avail) available.push({ domain, price: d.price ?? null, renew: d.renew ?? null });
        else unavailable.push(domain);
      } catch (e) {
        errors.push({ domain, error: e.message });
      }
    }
    if (errors.length === domains.length && domains.length > 0) {
      throw new Error(`Dynadot availability check failed for all ${domains.length} domain(s). First error: ${errors[0].error}`);
    }
    return { available, unavailable, errors };
  },
  async registerDomain({ domain, years = 1 }) {
    const d = await dynadot(`/domains/${encodeURIComponent(domain)}/register`, {
      method: "POST", body: { duration: String(years) },
    });
    return { domain, registrar: "dynadot", amount: d?.price ?? d?.amount ?? null, message: d?.message ?? "registered" };
  },
  async updateNameservers({ domain, nameservers }) {
    if (!nameservers || nameservers.length < 2) throw new Error("Dynadot requires at least 2 nameservers");
    // Verified against the live API: method is PUT (POST answers "command not
    // recognized") and the body key is `nameserver_list` holding PLAIN STRINGS
    // (an array of {host} objects is rejected: "Expected a string value, but
    // received an object"). The GET on this same path returns {host, ns_name}
    // objects, which is what made the write shape easy to get wrong.
    await dynadot(`/domains/${encodeURIComponent(domain)}/nameservers`, {
      method: "PUT",
      body: { nameserver_list: nameservers.map(n => (typeof n === "string" ? n : n.host ?? n.server_name)) },
    });
    return { domain, registrar: "dynadot", nameservers, updated: true };
  },
  async getDomain(domain) {
    // There is no /domains/{d}/info route (it answers "command not recognized").
    // Nameservers come from /domains/{d}/nameservers, which returns
    // { name_servers: [{ host, ns_name }] }; status/expiry only appear in the
    // account-wide /domains listing, so fetch that and pick this domain out.
    const ns = await dynadot(`/domains/${encodeURIComponent(domain)}/nameservers`);
    const hosts = (ns?.name_servers ?? []).map(n => n.host ?? n.server_name ?? n).filter(Boolean);

    let status, expires;
    try {
      const list = await dynadot("/domains");
      const rec = (list?.domainInfo ?? []).find(
        d => String(d.domainName ?? "").toLowerCase() === domain.toLowerCase()
      );
      if (rec) { status = rec.status ?? "Active"; expires = rec.expiration ?? null; }
    } catch { /* nameservers already retrieved; listing is best-effort */ }

    return { domain, registrar: "dynadot", status, expires, nameservers: hosts };
  },
  async getBalance() {
    // Dynadot exposes no balance endpoint; prove credentials instead.
    await dynadot("/domains");
    return { registrar: "dynadot", balance: "not exposed via API (see dynadot.com account)" };
  },
};

// ── NameSilo portfolios (NameSilo-only — no Porkbun/Dynadot equivalent) ──────
// Portfolios group DOMAINS for organisation. They do not affect DNS, mailboxes
// or billing, and a domain can sit in at most one.
export async function listPortfolios() {
  const reply = await namesilo("portfolioList");
  const p = reply.portfolios;
  const names = Array.isArray(p) ? p : (p ? [p] : []);
  return { portfolios: names.flatMap(x => (typeof x === "string" ? [x] : Object.values(x))) };
}

// NameSilo takes a comma-separated list, so this is a handful of calls rather
// than one per domain. Re-assigning a domain that is already in the portfolio
// is a no-op, which is why there is no "find the unassigned ones" step —
// listDomains does not return the portfolio field, so filtering first would
// cost one lookup per domain (1000+ on this account).
const PORTFOLIO_CHUNK = 100;

export async function assignPortfolio({ portfolio, domains, verify_sample = 3 }) {
  if (!portfolio) throw new Error("portfolio is required");
  if (!Array.isArray(domains) || !domains.length) throw new Error("domains must be a non-empty array");

  const batches = [];
  for (let i = 0; i < domains.length; i += PORTFOLIO_CHUNK) {
    const chunk = domains.slice(i, i + PORTFOLIO_CHUNK);
    try {
      const reply = await namesilo("portfolioDomainAssociate", { portfolio, domains: chunk.join(",") });
      batches.push({ count: chunk.length, ok: true, message: reply.message ?? reply.detail });
    } catch (e) {
      batches.push({ count: chunk.length, ok: false, error: e.message, domains: chunk.slice(0, 10) });
    }
  }

  // NameSilo answers "all supplied domains belonging to your account have been
  // updated" even when a name is not on the account, so the message alone does
  // not prove anything landed — read a few back.
  const verified = [];
  for (const d of domains.slice(0, Math.max(0, verify_sample))) {
    try {
      const info = await getDomain({ domain: d, registrar: "namesilo" });
      verified.push({ domain: d, portfolio: info.portfolio, matches: info.portfolio === portfolio });
    } catch (e) { verified.push({ domain: d, error: e.message }); }
  }

  return {
    portfolio,
    requested: domains.length,
    batches,
    failed_batches: batches.filter(b => !b.ok).length,
    verified,
  };
}

// ── Registrar dispatch (unified interface) ───────────────────────────────────
// INFRA_REGISTRAR is only the DEFAULT. Every call may name a registrar instead,
// so both can be used in one server run — previously the env var was read once
// at module load, which locked the whole process to a single registrar.
export const REGISTRARS = ["namesilo", "porkbun", "dynadot"];

export function registrar(name) {
  const which = (name ?? INFRA_REGISTRAR ?? "namesilo").toLowerCase();
  if (!REGISTRARS.includes(which)) {
    throw new Error(`Unknown registrar "${which}". Expected one of: ${REGISTRARS.join(", ")}.`);
  }
  if (which === "porkbun") return porkbunRegistrar;
  if (which === "dynadot") return dynadotRegistrar;
  return namesiloRegistrar;
}

export const checkAvailability   = (args) => registrar(args?.registrar).checkAvailability(args.domains);
export const registerDomain      = (args) => registrar(args?.registrar).registerDomain(args);
export const updateNameservers   = (args) => registrar(args?.registrar).updateNameservers(args);
export const getDomain           = (args) => registrar(args?.registrar).getDomain(args.domain);
export const getRegistrarBalance = (args) => registrar(args?.registrar).getBalance();

// ── Inboxing (mailbox provisioning — Inboxing API v2) ────────────────────────
// Auth: X-API-Key header. Base includes /api/v2. Set INBOXING_API_BASE_URL to
// your account's API base (dashboard host + /api/v2).
const INBOXING_BASE = (process.env.INBOXING_API_BASE_URL || "https://app.inboxing.com/api/v2").replace(/\/$/, "");

async function inboxing(method, path, body) {
  const key = process.env.INBOXING_API_KEY;
  if (!key) throw new Error("INBOXING_API_KEY is not set");
  const res = await fetch(`${INBOXING_BASE}${path}`, {
    method,
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`Inboxing ${method} ${path} → HTTP ${res.status}: ${data.error || data.message || text.slice(0, 160)}`);
  return data;
}

// POST /domains — user_count must be 25 | 49 | 99; names is required (looped to
// fill user_count). Optional: tags, cloudflare_credential_id, registrar_credential_id
// (enables automatic NS update), upload_to_platform + platform_connection_id.
export async function inboxingSubmitDomain({ domain, user_count = 49, names, tags, cloudflare_credential_id, registrar_credential_id }) {
  const body = { domain, user_count, names };
  if (tags) body.tags = tags;
  if (cloudflare_credential_id) body.cloudflare_credential_id = cloudflare_credential_id;
  if (registrar_credential_id) body.registrar_credential_id = registrar_credential_id;
  return inboxing("POST", "/domains", body);
}
// GET /domains/{id}/status — status, nameservers, nameservers_auto_updated,
// csv_available, setup_stage, latest_job, failure_reason.
export async function inboxingCheckStatus({ domain_id }) {
  return inboxing("GET", `/domains/${encodeURIComponent(domain_id)}/status`);
}
// Inboxing paginates /domains (per_page default 50). Pass page to fetch a
// specific page, or all:true to walk every page (guarded by maxPages) and
// return the combined list plus a truncated flag.
export async function inboxingListDomains({ page, all, maxPages = 20 } = {}) {
  if (!all) {
    const qs = page ? `?page=${page}` : "";
    return inboxing("GET", `/domains${qs}`);
  }
  const first = await inboxing("GET", `/domains?page=${page || 1}`);
  const rows = [...(first?.data ?? [])];
  const totalPages = first?.pagination?.pages ?? 1;
  const startPage = page || 1;
  const stopAt = Math.min(totalPages, startPage + maxPages - 1);
  let pagesFetched = 1;
  for (let p = startPage + 1; p <= stopAt; p++) {
    const r = await inboxing("GET", `/domains?page=${p}`);
    rows.push(...(r?.data ?? []));
    pagesFetched++;
  }
  return {
    data: rows,
    pagination: first?.pagination ?? null,
    pages_fetched: pagesFetched,
    truncated: totalPages > stopAt,
  };
}
// GET /slots — { slots:{total,used,remaining,...}, system:{can_provision}, subscription_status }
export async function inboxingGetSlots() {
  return inboxing("GET", "/slots");
}
// GET /domains/{id}/csv — mailbox credentials CSV (returns raw text once ready).
export async function inboxingDownloadCsv({ domain_id }) {
  return inboxing("GET", `/domains/${encodeURIComponent(domain_id)}/csv`);
}
