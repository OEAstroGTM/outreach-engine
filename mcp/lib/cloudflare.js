// ── cloudflare.js ────────────────────────────────────────────────────────────
// Cloudflare DNS.
//
// Reads are unrestricted. Writes are deliberately NARROW: only the four record
// kinds that decide whether mail is delivered and trusted — SPF, DKIM, DMARC,
// MX. Everything else (A, NS, arbitrary CNAME, zone settings, zone deletion)
// stays out of reach, because a wrong edit there breaks a live domain silently
// and the token has account-wide #zone:edit. Narrow tools beat a general record
// editor guarded only by good intentions.
//
// Auth: account-owned tokens ("cfat…") must be verified against /accounts —
// /user/tokens/verify is user-token-only and 401s on a perfectly valid
// account token.
//
// SCOPE WARNING: this reaches only zones in YOUR Cloudflare account. Inboxing
// and Cheap Inboxes provision domains into THEIR own Cloudflare accounts (you
// get their assigned nameserver pair, not the zone), so those domains are not
// visible here. As of 2026-10-30 this account holds exactly one zone.
import * as core from "./core.js";   // namespace import: runs dotenv, tolerates differing exports

export const CF_BASE = "https://api.cloudflare.com/client/v4";

const token = () =>
  (typeof core.cockpitSecret === "function" ? core.cockpitSecret("__global__", "cloudflare") : undefined)
  ?? process.env.CLOUDFLARE_API_TOKEN;

const PER_PAGE = 50;

async function cf(path, query, { method = "GET", body } = {}) {
  const t = token();
  const email = process.env.CLOUDFLARE_EMAIL;
  const globalKey = process.env.CLOUDFLARE_API_KEY;
  if (!t && !(email && globalKey)) {
    throw new Error("CLOUDFLARE_API_TOKEN (or CLOUDFLARE_EMAIL + CLOUDFLARE_API_KEY) is not set");
  }

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const headers = t
    ? { Authorization: `Bearer ${t}` }
    : { "X-Auth-Email": email, "X-Auth-Key": globalKey };

  const res = await fetch(`${CF_BASE}${path}${qs.toString() ? `?${qs}` : ""}`, {
    method,
    headers: { ...headers, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }

  if (data?.success === false || !res.ok) {
    const e = (data?.errors ?? [])[0];
    throw new Error(`Cloudflare ${method} ${path} → HTTP ${res.status}: ${e?.message ?? data?.raw ?? ""}${e?.code ? ` (code ${e.code})` : ""}`);
  }
  return data;
}

// Cloudflare paginates with page/per_page + result_info.total_count.
async function paginate(path, { all = true, max = Infinity, ...query } = {}) {
  const out = [];
  let page = 1, total = null;
  for (;;) {
    const r = await cf(path, { ...query, per_page: PER_PAGE, page });
    out.push(...(r.result ?? []));
    total = r.result_info?.total_count ?? out.length;
    const pages = r.result_info?.total_pages ?? 1;
    if (!all || page >= pages || out.length >= max || !(r.result ?? []).length) break;
    page++;
  }
  return { result: max === Infinity ? out : out.slice(0, max), total, fetched: out.length };
}

// ── Zones ────────────────────────────────────────────────────────────────────
export const listZones = (opts = {}) => paginate("/zones", opts);

export async function resolveZone({ zone }) {
  if (!zone) throw new Error("zone is required (name or id)");
  // A 32-hex string is already a zone id; anything else is treated as a name.
  if (/^[0-9a-f]{32}$/i.test(zone)) return (await cf(`/zones/${zone}`)).result;
  const r = await cf("/zones", { name: zone });
  const hit = (r.result ?? [])[0];
  if (!hit) {
    throw new Error(
      `Zone "${zone}" is not in this Cloudflare account. Domains provisioned by ` +
      `Inboxing or Cheap Inboxes live in THEIR Cloudflare accounts, so they are not visible here.`
    );
  }
  return hit;
}

export const getZone = (args) => resolveZone(args);

// ── DNS records ──────────────────────────────────────────────────────────────
export async function listDnsRecords({ zone, type, name, all = true, max }) {
  const z = await resolveZone({ zone });
  const r = await paginate(`/zones/${z.id}/dns_records`, { type, name, all, max });
  return { zone: z.name, zone_id: z.id, total: r.total, records: r.result };
}

// ── Email DNS posture ────────────────────────────────────────────────────────
// The reason to look at DNS for a sending domain at all: is it actually set up
// to send and be trusted? Reports what exists rather than judging it.
export async function emailDnsCheck({ zone }) {
  const z = await resolveZone({ zone });
  const { result } = await paginate(`/zones/${z.id}/dns_records`, { all: true });

  const txt = result.filter(r => r.type === "TXT");
  const spf = txt.filter(r => /^"?v=spf1/i.test(r.content ?? ""));
  const dmarc = txt.filter(r => (r.name ?? "").startsWith("_dmarc."));
  const dkim = result.filter(r => /_domainkey/i.test(r.name ?? ""));
  const mx = result.filter(r => r.type === "MX");

  return {
    zone: z.name,
    zone_id: z.id,
    zone_status: z.status,          // "pending" means Cloudflare is not authoritative yet
    name_servers: z.name_servers ?? [],
    records_total: result.length,
    spf:   { present: spf.length > 0,   count: spf.length,   values: spf.map(r => r.content) },
    dmarc: { present: dmarc.length > 0, count: dmarc.length, values: dmarc.map(r => r.content) },
    dkim:  { present: dkim.length > 0,  count: dkim.length,  names: dkim.map(r => r.name) },
    mx:    { present: mx.length > 0,    count: mx.length,
             hosts: mx.map(r => `${r.content} (p${r.priority})`) },
    // Multiple SPF records is a real misconfiguration: RFC 7208 allows exactly
    // one, and receivers may fail the check outright when they see two.
    warnings: [
      spf.length > 1 ? `${spf.length} SPF records — RFC 7208 permits exactly one` : null,
      z.status !== "active" ? `zone status is "${z.status}" — Cloudflare is not serving this domain's DNS yet` : null,
      !spf.length ? "no SPF record" : null,
      !dmarc.length ? "no DMARC record" : null,
    ].filter(Boolean),
  };
}

// ── Writes ───────────────────────────────────────────────────────────────────
// Adding a zone is free, reversible and does nothing to live traffic on its
// own: Cloudflare only becomes authoritative once the REGISTRAR's nameservers
// point at the assigned pair. Deleting zones and editing DNS records remain
// unimplemented — those break mail on a live sending domain.
export async function createZone({ name, account_id }) {
  if (!name) throw new Error("name is required");
  const acct = account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!acct) throw new Error("CLOUDFLARE_ACCOUNT_ID is not set and account_id was not supplied");

  // Idempotent: adding an existing zone errors (code 1061), so return it instead.
  try {
    const existing = await resolveZone({ zone: name });
    return { ...existing, already_existed: true };
  } catch { /* not present — create it */ }

  const r = await cf("/zones", undefined, {
    method: "POST",
    body: { name, account: { id: acct }, type: "full" },
  });
  return { ...r.result, already_existed: false };
}

// ── Email DNS writes ─────────────────────────────────────────────────────────
// Scope guard. The token carries account-wide #dns_records:edit, so the limit
// has to live here: only SPF, DKIM, DMARC and MX may be touched, and only
// inside the resolved zone.
function classify(z, rec) {
  const n = String(rec.name ?? "").toLowerCase();
  const c = String(rec.content ?? "");
  if (n !== z.name && !n.endsWith(`.${z.name}`)) return null;
  if (rec.type === "MX") return "MX";
  if (/\._domainkey(\.|$)/i.test(n) && (rec.type === "TXT" || rec.type === "CNAME")) return "DKIM";
  if (rec.type === "TXT" && n === `_dmarc.${z.name}`) return "DMARC";
  if (rec.type === "TXT" && /^"?v=spf1/i.test(c)) return "SPF";
  return null;
}

function assertInScope(z, rec) {
  const kind = classify(z, rec);
  if (!kind) {
    throw new Error(
      `Refusing to modify ${rec.type} "${rec.name}" — these tools only touch SPF, DKIM, ` +
      `DMARC and MX records inside ${z.name}. Edit anything else in the Cloudflare dashboard.`
    );
  }
  return kind;
}

// Cloudflare stores TXT content quoted, and splits long strings into "chunk" "chunk".
const unquote = (s) => String(s ?? "").replace(/"\s+"/g, "").replace(/^"|"$/g, "");

const records = async (z, query = {}) =>
  (await paginate(`/zones/${z.id}/dns_records`, { all: true, ...query })).result;

const createRec = (z, body) => cf(`/zones/${z.id}/dns_records`, undefined, { method: "POST", body }).then(r => r.result);
const patchRec  = (z, id, body) => cf(`/zones/${z.id}/dns_records/${id}`, undefined, { method: "PATCH", body }).then(r => r.result);
const deleteRec = (z, id) => cf(`/zones/${z.id}/dns_records/${id}`, undefined, { method: "DELETE" });

// Collapse a set of matching records down to exactly one holding `body`.
//
// Extras are deleted BEFORE the survivor is patched, not after: Cloudflare
// rejects a PATCH that would make two records identical (code 81058), so
// patching first collides with the very duplicate we are about to remove.
// The survivor is preferentially one that already holds the target content,
// which also turns a no-op call into a no-op.
async function reconcile(z, matches, body, plan, dry_run) {
  const want = String(body.content);
  const keep = matches.find(r => unquote(r.content) === want) ?? matches[0];
  const full = {
    ...plan,
    before: matches.map(r => unquote(r.content)),
    action: matches.length ? (keep && unquote(keep.content) === want && matches.length === 1 ? "unchanged" : "replace") : "create",
    duplicates_removed: Math.max(0, matches.length - 1),
  };
  if (dry_run) return { ...full, dry_run: true, applied: false };

  for (const extra of matches) if (extra !== keep) await deleteRec(z, extra.id);
  const rec = keep
    ? (unquote(keep.content) === want && keep.ttl === body.ttl ? keep : await patchRec(z, keep.id, body))
    : await createRec(z, body);
  return { ...full, applied: true, record_id: rec.id };
}

// Update-or-create a single record at one name, collapsing accidental duplicates.
async function upsertOne(z, { type, name, content, ttl = 1, priority }, dry_run) {
  const matches = (await records(z, { name })).filter(r => r.type === type);
  const body = { type, name, content, ttl, ...(priority !== undefined ? { priority } : {}) };
  const out = await reconcile(z, matches, body,
    { zone: z.name, zone_id: z.id, name, type, after: content }, dry_run);
  if (!out.applied) return out;

  // Read back rather than trusting the write.
  const after = (await records(z, { name })).filter(r => r.type === type);
  return { ...out, verified: after.map(r => unquote(r.content)) };
}

export async function setSpf({ zone, value, ttl = 1, dry_run = false }) {
  if (!/^v=spf1\b/i.test(String(value ?? ""))) throw new Error('SPF value must start with "v=spf1"');
  const z = await resolveZone({ zone });
  // SPF lives at the apex, and RFC 7208 permits exactly one record — so every
  // apex v=spf1 TXT is a duplicate to be collapsed, not just same-name ones.
  const spf = (await records(z, { type: "TXT" }))
    .filter(r => String(r.name).toLowerCase() === z.name && /^"?v=spf1/i.test(r.content ?? ""));

  const out = await reconcile(z, spf, { type: "TXT", name: z.name, content: value, ttl },
    { zone: z.name, zone_id: z.id, name: z.name, type: "TXT", after: value }, dry_run);
  if (!out.applied) return out;

  const verified = (await records(z, { type: "TXT" }))
    .filter(r => /^"?v=spf1/i.test(r.content ?? ""))
    .map(r => `${r.name}: ${unquote(r.content)}`);
  return { ...out, verified };
}

export async function setDmarc({ zone, value, policy, rua, pct, ttl = 1, dry_run = false }) {
  const z = await resolveZone({ zone });
  let v = value;
  if (!v) {
    const p = String(policy ?? "none").toLowerCase();
    if (!["none", "quarantine", "reject"].includes(p)) {
      throw new Error(`policy must be none, quarantine or reject (got "${policy}")`);
    }
    v = `v=DMARC1; p=${p}`
      + (pct !== undefined ? `; pct=${pct}` : "")
      + (rua ? `; rua=mailto:${rua}` : "");
  }
  if (!/^v=DMARC1\b/i.test(v)) throw new Error('DMARC value must start with "v=DMARC1"');
  return upsertOne(z, { type: "TXT", name: `_dmarc.${z.name}`, content: v, ttl }, dry_run);
}

export async function setDkim({ zone, selector, value, cname_target, ttl = 1, dry_run = false }) {
  if (!selector) throw new Error("selector is required (the label before ._domainkey)");
  if (!!value === !!cname_target) {
    throw new Error("supply exactly one of value (publishes a TXT) or cname_target (publishes a CNAME)");
  }
  const z = await resolveZone({ zone });
  return upsertOne(z, {
    type: value ? "TXT" : "CNAME",
    name: `${selector}._domainkey.${z.name}`,
    content: value ?? cname_target,
    ttl,
  }, dry_run);
}

// MX is a set, not a single value: Google alone wants five. Default is to
// replace the whole set, which is what "point this domain at a provider" means.
export async function setMx({ zone, hosts, replace = true, ttl = 1, dry_run = false }) {
  if (!Array.isArray(hosts) || !hosts.length) throw new Error("hosts must be a non-empty array");
  const wanted = hosts.map((h, i) => {
    const host = typeof h === "string" ? h : h.host ?? h.content;
    const priority = typeof h === "string" ? (i + 1) * 10 : h.priority ?? (i + 1) * 10;
    if (!host) throw new Error(`hosts[${i}] has no host`);
    return { host: String(host).replace(/\.$/, ""), priority: Number(priority) };
  });

  const z = await resolveZone({ zone });
  const existing = (await records(z, { type: "MX" })).filter(r => String(r.name).toLowerCase() === z.name);
  const plan = {
    zone: z.name, zone_id: z.id, type: "MX",
    action: replace ? "replace set" : "add to set",
    before: existing.map(r => `${r.content} (p${r.priority})`),
    after: wanted.map(w => `${w.host} (p${w.priority})`),
    removing: replace ? existing.length : 0,
  };
  if (dry_run) return { ...plan, dry_run: true, applied: false };

  if (replace) for (const r of existing) await deleteRec(z, r.id);
  for (const w of wanted) {
    await createRec(z, { type: "MX", name: z.name, content: w.host, priority: w.priority, ttl });
  }

  const verified = (await records(z, { type: "MX" })).map(r => `${r.content} (p${r.priority})`);
  return { ...plan, applied: true, verified };
}

// Removing a stray record — a second SPF, a dead DKIM selector. Scope-guarded:
// the record is fetched and classified before anything is deleted.
export async function deleteEmailRecord({ zone, record_id, dry_run = false }) {
  if (!record_id) throw new Error("record_id is required");
  const z = await resolveZone({ zone });
  const rec = (await cf(`/zones/${z.id}/dns_records/${record_id}`)).result;
  const kind = assertInScope(z, rec);
  const plan = { zone: z.name, record_id, kind, type: rec.type, name: rec.name, content: unquote(rec.content) };
  if (dry_run) return { ...plan, dry_run: true, applied: false };
  await deleteRec(z, record_id);
  return { ...plan, applied: true, deleted: true };
}
