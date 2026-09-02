#!/usr/bin/env node
// ── pv-verify-upload.js ──────────────────────────────────────────────────────
// Reconciles the Inboxing → PlusVibe mailbox upload for Outreach Engine.
//
// Why this exists: inboxing_upload_to_platform returns HTTP 200 for "job
// queued", and PlusVibe's bulk-add explicitly warns that a success response
// "does not indicate that the email accounts were added successfully" — results
// arrive by email. So the only trustworthy answer to "did all 3,724 land?" is
// to read them back out of PlusVibe and diff. That's this script.
//
// Usage:
//   node mcp/scripts/pv-verify-upload.js                        # auto-detect workspace
//   node mcp/scripts/pv-verify-upload.js --workspace "Staging" # match by name
//   node mcp/scripts/pv-verify-upload.js --workspace-id 65f3...
//   node mcp/scripts/pv-verify-upload.js --json                # machine-readable
//
// Requires PLUSVIBE_API_KEY in the repo-root .env.
import { listWorkspaces, listAllAccounts } from "../lib/plusvibe.js";

// The 76 domains tagged `outreachengine` in Inboxing as of 2026-08-05, each
// provisioned with 49 mailboxes. Snapshot, not a live read — if you add or
// retire OE domains, refresh this list from Inboxing before trusting the diff.
const EXPECTED_PER_DOMAIN = 49;
const EXPECTED_DOMAINS = [
  "outreachengineaccel.digital",    "outreachengineadvance.digital",
  "outreachengineai.digital",       "outreachenginebase.digital",
  "outreachenginebooster.digital",  "outreachenginebuild.digital",
  "outreachenginecamp.digital",     "outreachenginecenter.digital",
  "outreachenginecentral.digital",  "outreachenginecloud.digital",
  "outreachengineconnect.digital",  "outreachenginecore.digital",
  "outreachenginecrew.digital",     "outreachenginedata.digital",
  "outreachenginedesk.digital",     "outreachenginedirect.digital",
  "outreachenginedrive.digital",    "outreachengineedge.digital",
  "outreachengineelite.digital",    "outreachengineflow.digital",
  "outreachengineforce.digital",    "outreachengineforward.digital",
  "outreachenginegoal.digital",     "outreachenginegrid.digital",
  "outreachenginegroup.digital",    "outreachenginegrow.digital",
  "outreachengineguru.digital",     "outreachenginehq.digital",
  "outreachenginehub.digital",      "outreachengineiq.digital",
  "outreachenginekey.digital",      "outreachenginelaunch.digital",
  "outreachenginelift.digital",     "outreachenginelink.digital",
  "outreachenginelive.digital",     "outreachenginemaster.digital",
  "outreachenginemax.digital",      "outreachenginemethod.digital",
  "outreachenginemind.digital",     "outreachenginenation.digital",
  "outreachenginenetwork.digital",  "outreachenginenode.digital",
  "outreachenginenow.digital",      "outreachenginepath.digital",
  "outreachengineplatform.digital", "outreachengineplus.digital",
  "outreachenginepoint.digital",    "outreachengineport.digital",
  "outreachenginepower.digital",    "outreachengineprime.digital",
  "outreachenginepro.digital",      "outreachenginepulse.digital",
  "outreachengineresults.digital",  "outreachenginerise.digital",
  "outreachenginerun.digital",      "outreachenginescale.digital",
  "outreachenginesend.digital",     "outreachengineseo.digital",
  "outreachengineshift.digital",    "outreachenginesmart.digital",
  "outreachenginesource.digital",   "outreachenginespark.digital",
  "outreachenginespot.digital",     "outreachenginestrategy.digital",
  "outreachenginesuccess.digital",  "outreachenginesuite.digital",
  "outreachenginesync.digital",     "outreachenginesystem.digital",
  "outreachengineteam.digital",     "outreachenginetools.digital",
  "outreachenginewave.digital",     "outreachenginewin.digital",
  "outreachenginewire.digital",     "outreachengineworks.digital",
  "outreachengineworld.digital",    "outreachenginezone.digital",
];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const asJson = process.argv.includes("--json");

function domainOf(email) {
  return String(email || "").split("@").pop().toLowerCase();
}

async function pickWorkspace() {
  const explicitId = arg("--workspace-id");
  if (explicitId) return { id: explicitId, name: "(by id)" };

  const all  = await listWorkspaces();
  const want = arg("--workspace");

  if (want) {
    const lower = want.toLowerCase();
    const hit =
      all.find(w => w.name.toLowerCase() === lower) ??
      all.find(w => w.name.toLowerCase().includes(lower));
    if (!hit) throw new Error(`No workspace matching "${want}". Available: ${all.map(w => w.name).join(", ")}`);
    return hit;
  }

  if (all.length === 1) return all[0];

  // Don't guess across multiple workspaces — reporting "0 mailboxes landed"
  // because we counted the wrong workspace is worse than asking.
  throw new Error(
    `${all.length} workspaces visible; pass --workspace or --workspace-id.\n` +
    all.map(w => `  ${w.id}  ${w.name}`).join("\n")
  );
}

const ws = await pickWorkspace();
if (!asJson) console.log(`Workspace: ${ws.name} (${ws.id})\nReading mailboxes…`);

const { accounts, truncated } = await listAllAccounts({ workspace_id: ws.id });

// Group what actually landed, by sending domain.
const byDomain = new Map();
for (const a of accounts) {
  const d = domainOf(a.email);
  if (!byDomain.has(d)) byDomain.set(d, []);
  byDomain.get(d).push(a);
}

const rows = EXPECTED_DOMAINS.map(d => {
  const got     = byDomain.get(d) ?? [];
  const warming = got.filter(a => String(a.warmup_status).toUpperCase() === "ACTIVE").length;
  return {
    domain:  d,
    found:   got.length,
    missing: Math.max(0, EXPECTED_PER_DOMAIN - got.length),
    warming,
  };
});

const expectedTotal = EXPECTED_DOMAINS.length * EXPECTED_PER_DOMAIN;
const foundTotal    = rows.reduce((n, r) => n + r.found, 0);
const incomplete    = rows.filter(r => r.missing > 0);
const warmingTotal  = rows.reduce((n, r) => n + r.warming, 0);
const unexpected    = [...byDomain.keys()].filter(d => !EXPECTED_DOMAINS.includes(d));

const report = {
  workspace: ws,
  expected_total: expectedTotal,
  found_total: foundTotal,
  complete_domains: rows.length - incomplete.length,
  incomplete_domains: incomplete,
  warmup_active_count: warmingTotal,
  unexpected_domains: unexpected,
  account_list_truncated: truncated,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nMailboxes: ${foundTotal} / ${expectedTotal}`);
  console.log(`Domains complete: ${rows.length - incomplete.length} / ${rows.length}`);

  if (incomplete.length) {
    console.log(`\nIncomplete (${incomplete.length}) — these need a re-upload:`);
    for (const r of incomplete) {
      console.log(`  ${r.domain.padEnd(34)} ${String(r.found).padStart(2)}/${EXPECTED_PER_DOMAIN}  (missing ${r.missing})`);
    }
  } else {
    console.log("\nAll 76 domains fully landed.");
  }

  // Uploads were sent with enable_warmup:false precisely so these mailboxes
  // stay inert while EmailBison is still warming the same inboxes. Any warmup
  // showing ACTIVE here means the same physical mailbox is being warmed by two
  // platforms at once — pause it before it burns the domain.
  if (warmingTotal > 0) {
    console.log(`\n⚠  ${warmingTotal} mailbox(es) have warmup ACTIVE. Uploads were sent warmup-off;`);
    console.log(`   these are double-warming against EmailBison. Pause them before the parallel run.`);
  }

  if (unexpected.length) {
    console.log(`\nDomains present but not in the expected 76 (${unexpected.length}):`);
    for (const d of unexpected) console.log(`  ${d}  (${byDomain.get(d).length})`);
    console.log("  → likely off-pattern OE domains the `outreach` name search missed, or another client's mailboxes in this workspace.");
  }

  if (truncated) {
    console.log("\n⚠  Hit the pagination cap — this count is a floor, not a total. Raise max_pages.");
  }
}

process.exit(incomplete.length ? 1 : 0);
