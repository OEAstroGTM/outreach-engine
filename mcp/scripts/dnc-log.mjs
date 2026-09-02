#!/usr/bin/env node
// ── scripts/dnc-log.mjs ──────────────────────────────────────────────────────
// Turn one full --json report into one compact log line.
//
// Two things went wrong with the first version of this, both worth keeping in
// mind if you touch it:
//
//  1. It located the JSON with `output.indexOf("{")`. dotenvx prints a banner
//     first — `◇ injected env (75) from .env // tip: ⌘ suppress logs { quiet: true }`
//     — and that tip contains a brace. Every nightly run therefore failed to
//     parse and was recorded as a crash. Here we slice from the first line that
//     is exactly `{`, which is where JSON.stringify(o, null, 2) always starts.
//  2. It logged the entire report. Twenty clients with a full label_census is
//     ~40KB per night, which made the log unreadable and unsearchable. The
//     compact record keeps what you would actually grep for; the complete
//     report goes to data/dnc-last-run.json for the most recent run only.

import { readFileSync } from "fs";

const raw  = readFileSync(process.argv[2] ?? 0, "utf8");
const exit = Number(process.argv[3] ?? 0);
const errText = process.argv[4] ? readFileSync(process.argv[4], "utf8") : "";

function findJson(text) {
  const lines = text.split("\n");
  const start = lines.findIndex(l => l.trim() === "{");
  if (start === -1) return null;
  try { return JSON.parse(lines.slice(start).join("\n")); } catch { return null; }
}

const report = findJson(raw);

if (!report) {
  // Keep stderr, not stdout: when the run dies early the reason is on stderr,
  // and the old version threw that away in favour of a truncated stdout tail.
  console.log(JSON.stringify({
    ran_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    exit,
    ok: false,
    crash: (errText || raw).trim().slice(-1500),
  }));
  process.exit(0);
}

const clients = (report.results ?? []).map(r => {
  const row = { client: r.client };
  if (r.error) { row.error = r.error.slice(0, 300); return row; }
  row.scanned = r.prospects_scanned;
  row.booked  = r.booked_matched;
  row.diff    = r.would_block?.length ?? 0;
  if (r.blocked?.length)   row.blocked = r.blocked;          // names, not a count — this is the audit trail
  if (r.failed?.length)    row.failed  = r.failed;
  if (r.scan_complete === false) row.unreachable = r.scan_unreachable;
  if (r.unresolved?.length) row.unresolved = r.unresolved.length;
  return row;
});

console.log(JSON.stringify({
  ran_at: report.ran_at,
  exit,
  ok: exit === 0 && (report.totals?.errored ?? 0) === 0 && (report.totals?.failed ?? 0) === 0,
  mode: report.mode?.startsWith("LIVE") ? "live" : "dry",
  totals: report.totals,
  // Clients that did nothing are the overwhelming majority at steady state and
  // carry no information; keep only the ones that acted or complained.
  clients: clients.filter(c => c.error || c.blocked || c.failed || c.diff > 0 || c.unreachable),
  quiet_clients: clients.filter(c => !(c.error || c.blocked || c.failed || c.diff > 0 || c.unreachable)).length,
}));
