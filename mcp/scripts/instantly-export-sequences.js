#!/usr/bin/env node
// ── instantly-export-sequences.js ────────────────────────────────────────────
// Export Instantly campaign copy and translate it to PlusVibe syntax, emitting
// the SAME intermediate format as eb-export-sequences.js + pv-translate-copy.js
// so pv-replay-sequences.js works on it unchanged.
//
// Why this is a separate script rather than a --source flag on the EmailBison
// path: the three dialects barely overlap.
//
//   EmailBison   {FIRST_NAME}         {a|b}  and  {{a|b}}
//   Instantly    {{firstName}}        {{RANDOM|a|b}}      {#"now" | date: "%A"#}
//   PlusVibe     {{first_name}}       {{random|a|b}}      {{pipl_day_of_week}}
//
// The good news: Instantly's spintax is ALREADY valid PlusVibe. PlusVibe's
// Spintax Guide states the keyword is not case-sensitive ("{{RANDOM|",
// "{{random|" and "{{rAnDoM|" are all accepted), so {{RANDOM|Hey|Hi}} carries
// over untouched. That is the bulk of Supply Wisdom's copy and it needs nothing.
//
// What does need work:
//   · variables are camelCase in Instantly, snake_case in PlusVibe
//   · Instantly's data is internally inconsistent — {{firstName}} AND
//     {{firstname}}, {{sendingAccountName}} AND {{sendingaccountname}} both
//     appear. Matching is case-insensitive for exactly that reason.
//   · {#"now" | date: "%A"#} is Instantly's date syntax; %A (weekday name) maps
//     to PlusVibe's {{pipl_day_of_week}}. Other formats are flagged, not guessed.
//   · v_disabled: true on a variant → PlusVibe disable_variations
//
// Outputs (data/instantly-export/<slug>/):
//   campaigns.json              raw Instantly payloads (email_list stripped)
//   plusvibe.translated.json    ready for pv-replay-sequences.js --export
//   translation-report.md
//
// Usage:
//   node mcp/scripts/instantly-export-sequences.js --client "Supply Wisdom"
//   node mcp/scripts/instantly-export-sequences.js --client "Supply Wisdom" --status 1
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getClient, INSTANTLY_KEYS } from "../lib/core.js";

function arg(f) { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; }
const CLIENT_NAME = arg("--client") ?? "Supply Wisdom";
const STATUS      = arg("--status") !== undefined ? Number(arg("--status")) : undefined;
const SENDER_VAR  = arg("--sender-var") ?? "{{sender_first_name}}";
const OUT_ROOT    = join(process.cwd(), "data", "instantly-export");

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";

// status: 0 Draft, 1 Active, 2 Paused, 3 Completed, 4 Running Subsequences,
// -1 Accounts Unhealthy, -2 Bounce Protect, -99 Suspended
const STATUS_NAME = {
  0: "draft", 1: "active", 2: "paused", 3: "completed", 4: "subsequences",
  "-1": "accounts_unhealthy", "-2": "bounce_protect", "-99": "suspended",
};

// Instantly variable → PlusVibe variable. Keys are lowercased for
// case-insensitive lookup; Instantly's own data mixes casing.
const VAR_MAP = {
  firstname:          "{{first_name}}",
  lastname:           "{{last_name}}",
  companyname:        "{{company_name}}",
  website:            "{{company_website}}",
  phone:              "{{phone_number}}",
  industry:           "{{industry}}",
  title:              "{{job_title}}",
  jobtitle:           "{{job_title}}",
  city:               "{{city}}",
  // Sender-side. Instantly writes both casings of this one.
  sendingaccountname: SENDER_VAR,
  sendingaccountfirstname: SENDER_VAR,
};

const PV_STANDARD = new Set([
  "first_name", "last_name", "company_name", "company_website", "city",
  "phone_number", "job_title", "company_size", "job_responsibility", "industry",
  "sender_first_name", "sender_last_name", "signature",
]);

const RE_VAR   = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;          // {{firstName}} — no pipe, so not spintax
const RE_SPIN  = /\{\{\s*(random|fallback)\s*\|/gi;            // already-valid spintax keyword
const RE_DATE  = /\{#\s*"([^"]*)"\s*\|\s*date:\s*"([^"]*)"\s*#\}/g;  // {#"now" | date: "%A"#}

const customVars = new Map();
const unmappedVars = new Map();
const unmappedDates = [];
const backfilled = [];
const missingSubject = [];

function translate(html, ctx) {
  if (!html) return html;
  let out = html;

  // 1. Instantly date syntax. %A is the weekday name, which PlusVibe exposes as
  //    {{pipl_day_of_week}}. Anything else is left alone and reported — a wrong
  //    date in a cold email is worse than an obvious untranslated token.
  out = out.replace(RE_DATE, (m, when, fmt) => {
    if (/^now$/i.test(when) && fmt.trim() === "%A") return "{{pipl_day_of_week}}";
    unmappedDates.push({ ...ctx, raw: m });
    return m;
  });

  // 2. Variables. Skip anything that is a spintax keyword — RE_VAR can't match
  //    those anyway (they contain a pipe), but be explicit about the intent.
  out = out.replace(RE_VAR, (m, name) => {
    const key = name.toLowerCase();
    if (key === "random" || key === "fallback") return m;
    // pipl_* are PlusVibe's own built-ins (day/time/date helpers). The date pass
    // above emits {{pipl_day_of_week}}, and this pass would otherwise pick its
    // own output back up and report it as a custom variable the lead must carry.
    if (key.startsWith("pipl_")) return m;

    const mapped = VAR_MAP[key];
    if (mapped) {
      for (const v of mapped.match(/\{\{([a-z0-9_]+)\}\}/g) ?? []) {
        const bare = v.slice(2, -2);
        if (!PV_STANDARD.has(bare)) customVars.set(bare, (customVars.get(bare) ?? 0) + 1);
      }
      return mapped;
    }

    // Unmapped → snake_case it and treat as a custom variable. Instantly
    // declares these per-campaign in custom_variables, so they're real fields,
    // just ones the lead has to carry on the PlusVibe side too.
    const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    unmappedVars.set(name, (unmappedVars.get(name) ?? 0) + 1);
    customVars.set(snake, (customVars.get(snake) ?? 0) + 1);
    return `{{${snake}}}`;
  });

  return out;
}

// ── Fetch ────────────────────────────────────────────────────────────────────
const client = getClient(CLIENT_NAME);
if (client.sequencer !== "instantly") {
  console.error(
    `${client.name} has sequencer "${client.sequencer}", not "instantly".\n` +
    `For EmailBison clients use: node mcp/scripts/eb-export-sequences.js --client "${client.name}"`
  );
  process.exit(2);
}
const key = INSTANTLY_KEYS[client.instantly_ws];
if (!key) {
  console.error(`No Instantly key for workspace "${client.instantly_ws}" (client ${client.name}). Check .env and clients.json.`);
  process.exit(2);
}

console.log(`Client: ${client.name}  (instantly_ws ${client.instantly_ws})`);

const raw = [];
let cursor;
for (let page = 0; page < 100; page++) {
  const url = new URL(`${INSTANTLY_BASE}/campaigns`);
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("starting_after", cursor);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`Instantly GET /campaigns → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(3);
  }
  const data = await res.json();
  const items = data.items ?? [];
  raw.push(...items);
  cursor = data.next_starting_after;
  if (!cursor || !items.length) break;
}

// email_list runs to hundreds of addresses per campaign and is irrelevant to
// copy migration — drop it so the artifact stays readable.
for (const c of raw) delete c.email_list;

const targets = raw.filter(c => STATUS === undefined || c.status === STATUS);
console.log(`Campaigns: ${raw.length} fetched, ${targets.length} matching` +
            `${STATUS !== undefined ? ` status=${STATUS} (${STATUS_NAME[STATUS] ?? "?"})` : ""}`);
if (!targets.length) { console.error("Nothing to export."); process.exit(1); }

// ── Translate to the shared intermediate format ──────────────────────────────
const LETTERS = "ABCDEFGH";
const out = [];
let stepTotal = 0, variantTotal = 0, disabledTotal = 0, spintaxTotal = 0;

for (const c of targets) {
  // Instantly documents that only sequences[0] is used.
  const steps = c.sequences?.[0]?.steps ?? [];
  if (!steps.length) {
    console.log(`  ${String(c.id).slice(0, 8)}  0 steps — skipped   ${c.name?.slice(0, 55)}`);
    continue;
  }

  const disable_variations = [];
  const sequences = steps.map((s, i) => {
    const stepNo = i + 1;
    const variants = s.variants ?? [];
    return {
      step: stepNo,
      // Instantly carries delay_unit; everything observed is "days", which is
      // also PlusVibe's wait_time unit. Anything else would need converting.
      wait_time: (s.delay_unit && s.delay_unit !== "days") ? 0 : (s.delay ?? 0),
      variations: variants.map((v, j) => {
        const letter = LETTERS[j] ?? String(j);
        if (v.v_disabled) disable_variations.push({ step: stepNo, variation: letter, is_active: "no" });
        const ctx = { campaign: c.id, name: c.name, step: stepNo, variation: letter };
        return {
          variation: letter,
          subject: translate(v.subject ?? "", ctx),
          name: "",
          body: translate(v.body ?? "", ctx),
          _instantly_disabled: !!v.v_disabled || undefined,
          _instantly_delay_unit: s.delay_unit,
        };
      }),
    };
  });

  // PlusVibe requires a subject on step 1 ("Subject is required and cannot be
  // empty for step 1, variation D"). Instantly permits blank step-1 subjects.
  // Empty subjects on LATER steps are deliberate — that's how both platforms
  // signal "continue the thread" — so only step 1 is backfilled, from the first
  // sibling variant that has one.
  const s1 = sequences[0];
  if (s1) {
    const donor = s1.variations.find(v => (v.subject ?? "").trim())?.subject;
    for (const v of s1.variations) {
      if (!(v.subject ?? "").trim()) {
        if (donor) {
          v.subject = donor;
          v._subject_backfilled = true;
          backfilled.push({ campaign: c.id, name: c.name, variation: v.variation, used: donor });
        } else {
          missingSubject.push({ campaign: c.id, name: c.name, variation: v.variation });
        }
      }
    }
  }

  const varCount = sequences.reduce((n, s) => n + s.variations.length, 0);
  const blob = sequences.flatMap(s => s.variations.map(v => `${v.subject} ${v.body}`)).join(" ");
  const spin = (blob.match(RE_SPIN) ?? []).length;

  stepTotal += steps.length;
  variantTotal += varCount;
  disabledTotal += disable_variations.length;
  spintaxTotal += spin;

  out.push({
    source_campaign_id: c.id,          // Instantly uses a uuid, not an int
    source_platform: "instantly",
    camp_name: c.name,
    status: STATUS_NAME[c.status] ?? String(c.status),
    first_wait_time: null,
    sequences,
    disable_variations,
    settings: {
      // Carried from the Instantly campaign object.
      send_as_txt:             c.text_only ? "yes" : "no",
      is_emailopened_tracking: c.open_tracking ? "yes" : "no",
      stop_on_lead_replied:    c.stop_on_reply ? "yes" : "no",
      is_acc_based_sending:    c.stop_for_company ? "yes" : "no",
      is_esp_match:            c.match_lead_esp ? "yes" : "no",
      is_unsubscribed_link:    c.insert_unsubscribe_header ? "yes" : "no",
      send_risky_email:        c.allow_risky_contacts ? "yes" : "no",
      var_sel_type:            "R_ROBIN",
    },
    // Shape the replay's stale-export guard expects.
    compat: {
      spintax_double: spin,
      spintax_single: 0,
      merge_tags: [],
      instantly_custom_variables: Object.keys(c.custom_variables ?? {}),
    },
    _instantly: {
      daily_limit: c.daily_limit,
      email_gap: c.email_gap,
      schedule: c.campaign_schedule,
      first_email_text_only: c.first_email_text_only,
    },
  });

  console.log(`  ${String(c.id).slice(0, 8)}  ${sequences.length} steps / ${varCount} variations` +
              (disable_variations.length ? ` / ${disable_variations.length} disabled` : "") +
              `   ${(c.name ?? "").slice(0, 50)}`);
}

// ── Write ────────────────────────────────────────────────────────────────────
const slug = client.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const dir = join(OUT_ROOT, slug);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "campaigns.json"), JSON.stringify(raw, null, 2));
writeFileSync(join(dir, "plusvibe.translated.json"), JSON.stringify(out, null, 2));

// Campaign-declared custom variables are the authoritative list of what Supply
// Wisdom's leads carry in Instantly — union it with what the copy actually uses.
const declared = new Set(targets.flatMap(c => Object.keys(c.custom_variables ?? {})));

const md = [];
md.push(`# ${client.name} — Instantly → PlusVibe copy\n`);
md.push(`- campaigns: **${out.length}**`);
md.push(`- steps: **${stepTotal}**, variations: **${variantTotal}**, disabled variants: **${disabledTotal}**`);
md.push(`- spintax sections carried across unchanged: **${spintaxTotal}**`);
md.push(`  (Instantly writes \`{{RANDOM|…}}\`; PlusVibe accepts it — its keyword is case-insensitive)`);
md.push(`- \`{{sendingAccountName}}\` mapped to \`${SENDER_VAR}\`\n`);

if (customVars.size) {
  md.push(`## Custom variables your leads MUST carry\n`);
  md.push(`Not PlusVibe built-ins. Each resolves only if the lead supplies it via \`custom_variables\`` +
          ` on \`POST /lead/add\` or a mapped CSV column. Missing → renders empty, mid-sentence, silently.\n`);
  for (const [v, n] of [...customVars].sort((a, b) => b[1] - a[1])) md.push(`- \`{{${v}}}\` — ${n}×`);
  md.push("");
}
if (declared.size) {
  md.push(`## Declared in Instantly\n`);
  md.push(`These campaigns declare \`custom_variables\`: ${[...declared].map(v => `\`${v}\``).join(", ")}`);
  md.push(`\nNote any near-duplicates — Instantly tolerates typo'd variable names that silently never resolve.\n`);
}
if (unmappedVars.size) {
  md.push(`## Variables snake_cased by guess\n`);
  for (const [v, n] of unmappedVars) md.push(`- \`{{${v}}}\` → \`{{${v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}}}\` (${n}×)`);
  md.push("");
}
if (backfilled.length) {
  md.push(`## Step-1 subjects backfilled (${backfilled.length})\n`);
  md.push(`PlusVibe rejects an empty subject on step 1; Instantly allowed it. Each of these took` +
          ` the subject from a sibling variant on the same step.\n`);
  for (const b of backfilled) md.push(`- \`${b.campaign}\` variation ${b.variation} → \`${b.used}\`  (${b.name})`);
  md.push("");
}
if (missingSubject.length) {
  md.push(`## ⚠ Step-1 variations with NO subject available (${missingSubject.length})\n`);
  md.push(`Every variation on step 1 is blank, so there was nothing to copy. PlusVibe will reject these` +
          ` — set a subject in Instantly, or drop the variation.\n`);
  for (const m of missingSubject) md.push(`- \`${m.campaign}\` variation ${m.variation}  (${m.name})`);
  md.push("");
}
if (unmappedDates.length) {
  md.push(`## ⚠ Untranslated date expressions (${unmappedDates.length})\n`);
  md.push(`Only \`{#"now" | date: "%A"#}\` → \`{{pipl_day_of_week}}\` is mapped. These were left as-is` +
          ` and will render literally — see PlusVibe's Day Variables Guide for \`{{pipl_date …}}\`.\n`);
  for (const d of unmappedDates.slice(0, 20)) md.push(`- campaign \`${d.campaign}\` step ${d.step}${d.variation}: \`${d.raw}\``);
  md.push("");
}
writeFileSync(join(dir, "translation-report.md"), md.join("\n") + "\n");

console.log(`\nWrote ${dir}/{campaigns.json, plusvibe.translated.json, translation-report.md}`);
console.log(`${stepTotal} steps → ${variantTotal} variations, ${disabledTotal} disabled, ${spintaxTotal} spintax sections carried as-is`);
if (customVars.size) console.log(`Custom variables leads must carry: ${[...customVars].map(([v, n]) => `${v}(${n})`).join(" ")}`);
if (backfilled.length) console.log(`Backfilled ${backfilled.length} empty step-1 subject(s) from sibling variants`);
if (missingSubject.length) console.error(`⚠ ${missingSubject.length} step-1 variation(s) have no subject anywhere — PlusVibe will reject them`);
if (unmappedDates.length) console.log(`⚠ ${unmappedDates.length} untranslated date expression(s) — see the report`);
console.log(`\nNext: node mcp/scripts/pv-replay-sequences.js --workspace-id <PV_WS> --export ${join(dir, "plusvibe.translated.json")} --all --dry-run`);
