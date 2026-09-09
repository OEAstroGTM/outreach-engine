#!/usr/bin/env node
// ── pv-smoke-test.js ─────────────────────────────────────────────────────────
// Build ONE campaign in PlusVibe from the EmailBison export and send it to
// yourself, to settle the four unknowns that block replaying all 42:
//
//   1. SPINTAX      — 110 × {{a|b}} and 31 × {a|b} exist in every OE campaign.
//                     Does PlusVibe expand either? If not, prospects get braces.
//   2. MERGE TAGS   — EB uses single-brace UPPERCASE ({FIRST_NAME}, {COMPANY}).
//                     Does PlusVibe resolve them, or print them literally?
//   3. THREADING    — EB stores "Re: {FIRST_NAME}" on follow-ups; we blank the
//                     subject because that's how PlusVibe signals "thread".
//                     Does it actually thread, or send a subjectless email?
//   4. first_wait_time — PlusVibe's docs show 60 next to per-step wait_time: 1,
//                     which reads like minutes vs days. Which is it?
//
// Leads are seeded with obvious sentinel values, so the rendered email tells you
// the answer at a glance: seeing ACME_SENTINEL_CO means tokens resolve; seeing
// {COMPANY} means they don't.
//
// Creates a campaign named "[SMOKE] …". Does NOT activate unless you pass
// --activate, because activating is what makes it send.
//
// Usage:
//   node mcp/scripts/pv-smoke-test.js --workspace "Inboxing Uploads" --to you@yourdomain.com
//   node mcp/scripts/pv-smoke-test.js --workspace-id 65f3... --to me@x.com --campaign 1166
//   node mcp/scripts/pv-smoke-test.js --workspace-id 65f3... --to me@x.com --activate
import { readFileSync } from "fs";
import { join } from "path";
import {
  listWorkspaces, listAllAccounts, listCampaigns,
  createCampaign, updateCampaign, addLeads, pvFetch, accountId,
} from "../lib/plusvibe.js";

function arg(f) { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; }
const TO       = arg("--to");
const EB_ID    = arg("--campaign") ? Number(arg("--campaign")) : 1166;
const ACTIVATE = process.argv.includes("--activate");
const FIRST_WAIT = arg("--first-wait") !== undefined ? Number(arg("--first-wait")) : undefined;
const FIRST_WAIT_UNIT = arg("--first-wait-unit") ?? "minutes";
const START_DATE = arg("--start-date") ?? new Date().toISOString().slice(0, 10);
const EXPORT   = arg("--export") ?? join(process.cwd(), "data", "eb-export", "outreach-engine", "plusvibe.json");

if (!TO || !TO.includes("@")) {
  console.error("--to <your-email> is required. The smoke test mails you, nobody else.");
  process.exit(2);
}

// Sentinel values: recognisable enough that a literal token is unmistakable.
const SENTINELS = {
  company_name: "ACME_SENTINEL_CO",
  industry:     "SENTINEL_INDUSTRY",
  first_name:   "SentinelFirst",
  last_name:    "SentinelLast",
};

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

/** Drop the _-prefixed provenance keys — PlusVibe may reject unknown fields. */
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

const ws = await pickWorkspace();
console.log(`Workspace: ${ws.name} (${ws.id})`);

const all = JSON.parse(readFileSync(EXPORT, "utf8"));
const src = all.find(c => c.source_campaign_id === EB_ID);
if (!src) {
  console.error(`Campaign ${EB_ID} not in ${EXPORT}. Available: ${all.map(c => c.source_campaign_id).join(", ")}`);
  process.exit(2);
}

// The pre-fix exporter dropped every A/B variant and emitted neither
// disable_variations nor compat. Replaying that file would ship 1 variation per
// step instead of 3 and silently resurrect disabled losers — refuse it.
if (!src.compat || !Array.isArray(src.disable_variations)) {
  console.error(
    `\n✖ ${EXPORT} was written by the pre-fix exporter (no compat/disable_variations).\n` +
    `  That export dropped 88 of 214 steps. Regenerate first:\n` +
    `    node mcp/scripts/eb-export-sequences.js --client "Outreach Engine"\n`
  );
  process.exit(5);
}

const varCount = src.sequences.reduce((n, s) => n + s.variations.length, 0);
console.log(`Source: EB ${EB_ID} — ${src.camp_name}`);
console.log(`        ${src.sequences.length} steps, ${varCount} variations, ${src.disable_variations.length} disabled`);
console.log(`        spintax: ${src.compat.spintax_double} × {{a|b}}, ${src.compat.spintax_single} × {a|b}`);
console.log(`        merge tags: ${src.compat.merge_tags.join(" ")}`);

// One mailbox is enough, and keeps the blast radius at exactly one send.
const { accounts } = await listAllAccounts({ workspace_id: ws.id, page_size: 100, max_pages: 1 });
if (!accounts.length) {
  console.error("No mailboxes in this workspace — nothing can send. Check the upload landed first.");
  process.exit(3);
}
const mailbox = accounts[0];
let mailboxId;
try {
  mailboxId = accountId(mailbox);
} catch (e) {
  console.error(`\n${e.message}\n\nFirst mailbox object:`);
  console.error(JSON.stringify(mailbox, null, 2).slice(0, 1200));
  process.exit(6);
}
console.log(`Sending mailbox: ${mailbox.email} (${mailboxId}) — warmup ${mailbox.warmup_status}`);

// ── Create ───────────────────────────────────────────────────────────────────
const name = `[SMOKE] ${src.camp_name}`.slice(0, 120);
const created = await createCampaign({ workspace_id: ws.id, camp_name: name });
const campaign_id = created.id ?? created._id;
if (!campaign_id) {
  console.error("No campaign id returned:", JSON.stringify(created).slice(0, 300));
  process.exit(4);
}
console.log(`\nCreated campaign ${campaign_id}  "${name}"`);

// ── Configure ────────────────────────────────────────────────────────────────
const patch = {
  workspace_id: ws.id,
  campaign_id,
  sequences: cleanSequences(src.sequences),
  email_accounts: [mailboxId],
  ...src.settings,
  // days keys are "1"=Monday … "7"=Sunday, and the schema sets
  // additionalProperties:false — a "0" key is rejected outright.
  // start_date is REQUIRED by the live API even though the published schema
  // lists only daily_limit/days/timezone/timing as required.
  schedules: [{
    daily_limit: 10,
    daily_limit_new_lead: 10,
    start_date: START_DATE,
    end_date: "",
    days: { "1": true, "2": true, "3": true, "4": true, "5": true, "6": true, "7": true },
    timezone: "America/Costa_Rica",
    timing: { from: "00:00", to: "23:59" },
  }],
  // The schema says first_wait_time becomes REQUIRED once sequences is
  // non-empty, so it is always sent. first_wait_time_unit settles the
  // days-vs-minutes ambiguity outright — no guessing needed.
  first_wait_time: FIRST_WAIT ?? 0,
  first_wait_time_unit: FIRST_WAIT_UNIT,
  // EB ran sequence_prioritization: new_leads → 0 = 100% new lead.
  send_priority: 0,
};
await updateCampaign(patch);
console.log(`Configured: ${patch.sequences.length} steps, 1 mailbox, first_wait_time=${patch.first_wait_time} ${FIRST_WAIT_UNIT}, send_priority=0`);

// PlusVibe documents disable_variations as a single OBJECT, not an array, so
// send them one call at a time rather than assuming it accepts a list.
for (const dv of src.disable_variations) {
  await updateCampaign({ workspace_id: ws.id, campaign_id, disable_variations: dv });
}
if (src.disable_variations.length) {
  console.log(`Disabled ${src.disable_variations.length} losing A/B variation(s), one call each`);
}

// ── Seed one lead: you ───────────────────────────────────────────────────────
const res = await addLeads({
  workspace_id: ws.id,
  campaign_id,
  skip_if_in_workspace: false,
  leads: [{
    email: TO,
    first_name: SENTINELS.first_name,
    last_name:  SENTINELS.last_name,
    company_name: SENTINELS.company_name,
    custom_variables: { industry: SENTINELS.industry, INDUSTRY: SENTINELS.industry },
  }],
});
console.log(`Seeded lead ${TO}: uploaded ${res.leads_uploaded ?? "?"}, skipped ${res.skipped ?? 0}, invalid ${res.invalid_email_count ?? 0}`);
if (!res.leads_uploaded) {
  console.error("⚠  Lead did not upload — nothing will send. Response:", JSON.stringify(res).slice(0, 300));
}

// ── Activate (opt-in) ────────────────────────────────────────────────────────
if (ACTIVATE) {
  await pvFetch("POST", "/campaign/activate", { workspace_id: ws.id, campaign_id });
  console.log(`\n▶  ACTIVATED — step 1 should arrive at ${TO} shortly.`);
} else {
  console.log(`\n⏸  Left inactive. Review the copy in the PlusVibe UI, then either:`);
  console.log(`     re-run with --activate, or hit Activate in the UI.`);
}

// ── What to look for ─────────────────────────────────────────────────────────
console.log(`
── check the received email against these four ────────────────────────────────
1. SPINTAX
   Step 2 body should read as ONE sentence, e.g. "Following up in case my last
   email got buried somewhere between another mystery in Glass Onion."
   ✗ FAIL if you see the whole {option one|option two|option three} block.
   Also check the sender title: "${'{{'}Growth Lead|Head of Outbound|…${'}}'}" must
   collapse to a single title. Both syntaxes have to work, not just one.

2. MERGE TAGS
   Greeting should be "Hi ${SENTINELS.first_name},"  and any company reference
   should read "${SENTINELS.company_name}".
   ✗ FAIL if you see literal {FIRST_NAME} or {COMPANY}. If tags fail, every
   body needs rewriting to PlusVibe's token syntax before replay.

3. THREADING  (needs steps 2–3, so wait out the 1–2 day waits, or shorten
   wait_time in a second smoke run)
   Follow-ups should land in the SAME thread as step 1.
   ✗ FAIL if they arrive as separate emails with a blank subject — that means
   PlusVibe needs the "Re: …" subject preserved instead of blanked.

4. first_wait_time
   Resolved by the spec: there is a first_wait_time_unit field (days|minutes),
   so no inference needed. This run sent ${'${patch.first_wait_time}'} ${'${FIRST_WAIT_UNIT}'}.
   Override with --first-wait N --first-wait-unit days|minutes.

Delete the [SMOKE] campaign in the UI when done so it can't collect real leads.
`);
