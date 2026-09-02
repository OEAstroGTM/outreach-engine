#!/usr/bin/env node
// ── pv-replay-sequences.js ───────────────────────────────────────────────────
// Recreate EmailBison sequences as PlusVibe campaigns, from the export written
// by eb-export-sequences.js.
//
// Safety posture — this writes campaigns into a live sending platform, so:
//   · NO mailboxes are attached. A campaign with no email_accounts cannot send,
//     no matter what else is set. Attaching is a separate, deliberate step.
//   · NO leads are added. Nothing to send to even if a mailbox appeared.
//   · NOTHING is activated. Campaigns land inactive for review.
//   · Every created campaign is recorded in .pv-replay-map.json, so a re-run
//     skips what already exists instead of duplicating 42 campaigns.
//   · Refuses a stale export (the pre-fix one dropped 88 of 214 steps).
//
// Usage:
//   node mcp/scripts/pv-replay-sequences.js --workspace-id 65f3... --only 1166 --dry-run
//   node mcp/scripts/pv-replay-sequences.js --workspace-id 65f3... --only 1166
//   node mcp/scripts/pv-replay-sequences.js --workspace-id 65f3... --only 1166,1153
//   node mcp/scripts/pv-replay-sequences.js --workspace-id 65f3... --status active --all
//   node mcp/scripts/pv-replay-sequences.js --workspace-id 65f3... --all --prefix "OE "
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { listWorkspaces, createCampaign, updateCampaign, listAllCampaigns } from "../lib/plusvibe.js";

function arg(f) { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; }
const has = f => process.argv.includes(f);

const DRY     = has("--dry-run");
const ALL     = has("--all");
const ONLY    = arg("--only")?.split(",").map(s => Number(s.trim())).filter(Boolean);
const PREFIX  = arg("--prefix") ?? "";
const EXPORT  = arg("--export") ?? join(process.cwd(), "data", "eb-export", "outreach-engine", "plusvibe.json");
// The resume map lives beside its export, NOT in a fixed folder — otherwise a
// second client's mappings get written into the first client's directory and
// the two histories interleave in one file.
const MAP     = arg("--map")    ?? join(dirname(EXPORT), ".pv-replay-map.json");

// EB reports max_emails_per_day / max_new_leads_per_day = 50000 uniformly across
// all 17 active OE campaigns. The per-campaign SCHEDULE (timezone, days, hours)
// is not in EB's campaign payload, so these are assumptions — override them.
const DAILY_LIMIT    = Number(arg("--daily-limit") ?? 50000);
const NEW_LEAD_LIMIT = Number(arg("--new-lead-limit") ?? 50000);
const TIMEZONE       = arg("--timezone") ?? "America/Costa_Rica";
const FROM           = arg("--from") ?? "09:00";
const TO             = arg("--to")   ?? "18:00";
const WEEKENDS       = has("--weekends");
// Schema: first_wait_time becomes REQUIRED once sequences is non-empty, and
// first_wait_time_unit (days|minutes) makes the unit explicit.
const FIRST_WAIT      = Number(arg("--first-wait") ?? 0);
const FIRST_WAIT_UNIT = arg("--first-wait-unit") ?? "minutes";
// EB campaigns carry no bounce circuit breaker. OE's newest campaigns are
// bouncing at 7.3%, so default one ON here rather than porting the gap forward.
const BOUNCE_LIMIT    = Number(arg("--bounce-limit") ?? 5);
const START_DATE      = arg("--start-date") ?? new Date().toISOString().slice(0, 10);

if (!ONLY && !ALL) {
  console.error(
    "Refusing to guess scope. Pass one of:\n" +
    "  --only 1166            one campaign (do this first)\n" +
    "  --only 1166,1153       a named set\n" +
    "  --all                  every campaign in the export\n" +
    "Add --status active to restrict --all to campaigns that were active in EB.\n" +
    "Add --dry-run to see the plan without writing."
  );
  process.exit(2);
}

async function pickWorkspace() {
  const id = arg("--workspace-id");
  if (id) return { id, name: "(by id)" };
  const all = await listWorkspaces();
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

/** Strip the _-prefixed provenance keys; PlusVibe may reject unknown fields. */
function cleanSequences(sequences) {
  return sequences.map(s => ({
    step: s.step,
    wait_time: s.wait_time,
    variations: s.variations.map(v => ({
      variation: v.variation,
      subject: v.subject,
      name: v.name ?? "",
      body: v.body,
    })),
  }));
}

// ── Load + validate the export ───────────────────────────────────────────────
if (!existsSync(EXPORT)) {
  console.error(`No export at ${EXPORT}\nRun: node mcp/scripts/eb-export-sequences.js --client "Outreach Engine"`);
  process.exit(2);
}
const all = JSON.parse(readFileSync(EXPORT, "utf8"));

const stale = all.filter(c => !c.compat || !Array.isArray(c.disable_variations));
if (stale.length) {
  console.error(
    `✖ ${EXPORT} was written by the pre-fix exporter (missing compat/disable_variations on ${stale.length} campaign(s)).\n` +
    `  That export dropped 88 of 214 steps — every A/B variant. Regenerate first:\n` +
    `    node mcp/scripts/eb-export-sequences.js --client "Outreach Engine"`
  );
  process.exit(3);
}

let targets = ONLY
  ? ONLY.map(id => {
      const hit = all.find(c => c.source_campaign_id === id);
      if (!hit) { console.error(`Campaign ${id} not in the export.`); process.exit(2); }
      return hit;
    })
  : all;

const STATUS = arg("--status");
if (!ONLY && STATUS) targets = targets.filter(c => (c.status ?? "") === STATUS);

// ── Resume map ───────────────────────────────────────────────────────────────
const map = existsSync(MAP) ? JSON.parse(readFileSync(MAP, "utf8")) : {};
const already = targets.filter(c => map[c.source_campaign_id]);
if (already.length) {
  console.log(`Skipping ${already.length} already replayed (in ${MAP}):`);
  for (const c of already) console.log(`  EB ${c.source_campaign_id} → PV ${map[c.source_campaign_id].pv_campaign_id}`);
  targets = targets.filter(c => !map[c.source_campaign_id]);
}

if (!targets.length) { console.log("\nNothing left to replay."); process.exit(0); }

const ws = await pickWorkspace();
console.log(`\nWorkspace: ${ws.name} (${ws.id})`);
console.log(`Replaying ${targets.length} campaign(s)${DRY ? "  [DRY RUN — no writes]" : ""}\n`);

// ── The unverified-syntax warning ────────────────────────────────────────────
const spinD = targets.reduce((n, c) => n + c.compat.spintax_double, 0);
const spinS = targets.reduce((n, c) => n + c.compat.spintax_single, 0);
const tags  = [...new Set(targets.flatMap(c => c.compat.merge_tags))].sort();
const fromInstantly = targets.some(c => c.source_platform === "instantly");
if (spinD || spinS) {
  if (fromInstantly) {
    // Instantly's {{RANDOM|…}} is already valid PlusVibe — its keyword is
    // case-insensitive — so these carried over untranslated by design.
    console.log(`   ${spinD} spintax section(s), already in PlusVibe form ({{RANDOM|…}} — keyword is case-insensitive).`);
    console.log(`   Still worth one real send to confirm expansion before relying on ${targets.length} campaigns.\n`);
  } else {
    console.log(`⚠  ${spinD} × {{a|b}} and ${spinS} × {a|b} spintax` +
                (tags.length ? `, plus merge tags ${tags.join(" ")}` : "") + `.`);
    console.log(`   These are EmailBison syntax. If PlusVibe doesn't parse them, the copy ships with`);
    console.log(`   raw braces. Verify ONE campaign end-to-end (pv-smoke-test.js) before doing ${targets.length}.\n`);
  }
}

// Schema: days keys match ^[1-7]$ where "1" = Monday … "7" = Sunday, with
// additionalProperties:false. A "0" key (the usual JS Sunday) is REJECTED.
const days = WEEKENDS
  ? { "1": true, "2": true, "3": true, "4": true, "5": true, "6": true, "7": true }
  : { "1": true, "2": true, "3": true, "4": true, "5": true };

// A campaign created by an earlier run that died before its map entry was
// written is invisible to the resume map — recreating it would duplicate. Index
// what's already in the workspace by name and adopt matches instead.
let existing = new Map();
if (!DRY) {
  try {
    const { campaigns, truncated } = await listAllCampaigns({ workspace_id: ws.id });
    for (const c of campaigns) {
      const nm = c.camp_name ?? c.name;
      const id = c.id ?? c._id;
      if (!nm || !id) continue;
      if (!existing.has(nm)) existing.set(nm, []);
      existing.get(nm).push(id);
    }
    console.log(`Workspace already holds ${campaigns.length} campaign(s)${truncated ? " (list truncated)" : ""}\n`);
  } catch (e) {
    console.log(`Could not list existing campaigns (${e.message}) — proceeding without adoption.\n`);
  }
}

const done = [];
const adopted = [];
const failed = [];
const partial = [];

for (const c of targets) {
  const name = `${PREFIX}${c.camp_name}`.slice(0, 120);
  const sequences = cleanSequences(c.sequences);
  const varCount = sequences.reduce((n, s) => n + s.variations.length, 0);

  if (DRY) {
    console.log(`  EB ${c.source_campaign_id}  →  "${name}"`);
    console.log(`      ${sequences.length} steps / ${varCount} variations / ${c.disable_variations.length} disabled` +
                `  waits ${sequences.map(s => s.wait_time).join("-")}d` +
                `  first_wait ${FIRST_WAIT} ${FIRST_WAIT_UNIT}  bounce-pause @${BOUNCE_LIMIT}%`);
    continue;
  }

  try {
    const hits = existing.get(name) ?? [];
    if (hits.length > 1) {
      throw new Error(`${hits.length} existing campaigns share the name "${name}" — refusing to guess which to adopt. Delete the duplicates in PlusVibe.`);
    }

    let pvId, wasAdopted = false;
    if (hits.length === 1) {
      pvId = hits[0];
      wasAdopted = true;
    } else {
      const created = await createCampaign({ workspace_id: ws.id, camp_name: name });
      pvId = created.id ?? created._id;
      if (!pvId) throw new Error(`no campaign id returned: ${JSON.stringify(created).slice(0, 200)}`);
    }

    await updateCampaign({
      workspace_id: ws.id,
      campaign_id: pvId,
      sequences,
      ...c.settings,
      first_wait_time: FIRST_WAIT,
      first_wait_time_unit: FIRST_WAIT_UNIT,
      // EB ran sequence_prioritization: new_leads → 0 = 100% new lead.
      send_priority: 0,
      // Land paused explicitly rather than trusting the default.
      status: "PAUSED",
      is_pause_on_bouncerate: "yes",
      bounce_rate_limit: BOUNCE_LIMIT,
      // Deliberately absent: email_accounts. Without mailboxes this cannot send.
      // start_date is REQUIRED by the live API despite not being listed as
      // required in the published schema.
      schedules: [{
        daily_limit: DAILY_LIMIT,
        daily_limit_new_lead: NEW_LEAD_LIMIT,
        start_date: START_DATE,
        end_date: "",
        days,
        timezone: TIMEZONE,
        timing: { from: FROM, to: TO },
      }],
    });

    // Record the mapping NOW. The campaign exists and is configured; anything
    // that fails after this point is a fixable follow-up, not a reason to
    // recreate it on the next run.
    map[c.source_campaign_id] = {
      pv_campaign_id: pvId,
      pv_name: name,
      steps: sequences.length,
      variations: varCount,
      disabled: c.disable_variations.length,
      adopted: wasAdopted || undefined,
    };
    writeFileSync(MAP, JSON.stringify(map, null, 2));

    // disable_variations goes one object per call (the schema defines it as a
    // single object, not an array). first_wait_time must ride along: once the
    // campaign HAS sequences, the API requires it on every subsequent PATCH —
    // omitting it 400s with "first_wait_time is required" even though this call
    // sends no sequences at all.
    let disableFailed = null;
    for (const dv of c.disable_variations) {
      try {
        await updateCampaign({
          workspace_id: ws.id,
          campaign_id: pvId,
          first_wait_time: FIRST_WAIT,
          first_wait_time_unit: FIRST_WAIT_UNIT,
          disable_variations: dv,
        });
      } catch (e) {
        disableFailed = e.message;
        break;
      }
    }

    if (disableFailed) {
      partial.push({ id: c.source_campaign_id, pvId, error: disableFailed });
      console.log(`  ⚠ EB ${c.source_campaign_id} → PV ${pvId}   configured, but disabling variations failed   ${name.slice(0, 44)}`);
    } else {
      (wasAdopted ? adopted : done).push(c.source_campaign_id);
      console.log(`  ${wasAdopted ? "↻" : "✓"} EB ${c.source_campaign_id} → PV ${pvId}   ${sequences.length} steps / ${varCount} variations` +
                  (c.disable_variations.length ? ` / ${c.disable_variations.length} disabled` : "") +
                  (wasAdopted ? "  [adopted]" : "") + `   ${name.slice(0, 44)}`);
    }
  } catch (e) {
    failed.push({ id: c.source_campaign_id, error: e.message });
    console.error(`  ✖ EB ${c.source_campaign_id} FAILED — ${e.message}`);
  }
}

if (DRY) {
  console.log(`\nDry run only. Re-run without --dry-run to create these ${targets.length} campaign(s).`);
  process.exit(0);
}

console.log(`\nCreated ${done.length}, adopted ${adopted.length}, partial ${partial.length}, failed ${failed.length}. Map: ${MAP}`);
if (partial.length) {
  console.error(`\n⚠  ${partial.length} campaign(s) configured but their disabled A/B variations did not apply:`);
  for (const p of partial) console.error(`   EB ${p.id} → PV ${p.pvId}: ${p.error.slice(0, 140)}`);
  console.error(`   They ARE in the map, so a re-run adopts them and retries only the disable step.`);
}
if (failed.length) {
  for (const f of failed) console.error(`   ${f.id}: ${f.error}`);
  console.error(`\nRe-running skips the ${done.length} that succeeded — only the failures retry.`);
}
console.log(`
Campaigns are inactive with NO mailboxes and NO leads — they cannot send yet.
Next, per campaign you actually want live:
  1. open it in PlusVibe and read the rendered copy (spintax + merge tags)
  2. attach mailboxes  (PATCH /campaign/update/campaign  email_accounts: [...])
  3. push leads        (POST /lead/add)
  4. activate
`);
if (failed.length) process.exit(1);
