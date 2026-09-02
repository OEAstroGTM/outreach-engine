#!/usr/bin/env node
// ── pv-translate-copy.js ─────────────────────────────────────────────────────
// Rewrite EmailBison copy into PlusVibe syntax. Run between the export and the
// replay; the replay then reads the translated file via --export.
//
// Confirmed from PlusVibe's docs (help.plusvibe.ai, 6 Aug 2026):
//
//   SPINTAX   {{random|option1|option2|option3}}     ← keyword REQUIRED
//             {{fallback|{{variable}}|default}}
//             empty option via ||   ·   keyword is case-insensitive
//             whitespace inside options is PRESERVED, never trimmed
//             only ONE variable per spintax section, more causes errors
//
//   There is NO documented length limit. The Spintax Guide lists exactly three
//   limitations — single variable, whitespace sensitivity, empty-string via || —
//   and no character cap. So long options (OE's step-2 openers run to 1,438
//   chars) are fine as-is. --max-spintax stays available in case a real limit
//   turns up empirically, but defaults to off.
//
//   VARIABLES {{first_name}} {{company_name}} {{city}} {{phone_number}}
//             double brace, lowercase snake_case
//
// EmailBison uses NEITHER form:
//   {option1|option2}      single brace, no keyword   → PlusVibe won't expand
//   {{option1|option2}}    double brace, no keyword   → first token isn't
//                          `random`/`fallback`, so PlusVibe won't expand it
//   {FIRST_NAME}           single brace, UPPER_CASE   → not a PlusVibe variable
//
// So a straight copy-paste of OE's sequences would have sent 141 raw spintax
// blocks and 685 literal merge tags to prospects. Hence this step.
//
// Usage:
//   node mcp/scripts/pv-translate-copy.js
//   node mcp/scripts/pv-translate-copy.js --sender-var "{{signature}}"
//   node mcp/scripts/pv-translate-copy.js --max-spintax 125 --allow-oversize
import { readFileSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";

function arg(f) { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : undefined; }
const has = f => process.argv.includes(f);

const IN  = arg("--in") ?? join(process.cwd(), "data", "eb-export", "outreach-engine", "plusvibe.json");
const OUT = arg("--out") ?? join(dirname(IN), basename(IN).replace(/\.json$/, ".translated.json"));
const REPORT = join(dirname(OUT), "translation-report.md");
const MAX_SPINTAX = arg("--max-spintax") !== undefined ? Number(arg("--max-spintax")) : Infinity;
const ALLOW_OVERSIZE = has("--allow-oversize");

// EB {SENDER_FULL_NAME} resolves to the sending mailbox's own name (e.g.
// "Margaret Williams"). PlusVibe's published docs cover only lead-level
// variables and never mention sender_*, but {{sender_first_name}} exists in the
// product — confirmed in the UI variable picker, 6 Aug 2026. Defaulting to it
// because a first-name sign-off is the cold-email norm anyway.
//
// If the picker also offers a surname, match EB exactly with:
//   --sender-var "{{sender_first_name}} {{sender_last_name}}"
// Safe to use two variables here: {SENDER_FULL_NAME} never appears inside a
// spintax section in OE's copy, so PlusVibe's one-variable-per-section rule
// isn't in play. 214 occurrences ride on this choice.
const SENDER_VAR = arg("--sender-var") ?? "{{sender_first_name}}";

const TAG_MAP = {
  FIRST_NAME:       "{{first_name}}",
  LAST_NAME:        "{{last_name}}",
  COMPANY:          "{{company_name}}",
  COMPANY_NAME:     "{{company_name}}",
  INDUSTRY:         "{{industry}}",        // documented standard variable
  CITY:             "{{city}}",
  PHONE:            "{{phone_number}}",
  PHONE_NUMBER:     "{{phone_number}}",
  TITLE:            "{{job_title}}",       // documented as job_title, not title
  JOB_TITLE:        "{{job_title}}",
  COMPANY_SIZE:     "{{company_size}}",
  JOB_RESPONSIBILITY: "{{job_responsibility}}",
  WEBSITE:          "{{company_website}}", // unconfirmed — verify if it appears
  STATE:            "{{state}}",           // CUSTOM var — confirmed in the OR Trax workspace
  SENDER_FULL_NAME: SENDER_VAR,
};

// PlusVibe's documented built-ins. Anything a tag maps to that ISN'T here is a
// CUSTOM variable: it only resolves if the lead carries it, which for the API
// means custom_variables on POST /lead/add, and for CSV means a mapped column.
// Miss it and the token renders empty — silently, mid-sentence.
const PV_STANDARD = new Set([
  "first_name", "last_name", "company_name", "company_website", "city",
  "phone_number", "job_title", "company_size", "job_responsibility", "industry",
  "sender_first_name", "sender_last_name", "signature",
]);

const RE_DOUBLE = /\{\{([^{}]*\|[^{}]*)\}\}/g;                    // {{a|b}}
const RE_SINGLE = /(?<!\{)\{([^{}|]*\|[^{}]*)\}(?!\})/g;          // {a|b}
const RE_TAG    = /\{([A-Z][A-Z0-9_]*)\}/g;                       // {FIRST_NAME}
const KEYWORDS  = /^(random|fallback)\s*\|/i;

const unknownTags = new Map();
const customVars = new Map();   // custom variable name → occurrences
const oversize = [];

/** EB copy → PlusVibe copy. Order matters: spintax before merge tags, because
 *  merge-tag braces contain no pipes and so can't be confused for spintax. */
function translate(html, ctx) {
  if (!html) return html;
  let out = html;

  // 1. double-brace spintax → add the required `random|` keyword, unless the
  //    section already carries a keyword (idempotent on re-runs).
  out = out.replace(RE_DOUBLE, (m, inner) =>
    KEYWORDS.test(inner) ? m : `{{random|${inner}}}`);

  // 2. single-brace spintax → double brace + keyword.
  out = out.replace(RE_SINGLE, (m, inner) => `{{random|${inner}}}`);

  // 3. merge tags.
  out = out.replace(RE_TAG, (m, tag) => {
    const mapped = TAG_MAP[tag] ?? null;
    if (!mapped) unknownTags.set(tag, (unknownTags.get(tag) ?? 0) + 1);
    // Unmapped tags fall back to lowercase snake as a custom variable.
    const result = mapped ?? `{{${tag.toLowerCase()}}}`;
    for (const v of result.match(/\{\{([a-z0-9_]+)\}\}/g) ?? []) {
      const bare = v.slice(2, -2);
      if (!PV_STANDARD.has(bare)) customVars.set(bare, (customVars.get(bare) ?? 0) + 1);
    }
    return result;
  });

  // 4. validate the sections we just produced.
  for (const m of out.matchAll(/\{\{(?:random|fallback)\|[^{}]*\}\}/gi)) {
    const sec = m[0];
    const vars = sec.match(/\{\{(?!random\||fallback\|)[a-z0-9_]+\}\}/gi) ?? [];
    if (sec.length > MAX_SPINTAX || vars.length > 1) {
      oversize.push({
        ...ctx,
        length: sec.length,
        variables: vars.length,
        reason: [
          sec.length > MAX_SPINTAX ? `${sec.length} chars > ${MAX_SPINTAX}` : null,
          vars.length > 1 ? `${vars.length} variables in one section` : null,
        ].filter(Boolean).join("; "),
        excerpt: sec.replace(/\s+/g, " ").slice(0, 140),
      });
    }
  }

  return out;
}

const all = JSON.parse(readFileSync(IN, "utf8"));
const stale = all.filter(c => !c.compat || !Array.isArray(c.disable_variations));
if (stale.length) {
  console.error(
    `✖ ${IN} is a pre-fix export (${stale.length} campaign(s) missing compat/disable_variations).\n` +
    `  Regenerate: node mcp/scripts/eb-export-sequences.js --client "Outreach Engine"`
  );
  process.exit(3);
}

// Count and validate ONLY the fields we translate. The variations also carry
// _eb_subject / _eb_step_id provenance keys that deliberately preserve the
// original EmailBison text — scanning the whole document counts those as
// untranslated leftovers and reports a false failure.
const scanText = doc => JSON.stringify(
  doc.flatMap(c => c.sequences.flatMap(s => s.variations.map(v => [v.subject, v.body])))
);

let tagCount = 0, spinCount = 0;
const before = scanText(all);

for (const c of all) {
  for (const s of c.sequences) {
    for (const v of s.variations) {
      const ctx = { campaign: c.source_campaign_id, name: c.camp_name, step: s.step, variation: v.variation };
      v.subject = translate(v.subject, ctx);
      v.body    = translate(v.body, ctx);
    }
  }
}
tagCount  = (before.match(RE_TAG) ?? []).length;
spinCount = (before.match(RE_DOUBLE) ?? []).length + (before.match(RE_SINGLE) ?? []).length;

// Nothing should still be in EmailBison syntax — subjects and bodies only.
const after = scanText(all);
const leftoverTags = [...new Set((after.match(RE_TAG) ?? []))];
const leftoverSingle = (after.match(RE_SINGLE) ?? []).length;

writeFileSync(OUT, JSON.stringify(all, null, 2));

// ── Report ───────────────────────────────────────────────────────────────────
const md = [];
md.push(`# EmailBison → PlusVibe copy translation\n`);
md.push(`Source: \`${IN}\`  →  \`${OUT}\`\n`);
md.push(`- spintax sections rewritten to \`{{random|…}}\`: **${spinCount}**`);
md.push(`- merge tags rewritten: **${tagCount}**`);
md.push(`- \`{SENDER_FULL_NAME}\` mapped to \`${SENDER_VAR}\``);
md.push(`- sections violating PlusVibe limits: **${oversize.length}**` +
        (MAX_SPINTAX === Infinity ? `  (no length cap — PlusVibe documents none)` : ``) + `\n`);

if (customVars.size) {
  md.push(`## Custom variables your leads MUST carry\n`);
  md.push(`These are not PlusVibe built-ins. Each only resolves if the lead supplies it —` +
          ` \`custom_variables\` on \`POST /lead/add\`, or a mapped column on CSV import.` +
          ` If it's missing the token renders **empty**, mid-sentence, with no error.\n`);
  for (const [v, n] of [...customVars].sort((a, b) => b[1] - a[1])) {
    md.push(`- \`{{${v}}}\`  — ${n} occurrence(s)`);
  }
  md.push("");
}

if (unknownTags.size) {
  md.push(`## Unmapped merge tags\n`);
  md.push(`Guessed as lowercase custom variables. Each must be supplied on the lead via \`custom_variables\`, or it renders empty.\n`);
  for (const [t, n] of unknownTags) md.push(`- \`{${t}}\` → \`{{${t.toLowerCase()}}}\`  (${n}×)`);
  md.push("");
}

if (oversize.length) {
  md.push(`## Sections PlusVibe will reject\n`);
  md.push(`PlusVibe documents **one variable per spintax section** — more causes errors.` +
          (MAX_SPINTAX === Infinity ? `` : `  Length cap applied: ${MAX_SPINTAX} chars.`) + `\n`);
  md.push(`| Campaign | Step | Var | Problem | Excerpt |`);
  md.push(`|---|---|---|---|---|`);
  for (const o of oversize.slice(0, 60)) {
    md.push(`| ${o.campaign} | ${o.step} | ${o.variation} | ${o.reason} | ${o.excerpt.replace(/\|/g, "\\|").slice(0, 90)}… |`);
  }
  if (oversize.length > 60) md.push(`\n_…and ${oversize.length - 60} more._`);
  md.push(`
### Fix

Split the section so each spintax block references at most one variable. E.g.
\`{{random|Hi {{first_name}} {{last_name}}|Hello}}\` becomes
\`{{random|Hi {{first_name}}|Hello}} {{last_name}}\`, or use
\`{{fallback|{{first_name}}|there}}\` for the missing-value case.`);
  md.push("");
}

if (leftoverTags.length || leftoverSingle) {
  md.push(`## ⚠ Still in EmailBison syntax after translation\n`);
  if (leftoverTags.length) md.push(`- merge tags: ${leftoverTags.join(", ")}`);
  if (leftoverSingle) md.push(`- single-brace spintax sections: ${leftoverSingle}`);
  md.push("");
}

writeFileSync(REPORT, md.join("\n") + "\n");

console.log(`Rewrote ${spinCount} spintax section(s) and ${tagCount} merge tag(s)`);
console.log(`{SENDER_FULL_NAME} → ${SENDER_VAR}`);
if (unknownTags.size) console.log(`Unmapped tags (guessed): ${[...unknownTags.keys()].map(t => `{${t}}`).join(" ")}`);
if (customVars.size) {
  console.log(`Custom variables leads must carry: ${[...customVars].map(([v, n]) => `${v}(${n})`).join(" ")}`);
}
console.log(`\nWrote ${OUT}`);
console.log(`Wrote ${REPORT}`);

if (leftoverTags.length || leftoverSingle) {
  console.error(`\n✖ EmailBison syntax survived translation — see the report. Not safe to replay.`);
  process.exit(4);
}

if (oversize.length) {
  console.error(`\n✖ ${oversize.length} spintax section(s) exceed PlusVibe's documented limits.`);
  console.error(`  Read ${REPORT} — the fix is usually to move options into step variations.`);
  if (!ALLOW_OVERSIZE) {
    console.error(`  Re-run with --allow-oversize to write them anyway (they may silently fail to expand).`);
    process.exit(5);
  }
  console.error(`  --allow-oversize set; written regardless.`);
}

console.log(`\nNext: node mcp/scripts/pv-replay-sequences.js --workspace-id <ID> --export ${OUT} --only 1166`);
