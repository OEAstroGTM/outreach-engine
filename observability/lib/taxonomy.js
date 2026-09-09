// ── taxonomy.js ──────────────────────────────────────────────────────────────
// Canonical grouping of MasterInbox label NAMES. Single source of truth for
// every metric in the observability module.
//
// CRITICAL: label IDs differ per workspace (Ujet's "Add to Blocklist" is 192287,
// OutreachEngine's is 6279). Always key on the NAME, never the ID.

// IMPORTANT: these are STATE groups, not funnel stages.
//
// A label is mutable state that changes as a lead moves, and labels accumulate on
// a record rather than replacing each other — a single record can carry
// "Meeting Request, 1st call completed, Meeting Booked" at once. So these groups
// OVERLAP, and a count of one minus a count of another is not a loss.
//
// Ratios between these counts are not conversion rates. Conversion is a cohort
// question and needs the same records observed twice — see cohort.js.

// Any expression of interest. All three are equivalent; never treat
// "Meeting Request" alone as the entry signal.
export const INTEREST = ["Interested", "Information Request", "Meeting Request"];

// Success. A record reaching this state has booked. Records generally retain
// their interest labels alongside it, which is why the groups overlap.
export const SUCCESS = ["Meeting Booked"];

// Prospect is warm but not now. Nurture, not pipeline.
export const DEFERRAL = ["Not Right Now", "Follow Up", "Follow Up in 30 Days"];

export const REDIRECT = ["Referral"];
export const PROCESS = ["Info sent", "Ongoing Discussion"];

// Appointment-setter DIAL ATTEMPTS. Effort markers, NOT funnel stages.
// Do not compute "1st call -> 2nd call conversion" as though it were deal
// progression; most prospects simply get called once.
export const SETTER_ACTIVITY = [
  "1st call completed", "2nd call completed", "3rd call completed",
  "4th call complete", "5th call complete", "6th call complete",
];

export const NEGATIVE = ["Not Interested", "Not Intrested", "Add to Blocklist", "Angry Response"];

// Never written by a human. Signals list quality, not market response.
export const NOISE = [
  "OOO Sequence", "OOOO Sequence", "Automated Response",
  "Wrong Person", "Unable to Categorise",
];

// Setter ownership tags, not stages.
export const OWNER = ["JP", "Hannah"];

// Observed in the wild as near-duplicates of Interested / Information Request.
// Counted as interest so they stop silently vanishing from every metric.
export const INTEREST_VARIANTS = ["Interest", "Interest Request"];

export const GROUPS = {
  interest: [...INTEREST, ...INTEREST_VARIANTS],
  success: SUCCESS,
  deferral: DEFERRAL,
  redirect: REDIRECT,
  process: PROCESS,
  setter_activity: SETTER_ACTIVITY,
  negative: NEGATIVE,
  noise: NOISE,
  owner: OWNER,
};

const ALL = new Set(Object.values(GROUPS).flat());

/** Labels seen on records that this taxonomy does not classify. An unclassified
 *  label drops out of every metric silently, so surface it loudly. */
export function unclassified(labelNames = []) {
  return [...new Set(labelNames)].filter(n => !ALL.has(n));
}

/** Tally a set of records into groups. A record counts once per group it touches. */
export function tally(records) {
  const out = {
    records: records.length, interest: 0, success: 0, deferral: 0,
    setter_activity: 0, negative: 0, noise: 0, unlabelled: 0,
  };
  const seen = new Set();
  for (const r of records) {
    const ls = r.label_names || [];
    if (!ls.length) { out.unlabelled++; continue; }
    ls.forEach(l => seen.add(l));
    for (const g of ["interest", "success", "deferral", "setter_activity", "negative", "noise"]) {
      if (ls.some(l => GROUPS[g].includes(l))) out[g]++;
    }
  }
  out.interest_to_booked = out.interest ? +(out.success / out.interest * 100).toFixed(1) : null;
  out.unclassified_labels = unclassified([...seen]);
  return out;
}

/** The headline conversion metric: interest pool -> booked meeting. */
export function conversion(t) {
  return t.interest ? t.success / t.interest : null;
}
