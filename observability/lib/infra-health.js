// ── infra-health.js ──────────────────────────────────────────────────────────
// THE HOSPITAL. Diagnoses sending infrastructure at DOMAIN level.
//
// Why domain and not mailbox: reputation damage is domain-wide, and the fleet is
// far too large for per-mailbox reporting — Dream It Reel alone runs 1,205
// connected mailboxes, and one workspace's account list is a 1.4 MB payload.
// Nobody reads a 1,205-row table. Domain is also the only key shared by all four
// systems, which is what makes the join possible at all.
//
//   Inboxing    -> domain provisioned, client tag, mailbox slots   (birth record)
//   Registrar   -> creation + expiry date                          (age)
//   EmailBison  -> mailbox status, daily_limit                     (capacity)
//   MasterInbox -> channel_id decoded -> threads/interest/booked   (outcome)
//
// READ-ONLY. This module observes and reports. It never registers, deletes,
// pauses or retags anything. Diagnosis only — a human discharges the patient.

import { GROUPS } from "./taxonomy.js";

// ── Known API constraints, learned the hard way. Respect these or get bad data.
export const CONSTRAINTS = {
  bison_list_workspaces_incomplete:
    "emailbison_list_workspaces returns a PARTIAL set on both instances (16 of 23+ on send; " +
    "omits team 7 on personal). Drive inventory from clients.json, never from this call.",
  bison_counts_timeout:
    "emailbison_get_all_workspace_mailbox_counts TIMES OUT without a status filter. Always pass one.",
  bison_list_accounts_ignores_team:
    "emailbison_list_email_accounts IGNORES team_id — asking for one workspace returns the whole instance.",
  bison_disconnected_page_cap:
    "A disconnected count of exactly 100 is an API page cap, i.e. a FLOOR not a count.",
  mi_label_stats_locked:
    "masterinbox_get_label_stats ignores its label_id and always returns workspace 1013.",
  mi_total_minus_one:
    "get_prospects metadata.total is valid on page 1 only; it returns -1 on later pages.",
  heyreach_no_domain:
    "HeyReach (LinkedIn) records carry channel_id 'heyreach_<id>' with no domain and no " +
    "last_reply_address. They cannot be domain-attributed. Branch on the record's `source`.",
};

/** channel_id is base64 of the sending mailbox address. Returns null for HeyReach
 *  and anything that does not decode to an address. */
export function decodeSender(channelId) {
  if (!channelId || channelId.startsWith("heyreach_")) return null;
  let s;
  try { s = Buffer.from(channelId, "base64").toString("utf8"); } catch { return null; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  const at = s.lastIndexOf("@");
  return { mailbox: s, domain: s.slice(at + 1).toLowerCase() };
}

/** Roll MasterInbox records up to per-domain outcome counts. */
export function attributeByDomain(records) {
  const byDomain = new Map();
  let unattributable = 0;
  for (const r of records) {
    const s = decodeSender(r.channel_id);
    if (!s) { unattributable++; continue; }
    const d = byDomain.get(s.domain) || {
      domain: s.domain, mailboxes: new Set(),
      threads: 0, interest: 0, booked: 0, negative: 0, noise: 0,
    };
    d.mailboxes.add(s.mailbox);
    d.threads++;
    const ls = r.label_names || [];
    if (ls.some(l => GROUPS.interest.includes(l))) d.interest++;
    if (ls.some(l => GROUPS.success.includes(l))) d.booked++;
    if (ls.some(l => GROUPS.negative.includes(l))) d.negative++;
    if (ls.some(l => GROUPS.noise.includes(l))) d.noise++;
    byDomain.set(s.domain, d);
  }
  return {
    domains: [...byDomain.values()].map(d => ({
      ...d, mailboxes: d.mailboxes.size,
      noise_pct: d.threads ? +(d.noise / d.threads * 100).toFixed(1) : null,
    })).sort((a, b) => b.booked - a.booked || b.interest - a.interest),
    unattributable,
  };
}

// ── Triage ───────────────────────────────────────────────────────────────────
// Thresholds are deliberately conservative: this system's job is to flag a
// patient for a human to look at, not to sentence one.
export const THRESHOLDS = {
  warming_days: 30,        // below this, a domain has not earned a verdict
  min_threads_to_judge: 15, // below this, outcome counts are noise
  noise_pct_critical: 80,
  noise_pct_watch: 65,
};

export const STATES = {
  healthy:   "Connected, sending, producing bookings.",
  warming:   "Too young or too little volume to judge. Leave alone.",
  watch:     "Producing interest but no bookings, or noise climbing. Investigate.",
  critical:  "Real volume, no positives, or noise above 80%. Likely burned.",
  dead:      "Every mailbox disconnected. Sending nothing.",
  unknown:   "Insufficient data to diagnose — usually a missing join.",
};

/**
 * Diagnose one domain.
 * @param {object} d
 *   domain, threads, interest, booked, noise_pct   (MasterInbox outcome)
 *   mailboxes_total, mailboxes_connected           (EmailBison capacity)
 *   age_days                                       (registrar)
 */
export function diagnose(d) {
  const reasons = [];
  const total = d.mailboxes_total ?? null;
  const conn = d.mailboxes_connected ?? null;

  if (total != null && conn === 0) {
    reasons.push(`all ${total} mailboxes disconnected`);
    return { ...d, state: "dead", reasons };
  }
  if (total != null && conn != null && conn < total) {
    reasons.push(`${total - conn} of ${total} mailboxes disconnected`);
  }

  if (d.age_days != null && d.age_days < THRESHOLDS.warming_days) {
    reasons.push(`only ${d.age_days} days old`);
    return { ...d, state: "warming", reasons };
  }
  if ((d.threads ?? 0) < THRESHOLDS.min_threads_to_judge) {
    reasons.push(`only ${d.threads ?? 0} threads — too few to judge`);
    return { ...d, state: "warming", reasons };
  }

  if (d.noise_pct != null && d.noise_pct >= THRESHOLDS.noise_pct_critical) {
    reasons.push(`${d.noise_pct}% of replies are automated noise`);
    return { ...d, state: "critical", reasons };
  }
  if (!d.booked && !d.interest) {
    reasons.push(`${d.threads} threads, zero interest, zero bookings`);
    return { ...d, state: "critical", reasons };
  }
  if (!d.booked && d.interest) {
    reasons.push(`${d.interest} interested but zero bookings`);
    return { ...d, state: "watch", reasons };
  }
  if (d.noise_pct != null && d.noise_pct >= THRESHOLDS.noise_pct_watch) {
    reasons.push(`noise at ${d.noise_pct}%`);
    return { ...d, state: "watch", reasons };
  }

  reasons.push(`${d.booked} booked from ${d.interest} interested`);
  return { ...d, state: "healthy", reasons };
}

/** Ward round: diagnose every domain and summarise the ward. */
export function ward(domains) {
  const patients = domains.map(diagnose);
  const byState = {};
  for (const p of patients) (byState[p.state] ||= []).push(p);
  const order = ["critical", "dead", "watch", "healthy", "warming", "unknown"];
  return {
    patients: patients.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state)
      || (b.threads ?? 0) - (a.threads ?? 0)),
    counts: Object.fromEntries(order.filter(s => byState[s]).map(s => [s, byState[s].length])),
    triage: order.filter(s => s === "critical" || s === "dead").flatMap(s => byState[s] || []),
  };
}

/**
 * Concentration risk: what share of bookings rests on the top N domains.
 * A book where 3 domains carry 60% of bookings is one blacklisting from a bad quarter.
 */
export function concentration(domains, n = 5) {
  const sorted = [...domains].sort((a, b) => b.booked - a.booked);
  const total = sorted.reduce((a, d) => a + d.booked, 0);
  if (!total) return { total_booked: 0, top_n: n, share_pct: null, domains: [] };
  const top = sorted.slice(0, n);
  return {
    total_booked: total, top_n: n,
    share_pct: +(top.reduce((a, d) => a + d.booked, 0) / total * 100).toFixed(1),
    domains: top.map(d => ({ domain: d.domain, booked: d.booked })),
  };
}

/**
 * Mortality curve input. Buckets domains by age and reports bookings per domain
 * per bucket. Over enough weeks this yields the replacement rate — how long a
 * domain earns before it decays — which is the true cost per meeting.
 * Needs several weeks of history before it means anything.
 */
export function mortality(domains, buckets = [30, 60, 90, 180, 365]) {
  const edges = [0, ...buckets, Infinity];
  return edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    const inB = domains.filter(d => d.age_days != null && d.age_days >= lo && d.age_days < hi);
    const booked = inB.reduce((a, d) => a + (d.booked || 0), 0);
    return {
      bucket: hi === Infinity ? `${lo}d+` : `${lo}-${hi}d`,
      domains: inB.length, booked,
      booked_per_domain: inB.length ? +(booked / inB.length).toFixed(2) : null,
    };
  });
}
