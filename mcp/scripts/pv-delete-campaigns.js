#!/usr/bin/env node
// ── pv-delete-campaigns.js ───────────────────────────────────────────────────
// Delete campaigns from a PlusVibe workspace. PlusVibe's own docs say of this
// endpoint: "this operation cannot be undone. Please handle with care."
//
// Guards, because there is no undo:
//   · --workspace-id is REQUIRED. No name matching — "Ortrax" vs "OR Trax" style
//     near-misses must never be able to resolve to the wrong tenant here.
//   · Dry run by default. --apply is the only thing that deletes.
//   · --expect N aborts if the count doesn't match what you predicted, so a
//     surprise (someone else added campaigns, wrong workspace) stops the run.
//   · --archive deletes recoverably instead.
//   · --clear-map wipes the replay map afterwards, otherwise the next replay
//     skips everything as "already done" and you get an empty workspace.
//
// Usage:
//   node mcp/scripts/pv-delete-campaigns.js --workspace-id 6a725c90...
//   node mcp/scripts/pv-delete-campaigns.js --workspace-id 6a725c90... --expect 44 --apply \
//        --clear-map data/eb-export/outreach-engine/.pv-replay-map.json
//   node mcp/scripts/pv-delete-campaigns.js --workspace-id 6a725c90... --name-contains "[SMOKE]" --apply
import { existsSync, writeFileSync, renameSync } from "fs";
import { listAllCampaigns, deleteCampaign } from "../lib/plusvibe.js";

function arg(f) { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; }
const has = f => process.argv.includes(f);

const WS       = arg("--workspace-id");
const APPLY    = has("--apply");
const ARCHIVE  = has("--archive");
const KEEPLEAD = has("--keep-lead-data");
const CONTAINS = arg("--name-contains");
const EXPECT   = arg("--expect") !== undefined ? Number(arg("--expect")) : undefined;
const CLEARMAP = arg("--clear-map");

if (!WS || !/^[a-fA-F0-9]{24}$/.test(WS)) {
  console.error(
    "--workspace-id <24-hex-id> is required.\n" +
    "Deliberately no name matching: a fuzzy match on a delete is how you wipe the wrong tenant.\n" +
    "Get ids with: curl -s -H \"x-api-key: $PLUSVIBE_API_KEY\" https://api.plusvibe.ai/api/v1/authenticate"
  );
  process.exit(2);
}

const { campaigns, truncated } = await listAllCampaigns({ workspace_id: WS });
if (truncated) {
  console.error("⚠  Campaign list truncated — refusing to delete from a partial view. Raise max_pages.");
  process.exit(3);
}

const rows = campaigns
  .map(c => ({ id: c.id ?? c._id, name: c.camp_name ?? c.name ?? "(unnamed)", status: c.status ?? "?" }))
  .filter(c => c.id)
  .filter(c => !CONTAINS || c.name.includes(CONTAINS));

console.log(`Workspace ${WS}`);
console.log(`${campaigns.length} campaign(s) present, ${rows.length} matching${CONTAINS ? ` name-contains "${CONTAINS}"` : ""}`);

if (!rows.length) { console.log("Nothing to do."); process.exit(0); }

if (EXPECT !== undefined && rows.length !== EXPECT) {
  console.error(
    `\n✖ Expected ${EXPECT} campaign(s), found ${rows.length}. Aborting.\n` +
    `  Something changed since you counted. Re-check before deleting anything.`
  );
  process.exit(4);
}

console.log(`\n${APPLY ? (ARCHIVE ? "ARCHIVING" : "DELETING") : "WOULD DELETE"}:`);
for (const r of rows) console.log(`  ${r.id}  ${String(r.status).padEnd(9)} ${r.name.slice(0, 70)}`);

if (!APPLY) {
  console.log(`\nDry run. Add --apply to ${ARCHIVE ? "archive" : "permanently delete"} these ${rows.length}.`);
  if (EXPECT === undefined) console.log(`Consider --expect ${rows.length} so the count is asserted at delete time.`);
  process.exit(0);
}

let ok = 0;
const failed = [];
for (const r of rows) {
  try {
    await deleteCampaign({
      workspace_id: WS,
      campaign_id: r.id,
      is_archive: ARCHIVE ? "yes" : "no",
      is_save_lead_data: KEEPLEAD ? "yes" : "no",
    });
    ok++;
    console.log(`  ✓ ${r.id}  ${r.name.slice(0, 60)}`);
  } catch (e) {
    failed.push({ ...r, error: e.message });
    console.error(`  ✖ ${r.id}  ${r.name.slice(0, 50)} — ${e.message.slice(0, 120)}`);
  }
}

console.log(`\n${ARCHIVE ? "Archived" : "Deleted"} ${ok}, failed ${failed.length}.`);

// The replay map must go too. Leave it and the next replay skips every campaign
// as "already replayed" against ids that no longer exist — an empty workspace
// and a script insisting there's nothing to do.
if (CLEARMAP) {
  if (existsSync(CLEARMAP)) {
    const backup = `${CLEARMAP}.bak`;
    renameSync(CLEARMAP, backup);
    writeFileSync(CLEARMAP, "{}\n");
    console.log(`Cleared ${CLEARMAP} (previous saved to ${backup})`);
  } else {
    console.log(`No map at ${CLEARMAP} — nothing to clear.`);
  }
} else if (ok) {
  console.log(`\n⚠  Replay map NOT cleared. Re-run with --clear-map <path>, or the next replay`);
  console.log(`   will skip these as already done and leave the workspace empty.`);
}

if (failed.length) process.exit(1);
