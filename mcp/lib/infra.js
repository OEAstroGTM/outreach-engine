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
    const available = [], unavailable = [];
    for (const domain of domains) {
      try {
        const d = await porkbun(`/domain/checkDomain/${domain}`);
        const r = d.response ?? {};
        if (r.avail === "yes" || r.available === "yes") {
          available.push({ domain, price: r.price, renew: r.regularPrice ?? r.renew });
        } else {
          unavailable.push(domain);
        }
      } catch { unavailable.push(domain); }
    }
    return { available, unavailable };
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

// ── Registrar dispatch (unified interface) ───────────────────────────────────
export function registrar() {
  return INFRA_REGISTRAR === "porkbun" ? porkbunRegistrar : namesiloRegistrar;
}

export const checkAvailability   = (args) => registrar().checkAvailability(args.domains);
export const registerDomain      = (args) => registrar().registerDomain(args);
export const updateNameservers   = (args) => registrar().updateNameservers(args);
export const getDomain           = (args) => registrar().getDomain(args.domain);
export const getRegistrarBalance = ()     => registrar().getBalance();

// ── Inboxing (mailbox provisioning — Inboxing API v2) ────────────────────────
// Auth: X-API-Key header. Base includes /api/v2. Set INBOXING_API_BASE_URL to
// your account's API base (dashboard host + /api/v2).
//
// NOTE: the default must be the live dashboard host, v2.inboxing.com. The old
// app.inboxing.com default accepts the TCP connection but never responds, so
// Cloudflare eventually answers HTTP 522 — which reads like an Inboxing outage
// rather than a misconfigured base URL. Don't "fix" a 522 by waiting it out.
const INBOXING_BASE = (process.env.INBOXING_API_BASE_URL || "https://v2.inboxing.com/api/v2").replace(/\/$/, "");

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
export async function inboxingListDomains() {
  return inboxing("GET", "/domains");
}
// GET /slots — { slots:{total,used,remaining,...}, system:{can_provision}, subscription_status }
export async function inboxingGetSlots() {
  return inboxing("GET", "/slots");
}
// GET /domains/{id}/csv — mailbox credentials CSV (returns raw text once ready).
export async function inboxingDownloadCsv({ domain_id }) {
  return inboxing("GET", `/domains/${encodeURIComponent(domain_id)}/csv`);
}
