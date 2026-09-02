#!/usr/bin/env node
// ── eb-export-sequences.js ───────────────────────────────────────────────────
// Export EmailBison sequence copy for a client's live campaigns, and emit the
// PlusVibe-shaped translation alongside it.
//
// Why: the lead-gen MCP can CREATE and UPDATE EmailBison sequence steps but has
// no read path, so campaign copy is invisible to tooling — it only exists in the
// EB UI. Phase 2 of the PlusVibe migration is replaying 40+ sequences, which is
// impossible to review or diff until the copy is on disk. This puts it there.
//
// Outputs (under data/eb-export/<client-slug>/):
//   sequences.json   raw EB payloads, one per campaign
//   plusvibe.json    the same sequences translated to PlusVibe's schema
//   copy.md          human-readable digest: subjects, delays, body previews
//
// Usage:
//   node mcp/scripts/eb-export-sequences.js --client "Outreach Engine"
//   node mcp/scripts/eb-export-sequences.js --client "Outreach Engine" --status active
//   node mcp/scripts/eb-export-sequences.js --client "Outreach Engine" --probe-only
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getClient, ebConfig, ebSwitchWorkspace, ebRaw, ebPaginate } from "../lib/core.js";

function arg(f) { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; }
const CLIENT_NAME = arg("--client") ?? "Outreach Engine";
const STATUS      = arg("--status");              // active | paused | undefined = both
const PROBE_ONLY  = process.argv.includes("--probe-only");
const OUT_ROOT    = join(process.cwd(), "data", "eb-export");

// Confirmed against the OE workspace on 2026-08-06: EmailBison serves sequence
// steps at /campaigns/{campaign_id}/sequence-steps. It isn't in the MCP toolset
// (which only exposes create/update), so the fallbacks stay as a safety net in
// case the route differs by instance or moves.
const CANDIDATES = [
  (c, s) => `/campaigns/${c}/sequence-steps`,   // ← confirmed
  (c, s) => `/sequences/${s}`,
  (c, s) => `/sequences/${s}/steps`,
  (c, s) => `/sequences/${s}/sequence-steps`,
  (c, s) => `/campaigns/${c}/sequence`,
  (c, s) => `/campaigns/${c}/steps`,
];

/** Pull a step array out of whatever envelope EB used. */
function extractSteps(payload) {
  if (!payload || typeof payload !== "object") return null;
  const pools = [
    payload.sequence_steps,
    payload.steps,
    payload.data?.sequence_steps,
    payload.data?.steps,
    Array.isArray(payload.data) ? payload.data : null,
    Array.isArray(payload) ? payload : null,
  ];
  for (const p of pools) {
    if (Array.isArray(p) && p.length && (p[0].email_subject !== undefined || p[0].email_body !== undefined)) {
      return p;
    }
  }
  return null;
}

const client = getClient(CLIENT_NAME);
const cfg    = ebConfig(client);
await ebSwitchWorkspace(cfg, client);
console.log(`Client: ${client.name}  (eb_ws_id ${cfg.ws_id}, key ${cfg.key_source})`);

// Campaign index — MUST paginate. /campaigns serves 15 rows per page, so a bare
// GET silently returns page 1 and an export of "15 campaigns" looks complete
// while missing two thirds of the workspace.
const idx = await ebPaginate(client, "/campaigns", { all: true });
const all = idx.rows;
const live = all.filter(c =>
  STATUS ? c.status === STATUS : (c.status === "active" || c.status === "paused")
);
console.log(
  `Campaigns: ${all.length} fetched of ${idx.total} reported ` +
  `(${idx.pages_fetched}/${idx.last_page} pages), ${live.length} matching` +
  `${STATUS ? ` status=${STATUS}` : " (active+paused)"}`
);
if (idx.truncated) {
  console.error("\n⚠  Campaign index truncated — raise maxPages. Refusing to export a partial set.");
  process.exit(3);
}

if (!live.length) { console.error("Nothing to export."); process.exit(1); }

// ── Probe the read route once, on the first campaign ─────────────────────────
let winner = null;
{
  const c = live[0];
  for (const build of CANDIDATES) {
    const path = build(c.id, c.sequence_id);
    try {
      const r = await ebRaw(cfg, "GET", path);
      if (extractSteps(r)) { winner = build; console.log(`Sequence read route: ${path.replace(String(c.id), "{campaign_id}").replace(String(c.sequence_id), "{sequence_id}")}`); break; }
    } catch { /* try next */ }
  }
}

if (!winner) {
  console.error(
    "\nNone of the candidate routes returned sequence steps. Tried:\n" +
    CANDIDATES.map(b => "  " + b("{campaign_id}", "{sequence_id}")).join("\n") +
    "\n\nOpen one campaign in the EB UI with devtools on the Network tab, find the request\n" +
    "that loads the sequence, and add its path to CANDIDATES."
  );
  process.exit(2);
}
if (PROBE_ONLY) process.exit(0);

// ── Fetch every sequence ─────────────────────────────────────────────────────
const exported = [];
for (const c of live) {
  try {
    const raw   = await ebRaw(cfg, "GET", winner(c.id, c.sequence_id));
    const steps = extractSteps(raw) ?? [];
    exported.push({ campaign_id: c.id, sequence_id: c.sequence_id, name: c.name, status: c.status,
                    emails_sent: c.emails_sent, unique_replies: c.unique_replies, steps, raw });
    console.log(`  ${String(c.id).padStart(5)}  ${String(steps.length).padStart(2)} step(s)  ${c.name.slice(0, 62)}`);
  } catch (e) {
    exported.push({ campaign_id: c.id, sequence_id: c.sequence_id, name: c.name, status: c.status, error: e.message, steps: [] });
    console.log(`  ${String(c.id).padStart(5)}  FAILED  ${c.name.slice(0, 62)} — ${e.message}`);
  }
}

// ── Translate EB → PlusVibe ──────────────────────────────────────────────────
// EB models A/B as sibling steps flagged `variant`, linked to their base by
// `variant_from_step` — which holds the base step's ID. (The write-side schema
// also documents `variant_from_step_id`, but the READ payload uses
// `variant_from_step`. Keying on the wrong one silently drops every variant:
// 88 of 214 steps in the OE workspace.) PlusVibe nests them as `variations`.
//
// EB `order` is NOT unique — a base and a variant can share order 2 — so steps
// are grouped by base identity, never by order.
//
// EB `active: false` marks a LOST A/B test. Those must not come across as live
// variations; PlusVibe expresses the same idea via `disable_variations`.
const LETTERS = "ABCDEFGH";

function toPlusVibe(steps) {
  const bases = steps.filter(s => !s.variant)
    .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.id - b.id);
  const variants = steps.filter(s => s.variant);
  const disable_variations = [];

  // Six variants in the June-era OE campaigns carry variant: true with
  // variant_from_step: null — EB lost the linkage on those older records. They
  // are step-1 variants: same wait, same subject, thread_reply false, and in
  // campaign 750 their identically-shaped siblings (3886/3887) DO point at the
  // order-1 base. Attach them there rather than dropping the copy, but mark them
  // so the three affected campaigns get eyeballed instead of trusted.
  const baseIds  = new Set(bases.map(b => b.id));
  const dangling = variants.filter(v => !baseIds.has(v.variant_from_step));

  const sequences = bases.map((base, i) => {
    const own = variants.filter(v => v.variant_from_step === base.id);
    const inherited = i === 0 ? dangling : [];
    const mine = [...own, ...inherited]
      .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || a.id - b.id);
    const group = [base, ...mine];
    const stepNo = i + 1;

    const variations = group.map((s, j) => {
      const letter = LETTERS[j] ?? String(j);
      if (s.active === false) {
        disable_variations.push({ step: stepNo, variation: letter, is_active: "no" });
      }
      return {
        variation: letter,
        // PlusVibe signals "continue the thread" with an empty subject. EB stores
        // a real "Re: …" subject on those steps, so it's blanked here — but kept
        // in _eb_subject so the pilot can confirm PlusVibe threads rather than
        // sending a literal "Re: {FIRST_NAME}" as a fresh subject.
        subject: s.thread_reply ? "" : (s.email_subject ?? ""),
        name: "",
        body: s.email_body ?? "",
        _eb_step_id: s.id,
        _eb_subject: s.email_subject ?? "",
        _eb_active: s.active !== false,
        ...(s.variant && !baseIds.has(s.variant_from_step) ? { _inferred_attachment: true } : {}),
      };
    });

    return { step: stepNo, wait_time: base.wait_in_days ?? 0, variations };
  });

  const placed = new Set(sequences.flatMap(s => s.variations.map(v => v._eb_step_id)));
  const orphans = steps.filter(s => !placed.has(s.id));

  return { sequences, disable_variations, orphans, inferred: dangling.length };
}

// ── Compatibility scan ───────────────────────────────────────────────────────
// Spintax and merge tags are EmailBison syntax. If PlusVibe parses either
// differently, prospects receive raw braces — the most visible possible failure.
// Counted per campaign so no sequence can be replayed without someone seeing it.
const RE_SPIN_DOUBLE = /\{\{[^{}]*\|[^{}]*\}\}/g;
const RE_SPIN_SINGLE = /(?<!\{)\{[^{}|]*\|[^{}]*\}(?!\})/g;
const RE_MERGE_TAG   = /\{[A-Z_]+\}/g;

function scanCompat(steps) {
  const blob = steps.map(s => `${s.email_body ?? ""} ${s.email_subject ?? ""}`).join(" ");
  const tags = [...new Set(blob.match(RE_MERGE_TAG) ?? [])].sort();
  return {
    spintax_double: (blob.match(RE_SPIN_DOUBLE) ?? []).length,
    spintax_single: (blob.match(RE_SPIN_SINGLE) ?? []).length,
    merge_tags: tags,
    stale_calendly_month: (blob.match(/calendly\.com[^\s"']*month=\d{4}-\d{2}/g) ?? []).length,
  };
}

const pv = exported.filter(e => e.steps.length).map(e => {
  const { sequences, disable_variations, orphans, inferred } = toPlusVibe(e.steps);
  return {
    source_campaign_id: e.campaign_id,
    camp_name: e.name,
    // EB's step-1 wait_in_days is the initial delay. PlusVibe's own example shows
    // first_wait_time: 60 alongside per-step wait_time: 1, which reads like
    // MINUTES vs DAYS — do NOT trust this field until one campaign is verified in
    // the PlusVibe UI. Left null deliberately rather than guessing wrong.
    first_wait_time: null,
    sequences,
    disable_variations,
    // Uniform across every active OE campaign, read from the EB campaign objects.
    settings: {
      send_as_txt:            "yes",  // EB plain_text = true
      is_emailopened_tracking:"no",   // EB open_tracking = false
      is_unsubscribed_link:   "no",   // EB can_unsubscribe = false
      stop_on_lead_replied:   "yes",
      var_sel_type:           "R_ROBIN",
    },
    compat: scanCompat(e.steps),
    _orphan_step_ids: orphans.map(o => o.id),
    _inferred_attachments: inferred,
    _step_count_eb: e.steps.length,
    _variation_count_pv: sequences.reduce((n, s) => n + s.variations.length, 0),
  };
});

// Every EB step must land somewhere. If the counts don't reconcile, copy was
// dropped — refuse to present the export as usable.
const lost = pv.filter(p => p._step_count_eb !== p._variation_count_pv);

// ── Write ────────────────────────────────────────────────────────────────────
const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dir  = join(OUT_ROOT, slug);
mkdirSync(dir, { recursive: true });

writeFileSync(join(dir, "sequences.json"), JSON.stringify(exported, null, 2));
writeFileSync(join(dir, "plusvibe.json"),  JSON.stringify(pv, null, 2));

const md = [];
md.push(`# ${client.name} — EmailBison sequence copy`);
md.push(`\n${exported.length} campaigns, ${exported.filter(e => e.steps.length).length} with readable steps.\n`);
for (const e of exported) {
  md.push(`\n## ${e.name}`);
  md.push(`\`campaign ${e.campaign_id}\` · \`sequence ${e.sequence_id}\` · ${e.status} · ${e.emails_sent ?? "?"} sent · ${e.unique_replies ?? "?"} replies`);
  if (e.error) { md.push(`\n> export failed: ${e.error}`); continue; }
  const ordered = [...e.steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const s of ordered) {
    const tag = s.variant ? `variant of step id ${s.variant_from_step_id}` : `step ${s.order}`;
    md.push(`\n**${tag}** · wait ${s.wait_in_days}d${s.thread_reply ? " · thread reply" : ""}`);
    md.push(`\n- Subject: ${s.email_subject ? "`" + s.email_subject + "`" : "_(empty — threads on previous)_"}`);
    const body = String(s.email_body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    md.push(`- Body: ${body.slice(0, 600)}${body.length > 600 ? " …" : ""}`);
  }
}
writeFileSync(join(dir, "copy.md"), md.join("\n") + "\n");

const stepCounts = exported.filter(e => e.steps.length).map(e => e.steps.length);
const ebSteps = pv.reduce((n, p) => n + p._step_count_eb, 0);
const pvVars  = pv.reduce((n, p) => n + p._variation_count_pv, 0);
const disabled = pv.reduce((n, p) => n + p.disable_variations.length, 0);

console.log(`\nWrote ${dir}/{sequences.json, plusvibe.json, copy.md}`);
console.log(`Steps per campaign: min ${Math.min(...stepCounts)}, max ${Math.max(...stepCounts)}`);
console.log(`Campaigns with unreadable sequences: ${exported.filter(e => !e.steps.length).length}`);
console.log(`\nReconciliation: ${ebSteps} EB steps → ${pvVars} PlusVibe variations` +
            `  (${disabled} carried as disabled A/B losers)`);

if (lost.length) {
  console.error(`\n✖ ${lost.length} campaign(s) lost copy in translation — DO NOT replay this export:`);
  for (const p of lost) {
    console.error(`   ${p.source_campaign_id}  ${p._step_count_eb} EB steps → ${p._variation_count_pv} variations` +
                  (p._orphan_step_ids.length ? `  orphan step ids: ${p._orphan_step_ids.join(", ")}` : ""));
  }
  process.exit(4);
}
console.log("✓ every EB step accounted for");

const inf = pv.filter(p => p._inferred_attachments > 0);
if (inf.length) {
  console.log(`\n⚠  ${inf.length} campaign(s) had variants with a null variant_from_step; attached to step 1 by inference:`);
  for (const p of inf) console.log(`   ${p.source_campaign_id}  ${p._inferred_attachments} variant(s)  ${p.camp_name.slice(0, 54)}`);
  console.log(`   Grep _inferred_attachment in plusvibe.json and confirm before replaying these.`);
}

// ── Blockers a human must clear before bulk replay ───────────────────────────
const spinD = pv.reduce((n, p) => n + p.compat.spintax_double, 0);
const spinS = pv.reduce((n, p) => n + p.compat.spintax_single, 0);
const tags  = [...new Set(pv.flatMap(p => p.compat.merge_tags))].sort();
const stale = pv.reduce((n, p) => n + p.compat.stale_calendly_month, 0);

console.log(`\n── verify before replaying ${pv.length} campaigns ──`);
console.log(`spintax:     ${spinD} × {{a|b}}  +  ${spinS} × {a|b}   in ${pv.filter(p => p.compat.spintax_double || p.compat.spintax_single).length}/${pv.length} campaigns`);
console.log(`             → EmailBison syntax. Confirm PlusVibe parses BOTH forms, or prospects get raw braces.`);
console.log(`merge tags:  ${tags.join(" ")}`);
console.log(`             → EmailBison single-brace UPPER_CASE. Confirm PlusVibe's token syntax matches.`);
console.log(`first_wait_time: null on purpose — verify days-vs-minutes on one campaign.`);
console.log(`thread steps: subject blanked, original kept in _eb_subject — confirm PlusVibe threads rather than sending a bare subject.`);
if (stale) console.log(`stale links: ${stale} calendly URL(s) pin ?month= to a past month — fix before replay, it shows prospects an empty calendar.`);
