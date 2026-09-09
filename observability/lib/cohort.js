// ── cohort.js ────────────────────────────────────────────────────────────────
// Turns label STATE into label TRANSITIONS.
//
// The problem this exists to solve: a label is mutable state, not an event. A
// reply arrives, gets tagged Interested, a setter calls, it becomes Meeting
// Booked. `Meeting Booked: 75` tells you 75 records carry that label RIGHT NOW —
// not how many ever did, and not where they came from.
//
// So a ratio between two label counts is not a conversion rate. Conversion is a
// cohort question: of the leads that showed interest in July, how many booked by
// August. That needs the same records observed twice.
//
// MasterInbox exposes no per-label timestamps, so the source cannot answer it.
// But our own scans can: store each record's label set per scan, and two scans
// give genuine transitions.

import { GROUPS } from "./taxonomy.js";

/**
 * Compact a scan into a storable snapshot.
 * Labels are interned into a vocabulary so the same ~30 strings are not repeated
 * across thousands of records.
 *
 * @param {Array} records  raw MasterInbox prospect records
 * @param {string} ts      ISO timestamp of the scan
 */
export function encodeScan(records, ts) {
  const vocab = [], index = new Map();
  const code = l => {
    if (!index.has(l)) { index.set(l, vocab.length); vocab.push(l); }
    return index.get(l);
  };
  const recs = {};
  for (const r of records) {
    // Email is the stable, human-readable key. Falls back to _id.
    const key = r.email || r._id;
    if (!key) continue;
    recs[key] = (r.label_names || []).map(code).sort((a, b) => a - b);
  }
  return { ts, vocab, recs, count: Object.keys(recs).length };
}

/** Expand a stored scan back into key -> Set(label names). */
export function decodeScan(scan) {
  const out = new Map();
  for (const [k, codes] of Object.entries(scan.recs || {})) {
    out.set(k, new Set(codes.map(i => scan.vocab[i])));
  }
  return out;
}

const inGroup = (labels, group) => (GROUPS[group] || []).some(l => labels.has(l));

/**
 * Diff two scans of the same workspace into real transitions.
 *
 * `entered`/`exited` are GROSS counts — the thing a net label delta cannot tell
 * you. A label count that moved +1 might be +3 arrivals and -2 departures.
 */
export function transitions(prevScan, nextScan) {
  const prev = decodeScan(prevScan), next = decodeScan(nextScan);
  const groups = Object.keys(GROUPS);
  const movement = Object.fromEntries(groups.map(g => [g, { entered: 0, exited: 0, held: 0 }]));

  const changed = [], appeared = [], vanished = [];
  for (const [key, nLabels] of next) {
    const pLabels = prev.get(key);
    if (!pLabels) {
      appeared.push({ key, labels: [...nLabels] });
      for (const g of groups) if (inGroup(nLabels, g)) movement[g].entered++;
      continue;
    }
    const added = [...nLabels].filter(l => !pLabels.has(l));
    const removed = [...pLabels].filter(l => !nLabels.has(l));
    if (added.length || removed.length) changed.push({ key, added, removed });
    for (const g of groups) {
      const was = inGroup(pLabels, g), is = inGroup(nLabels, g);
      if (is && !was) movement[g].entered++;
      else if (!is && was) movement[g].exited++;
      else if (is && was) movement[g].held++;
    }
  }
  for (const [key, pLabels] of prev) {
    if (!next.has(key)) {
      vanished.push({ key, labels: [...pLabels] });
      for (const g of groups) if (inGroup(pLabels, g)) movement[g].exited++;
    }
  }

  return {
    from: prevScan.ts, to: nextScan.ts,
    records: { before: prev.size, after: next.size, appeared: appeared.length,
               vanished: vanished.length, changed: changed.length },
    movement, changed, appeared, vanished,
  };
}

/**
 * Cohort conversion — the only honest version.
 *
 * Of the records that were in `from` at the first scan, what share are in `to`
 * by the last scan. Records that did not exist at t0 are excluded: they are not
 * part of the cohort, and including them is exactly the error that produces a
 * fake rate.
 */
export function cohortConversion(prevScan, nextScan, from = "interest", to = "success") {
  const prev = decodeScan(prevScan), next = decodeScan(nextScan);
  const cohort = [...prev].filter(([, labels]) => inGroup(labels, from)).map(([k]) => k);
  if (!cohort.length) {
    return { from, to, cohort_size: 0, converted: 0, rate: null,
             reason: `no records were in '${from}' at ${prevScan.ts}` };
  }
  let converted = 0, alreadyThere = 0, lost = 0;
  for (const key of cohort) {
    const wasTo = inGroup(prev.get(key), to);
    const nLabels = next.get(key);
    if (!nLabels) { lost++; continue; }
    if (inGroup(nLabels, to)) { converted++; if (wasTo) alreadyThere++; }
  }
  return {
    from, to, window: [prevScan.ts, nextScan.ts],
    cohort_size: cohort.length, converted,
    already_in_target_at_start: alreadyThere,
    newly_converted: converted - alreadyThere,
    disappeared: lost,
    rate: +(converted / cohort.length * 100).toFixed(1),
    // The number that reflects work actually done inside the window.
    new_conversion_rate: +((converted - alreadyThere) / cohort.length * 100).toFixed(1),
  };
}

/**
 * Gate. Refuses conversion until the data can support it — the same discipline
 * applied to the trend, for the same reason.
 */
export function canComputeConversion(scans = []) {
  if (scans.length < 2) {
    return { ok: false, reason: `needs 2 scans of the same workspace, have ${scans.length}` };
  }
  const sorted = [...scans].sort((a, b) => a.ts.localeCompare(b.ts));
  const hours = (new Date(sorted[sorted.length - 1].ts) - new Date(sorted[0].ts)) / 3.6e6;
  if (hours < 24) {
    return { ok: false, reason: `scans only ${hours.toFixed(0)}h apart — too close to show movement` };
  }
  return { ok: true, span_hours: Math.round(hours), scans: sorted.length };
}

/**
 * Point-in-time composition. Valid, but it is NOT a funnel: these groups coexist
 * on the same record, so the numbers overlap and must never be subtracted from
 * one another to imply loss.
 */
export function composition(scan) {
  const recs = decodeScan(scan);
  const groups = Object.keys(GROUPS);
  const counts = Object.fromEntries(groups.map(g => [g, 0]));
  let unlabelled = 0;
  for (const labels of recs.values()) {
    if (!labels.size) { unlabelled++; continue; }
    for (const g of groups) if (inGroup(labels, g)) counts[g]++;
  }
  return {
    ts: scan.ts, records: recs.size, unlabelled, counts, overlaps: true,
    caveat: "Groups coexist on the same record. Do not subtract them to imply loss.",
  };
}
