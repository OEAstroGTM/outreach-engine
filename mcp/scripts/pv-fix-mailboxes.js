#!/usr/bin/env node
// ── pv-fix-mailboxes.js ──────────────────────────────────────────────────────
// Diagnose and repair mailbox settings in a PlusVibe workspace after an
// Inboxing bulk upload.
//
// Why: the Inboxing → PlusVibe upload was sent with enable_warmup:false, but
// the mailboxes are arriving with warmup ACTIVE and a ~2/day sending limit.
// Warmup-on is the urgent half: these are the SAME physical inboxes that
// EmailBison is still warming, so every one of them is being warmed twice by
// two platforms that can't see each other's volume. Across 76 domains that is
// how you cook the whole sending estate in a week.
//
// Reports by default. Changes nothing unless you pass --apply.
//
// Usage:
//   node mcp/scripts/pv-fix-mailboxes.js --workspace "Inboxing Uploads"
//   node mcp/scripts/pv-fix-mailboxes.js --workspace-id 65f3... --apply --warmup-off
//   node mcp/scripts/pv-fix-mailboxes.js --workspace-id 65f3... --apply --daily-limit 10
//   node mcp/scripts/pv-fix-mailboxes.js --workspace-id 65f3... --apply --warmup-off --watch 120
//
// --watch N re-runs every N seconds until two consecutive passes find nothing
// to fix. Use it while the upload is still streaming in: mailboxes that land
// after an earlier pass still get caught.
import { listWorkspaces, listAllAccounts, bulkSetWarmup, bulkUpdateAccounts } from "../lib/plusvibe.js";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const has        = f => process.argv.includes(f);
const APPLY      = has("--apply");
const WARMUP_OFF = has("--warmup-off");
const DAILY      = arg("--daily-limit") !== undefined ? Number(arg("--daily-limit")) : undefined;
const WATCH      = arg("--watch") !== undefined ? Number(arg("--watch")) : undefined;

if (DAILY !== undefined && (!Number.isFinite(DAILY) || DAILY < 1)) {
  console.error("--daily-limit must be a positive integer.");
  process.exit(2);
}

async function pickWorkspace() {
  const id = arg("--workspace-id");
  if (id) return { id, name: "(by id)" };

  const all  = await listWorkspaces();
  const want = arg("--workspace");
  if (want) {
    const lower = want.toLowerCase();
    const hit = all.find(w => w.name.toLowerCase() === lower)
             ?? all.find(w => w.name.toLowerCase().includes(lower));
    if (!hit) throw new Error(`No workspace matching "${want}". Available:\n` + all.map(w => `  ${w.id}  ${w.name}`).join("\n"));
    return hit;
  }
  if (all.length === 1) return all[0];
  throw new Error(`${all.length} workspaces visible; pass --workspace or --workspace-id.\n` + all.map(w => `  ${w.id}  ${w.name}`).join("\n"));
}

function tally(values) {
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function pass(ws, passNum) {
  const { accounts, truncated } = await listAllAccounts({ workspace_id: ws.id });

  if (truncated) {
    console.log("⚠  Hit the pagination cap — this pass saw only part of the workspace.");
  }

  const warmOn = accounts.filter(a => String(a.warmup_status).toUpperCase() === "ACTIVE");
  const limits = accounts.map(a => a?.payload?.daily_limit ?? null);
  const ramp   = accounts.filter(a => a?.payload?.sending_rampup?.is_slow_rampup);

  console.log(`\n── pass ${passNum} ── ${accounts.length} mailboxes in ${ws.name} (${ws.id})`);
  console.log(`warmup ACTIVE   : ${warmOn.length}`);
  console.log(`daily_limit     : ${tally(limits).map(([v, n]) => `${v}×${n}`).join("  ")}`);
  console.log(`slow rampup on  : ${ramp.length}`);

  if (ramp.length) {
    // A 2/day limit often isn't daily_limit at all — it's a slow-rampup start
    // that overrides it. Fixing daily_limit alone would look successful and
    // still send 2/day, so surface the rampup numbers explicitly.
    const starts = tally(ramp.map(a => a.payload.sending_rampup.rampup_daily_limit ?? null));
    const incs   = tally(ramp.map(a => a.payload.sending_rampup.rampup_daily_inc ?? null));
    console.log(`  rampup start  : ${starts.map(([v, n]) => `${v}×${n}`).join("  ")}`);
    console.log(`  rampup incr   : ${incs.map(([v, n]) => `${v}×${n}`).join("  ")}`);
  }

  let acted = 0;

  if (WARMUP_OFF && warmOn.length) {
    const ids = warmOn.map(a => a._id);
    if (APPLY) {
      const res = await bulkSetWarmup({ workspace_id: ws.id, ids, warmup_status: "INACTIVE" });
      const updated = res.reduce((n, r) => n + (r.updated ?? r.count), 0);
      console.log(`→ warmup INACTIVE applied to ${updated} mailbox(es) in ${res.length} batch(es)`);
      acted += warmOn.length;
    } else {
      console.log(`→ WOULD set warmup INACTIVE on ${ids.length} mailbox(es)  [dry run — add --apply]`);
    }
  }

  if (DAILY !== undefined) {
    // Retarget every mailbox, and turn slow rampup off — otherwise the ramp
    // start keeps capping sends below the limit we just set.
    const ids = accounts.map(a => a._id);
    if (!ids.length) {
      console.log("→ no mailboxes to retarget yet");
    } else if (APPLY) {
      await bulkUpdateAccounts({
        workspace_id: ws.id,
        ids,
        daily_limit: DAILY,
        bulk_is_slow_rampup: "no",
      });
      console.log(`→ daily_limit ${DAILY} + slow rampup off applied to ${ids.length} mailbox(es)`);
      acted += ids.length;
    } else {
      console.log(`→ WOULD set daily_limit=${DAILY} and bulk_is_slow_rampup="no" on ${ids.length} mailbox(es)  [dry run — add --apply]`);
    }
  }

  if (!WARMUP_OFF && DAILY === undefined) {
    console.log("\n(report only — pass --warmup-off and/or --daily-limit N, plus --apply, to change anything)");
  }

  return { accounts: accounts.length, warmOn: warmOn.length, acted };
}

const ws = await pickWorkspace();

if (WATCH === undefined) {
  const r = await pass(ws, 1);
  process.exit(r.warmOn > 0 && !APPLY ? 1 : 0);
}

// Watch mode: keep sweeping until two consecutive quiet passes. Uploads still
// streaming in means a single pass can't be authoritative.
let quiet = 0;
for (let n = 1; ; n++) {
  const r = await pass(ws, n);
  const dirty = WARMUP_OFF ? r.warmOn : 0;
  if (dirty === 0) {
    quiet++;
    if (quiet >= 2) {
      console.log(`\nTwo consecutive clean passes — ${r.accounts} mailboxes, nothing left to fix.`);
      break;
    }
  } else {
    quiet = 0;
  }
  console.log(`(sleeping ${WATCH}s…)`);
  await new Promise(res => setTimeout(res, WATCH * 1000));
}
