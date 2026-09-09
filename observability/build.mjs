#!/usr/bin/env node
// ── build.mjs ────────────────────────────────────────────────────────────────
// Renders the dashboard by merging three sources, each with exactly one home:
//
//   ../clients.json      client identity — id, name, sequencer, workspace ids
//   config.json          observability config — taxonomy, churn, exclusions, tag map
//   data/series.json     measurements — snapshots, scans, fleet, ages
//
// Nothing is duplicated across them. If a value appears in two places that is a
// bug, not a workflow. The merge happens here at build time and nowhere else.
//
// Usage:  node observability/build.mjs [--out path] [--check]
//   --check  validate and report without writing

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENTS = resolve(HERE, "..", "clients.json");
const CONFIG = join(HERE, "config.json");
const SERIES = join(HERE, "data", "series.json");
const TEMPLATE = join(HERE, "dashboard", "template.html");

const args = process.argv.slice(2);
const check = args.includes("--check");
const outIdx = args.indexOf("--out");
const OUT = outIdx > -1 ? args[outIdx + 1] : join(HERE, "dashboard", "build", "index.html");

const readJson = p => JSON.parse(readFileSync(p, "utf8"));
const strip = o => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

// ── load ─────────────────────────────────────────────────────────────────────
for (const p of [CLIENTS, CONFIG, TEMPLATE]) {
  if (!existsSync(p)) { console.error(`missing required file: ${p}`); process.exit(1); }
}
const clients = readJson(CLIENTS);
const config = strip(readJson(CONFIG));
// series.json is gitignored — absent in a fresh clone, which is fine.
const series = existsSync(SERIES) ? strip(readJson(SERIES)) : {};
const template = readFileSync(TEMPLATE, "utf8");

// ── derive from clients.json, which owns client identity and churn status ────
const registry = {}, churned = {};
for (const c of clients) {
  if (c.mi_ws_id == null) continue;
  const ws = String(c.mi_ws_id);
  registry[ws] = {
    name: c.name, eb_ws_id: c.eb_ws_id ?? null, sequencer: c.sequencer ?? null,
    instantly_ws: c.instantly_ws ?? null, status: c.status ?? null,
  };
  if (c.status === "churned") churned[ws] = { name: c.name, churned_on: c.churned_at ?? null };
}

// ── guard against the duplication this file exists to prevent ────────────────
const overlap = Object.keys(config).filter(k => k in series);
if (overlap.length) {
  console.error(`CONFIG/SERIES OVERLAP — a key must live in exactly one file: ${overlap.join(", ")}`);
  process.exit(1);
}
for (const k of ["client_registry", "churned"]) {
  if (k in config || k in series) {
    console.error(`'${k}' must not be stored — it is derived from clients.json. Remove it.`);
    process.exit(1);
  }
}

// Client names: clients.json wins unconditionally. config.workspaces exists only
// for workspaces clients.json does not describe, so ANY overlap is redundant —
// including a differently-spelled name, which the merge would silently override.
const redundant = Object.keys(config.workspaces || {})
  .filter(ws => !ws.startsWith("_") && registry[ws]);

const merged = { ...config, ...series, client_registry: registry, churned,
                 workspaces: { ...(config.workspaces || {}),
                               ...Object.fromEntries(Object.entries(registry).map(([w, m]) => [w, m.name])) } };
const snapshots = merged.snapshots || [];
merged.snapshots = snapshots;

// ── report ───────────────────────────────────────────────────────────────────
console.log(`clients.json   ${clients.length} clients, ${Object.keys(registry).length} with a MasterInbox workspace`);
console.log(`config.json    ${Object.keys(config).length} keys`);
console.log(`series.json    ${existsSync(SERIES) ? `${snapshots.length} snapshots` : "absent — rendering empty state"}`);
console.log(`derived        ${Object.keys(churned).length} churned, ${Object.keys(registry).length} in registry`);
if (redundant.length) {
  console.log(`\n⚠ config.workspaces duplicates clients.json for ${redundant.length} workspace(s) — remove them:`);
  console.log(`   ${redundant.join(", ")}`);
}

if (check) { console.log("\n--check: no output written"); process.exit(redundant.length ? 2 : 0); }

if (!template.includes("__HISTORY__")) {
  console.error("template.html has no __HISTORY__ placeholder"); process.exit(1);
}
const html = template.replace("__HISTORY__", JSON.stringify(merged));
if (html.includes("__HISTORY__")) { console.error("substitution failed"); process.exit(1); }

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`\nwrote ${OUT} (${(html.length / 1024).toFixed(0)} KB)`);
