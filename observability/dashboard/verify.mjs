#!/usr/bin/env node
// ── verify.mjs ───────────────────────────────────────────────────────────────
// Executes the built dashboard's JS headlessly and asserts it renders.
//
// The mock returns null for any id NOT present in the HTML, which is the whole
// point: an earlier mock handed back an object for every id and so silently hid
// a getElementById('stage') against an element that did not exist. That path
// only ran when snapshots were empty — i.e. on a fresh clone — so it would have
// shipped broken.
//
// Usage:  node observability/dashboard/verify.mjs [path/to/index.html]

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || join(HERE, "build", "index.html");
if (!existsSync(FILE)) { console.error(`not found: ${FILE} — run build.mjs first`); process.exit(1); }

const src = readFileSync(FILE, "utf8");
const script = src.match(/<script>\n([\s\S]*?)<\/script>/g)?.pop()?.replace(/<\/?script>/g, "");
if (!script) { console.error("no inline script found"); process.exit(1); }

// Every id the HTML actually defines.
const present = new Set([...src.matchAll(/id="([A-Za-z][\w-]*)"/g)].map(m => m[1]));
// Every id the script reaches for.
const wanted = [...new Set([...script.matchAll(/getElementById\(['"]([\w-]+)['"]\)/g)].map(m => m[1]))];
const missing = wanted.filter(id => !present.has(id));
if (missing.length) {
  console.error(`getElementById targets absent from the HTML: ${missing.join(", ")}`);
  process.exit(1);
}

function run(label, { screen = "perf", client = "all", ward = "attention", history } = {}) {
  const store = { "oe-screen": screen, "oe-client": client, "oe-ward": ward };
  const html = {}, cls = {};
  const make = id => ({
    set innerHTML(v) { html[id] = v }, get innerHTML() { return html[id] || "" },
    textContent: "", value: "", style: {}, dataset: {},
    classList: {
      add(c) { (cls[id] ||= new Set()).add(c) },
      remove(c) { (cls[id] ||= new Set()).delete(c) },
      toggle(c, v) { v ? this.add(c) : this.remove(c) },
    },
    insertAdjacentHTML(_, s) { html[id] = (html[id] || "") + s },
    onclick: null, onchange: null,
  });
  const cache = new Map();
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v } };
  globalThis.document = {
    // null for anything the HTML does not define — mirrors the browser.
    getElementById: id => present.has(id) ? (cache.get(id) ?? cache.set(id, make(id)).get(id)) : null,
    querySelectorAll: () => [],
  };
  globalThis.Chart = function () { return { destroy() {} } };

  let body = script;
  if (history) body = body.replace(/^const H = [\s\S]*?;\n/m, `const H = ${JSON.stringify(history)};\n`);
  try { eval(body); } catch (e) { console.error(`✗ ${label}: ${e.message}`); return null; }
  console.log(`✓ ${label}`);
  return { html, cls };
}

// Extract the injected history by brace-matching rather than regex — the text
// that follows `const H = {...};` is not stable.
function extractH(s) {
  const start = s.indexOf("const H = ");
  if (start < 0) throw new Error("no `const H =` in script");
  const open = s.indexOf("{", start);
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(s.slice(open, i + 1));
  }
  throw new Error("unbalanced braces in injected history");
}
const H = extractH(script);
let failed = false;
const check = (label, opts, assert) => {
  const r = run(label, opts);
  if (!r) { failed = true; return; }
  const problem = assert?.(r);
  if (problem) { console.error(`  ✗ ${problem}`); failed = true; }
};

check("all clients / performance", {}, r => {
  if (!/class="bar"/.test(r.html.dropoff || "")) return "drop-off waterfall is empty";
  if (!/<tr/.test(r.html.rows || "")) return "client table is empty";
  if (!/<tr/.test(r.html.convRows || "")) return "conversion table is empty";
});
check("all clients / infrastructure", { screen: "infra" }, r => {
  if (!/<tr/.test(r.html.wardRows || "")) return "ward is empty";
  if (!/<tr/.test(r.html.fleetRows || "")) return "fleet table is empty";
});
for (const ws of Object.keys(H.observed?.clients || {})) {
  check(`client ${ws} / performance`, { client: ws });
  check(`client ${ws} / infrastructure`, { client: ws, screen: "infra" });
}
// The path that was broken: config loaded, zero readings.
check("empty series (fresh clone)", { history: { ...H, snapshots: [], observed: undefined } });
// Readings present but too few to quote a rate.
check("sparse sampling notice", {}, r => {
  const readings = (H.snapshots || []).filter(s => s.totals);
  const dates = new Set(readings.map(s => s.ts.slice(0, 10)));
  const quotable = readings.length >= 5 && dates.size >= 5;
  const shown = !(r.cls.stage?.has("hide") ?? true);
  if (quotable === shown) return `sampling banner ${shown ? "shown" : "hidden"} but quotable=${quotable}`;
});

console.log(failed ? "\nFAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
