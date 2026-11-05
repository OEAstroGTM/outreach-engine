#!/usr/bin/env node
// ── scripts/dnc-sync.js ──────────────────────────────────────────────────────
// Standalone runner for the "meeting booked → Bison blocklist" reconciler, so
// it can be scheduled (cron / launchd / a Cowork scheduled task) without an MCP
// client in the loop.
//
//   node mcp/scripts/dnc-sync.js                      # dry run, all clients
//   node mcp/scripts/dnc-sync.js --client AskTuring   # dry run, one client
//   node mcp/scripts/dnc-sync.js --live --limit 1     # write ONE domain (there is no undo)
//   node mcp/scripts/dnc-sync.js --live               # actually write to Bison
//   node mcp/scripts/dnc-sync.js --live --bulk        # write via the multipart CSV endpoint
//   node mcp/scripts/dnc-sync.js --live --skip-webhooks
//   node mcp/scripts/dnc-sync.js --label "Add to Blocklist"   # match a different label
//   node mcp/scripts/dnc-sync.js --status             # what has it done so far
//   node mcp/scripts/dnc-sync.js --brief              # one line per client
//   node mcp/scripts/dnc-sync.js --json               # machine-readable output
//
// --live is deliberately verbose and deliberately not the default.

import { syncBookedMeetingsToDNC, dncStatus } from "../lib/dnc.js";

const argv    = process.argv.slice(2);
const has     = f => argv.includes(f);
const valueOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const client_name = valueOf("--client");
const asJson      = has("--json");
const asBrief     = has("--brief");
const live        = has("--live");

// The full report is ~900 lines across 20 clients — unreadable in a terminal and
// painful to paste. --brief collapses each client to one line and keeps only what
// you act on: how much was scanned, what matched, what would change, and why a
// client produced nothing. Errors print in full underneath, because a truncated
// error is a useless error.
function printBrief(o) {
  const rows = o.results ?? [];
  const errs = [];
  const pad  = (v, n) => String(v ?? "").padEnd(n);
  const num  = (v, n) => String(v ?? 0).padStart(n);

  console.log(`${o.mode}   label: ${o.label?.split(" (")[0] ?? ""}`);
  console.log(`${pad("CLIENT", 24)}${num("SCAN", 7)}${num("BOOKED", 7)}${num("ONLIST", 7)}${num("BLOCK", 6)}  NOTE`);

  for (const r of rows) {
    if (r.error) { errs.push(r); console.log(`${pad(r.client, 24)}${"  — refused / errored".padStart(27)}`); continue; }
    const notes = [];
    if (r.unresolved?.length)   notes.push(`${r.unresolved.length} unresolvable`);
    if (r.limited)
      notes.push(`held by run cap ${r.limited.run_cap}: wrote ${r.limited.writing}, held ${r.limited.held_back}`);
    if (r.scan_complete === false)
      notes.push(r.scan_window_capped
        ? `CAPPED ${r.prospects_scanned}/${r.prospects_total} — ${r.scan_unreachable} past MasterInbox's 10k window`
        : `PARTIAL SCAN ${r.prospects_scanned}/${r.prospects_total ?? "?"}`);
    else if (r.page_limit_hit)  notes.push("PAGE LIMIT HIT — partial scan");
    if (r.blocklist_stalled)
      notes.push(`blocklist: ${r.existing_blocklist} unique from ${r.blocklist_rows_read} rows — pages repeat, stopped early`);
    if (r.blocklist_truncated)
      notes.push(`blocklist truncated: ${r.existing_blocklist} unique from ${r.blocklist_rows_read} rows` +
                 (r.blocklist_reported_total != null ? ` of ${r.blocklist_reported_total}` : ""));
    if (r.blocklist_read === false) notes.push("blocklist not read — no candidates");
    if (r.bulk?.warning)        notes.push("bulk warning");
    for (const [k, v] of Object.entries(r.skipped ?? {})) notes.push(`${v} ${k}`);
    if (r.blocked?.length)      notes.unshift(`WROTE ${r.blocked.length}`);
    if (r.failed?.length)       notes.unshift(`FAILED ${r.failed.length}`);
    console.log(
      pad(r.client, 24) + num(r.prospects_scanned, 7) + num(r.booked_matched, 7) +
      num(r.existing_blocklist, 7) + num(r.would_block?.length, 6) + "  " + notes.join(" · ")
    );
  }

  for (const r of errs) console.log(`\nERROR  ${r.client}\n  ${r.error}`);

  const t = o.totals ?? {};
  console.log(`\n${t.clients} clients · would_block ${t.would_block} · blocked ${t.blocked} · failed ${t.failed} · errored ${t.errored}`);
  console.log(`ledger: ${o.ledger_path}`);
}

function print(obj) {
  if (asJson)  { console.log(JSON.stringify(obj, null, 2)); return; }
  if (asBrief) { printBrief(obj); return; }
  console.log(JSON.stringify(obj, null, 2));
}

if (has("--status")) {
  print(dncStatus({ client_name }));
  process.exit(0);
}

const out = await syncBookedMeetingsToDNC({
  client_name,
  dry_run:       !live,
  // Pass through only when given, so the module's own default applies.
  max_pages:     has("--max-pages") ? Number(valueOf("--max-pages")) : undefined,
  label_name:    valueOf("--label"),
  limit:         argv.includes("--limit") ? Number(valueOf("--limit")) : undefined,
  skip_webhooks: has("--skip-webhooks"),
  use_bulk:      has("--bulk"),
});

print(out);

// Non-zero exit if anything errored, so a scheduler surfaces the failure.
process.exit(out.totals.errored > 0 || out.totals.failed > 0 ? 1 : 0);
