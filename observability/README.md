# Observability

Read-only instrumentation for the Outreach Engine book of business. Two halves:

- **Gauges** — what comes out. Reply volume, funnel, conversion, per client.
- **Hospital** — what goes in. Sending domain and mailbox health.

## Non-negotiable: this system does not act

It observes and reports. A human decides and acts. No tool in this module writes
to MasterInbox, EmailBison, Instantly, a registrar or Inboxing. Specifically never:
`masterinbox_tag_reply`, `masterinbox_send_message`, `masterinbox_update_prospect`,
`emailbison_pause_campaign`, `emailbison_launch_campaign`,
`emailbison_delete_disconnected_mailboxes`, or any domain/DNS call.

If something needs fixing — a mislabelled thread, a junk record, a burned domain —
report it in text. Do not fix it.

## Layout

```
observability/
  build.mjs                  merges the three sources and renders the dashboard
  config.json                TRACKED. Observability config. Nothing else.
  data/series.json           GITIGNORED. Measurements. Machine-appended daily.
  dashboard/template.html    dashboard, contains the literal __HISTORY__ placeholder
  dashboard/build/index.html generated. gitignored.
  lib/taxonomy.js            canonical label groups
  lib/infra-health.js        the hospital: domain diagnosis + triage
  collect/SNAPSHOT_TASK.md   the scheduled collector prompt
```

## Every value has exactly one home

Three sources, no overlap. `build.mjs` merges them at render time — that is the
*only* place they are combined.

| Source | Owns | In git |
|---|---|---|
| `../clients.json` | client identity: name, `mi_ws_id`, `eb_ws_id`, sequencer, **churn status** | yes |
| `config.json` | taxonomy, internal workspaces, platform map, Inboxing tag map, known join gaps | yes |
| `data/series.json` | snapshots, scan results, domain ages, fleet inventory | **no** |

Run `node observability/build.mjs` to render, then
`node observability/dashboard/verify.mjs` to check it actually works. Verify
executes the built page headlessly and asserts every screen renders — including
the two paths that only run in unusual states: an empty series (fresh clone) and
sparse sampling.

Its mock returns `null` for any element id the HTML does not define, which is the
point. An earlier mock returned an object for every id and silently hid a
`getElementById('stage')` against an element that had been deleted — a crash that
only fired when there were zero readings, i.e. on a fresh clone.

`build.mjs --check` validates without writing. The build **fails** rather than
guesses if a value appears in two places:

- a key present in both `config.json` and `series.json`
- `churned` or `client_registry` stored anywhere (both are derived from `clients.json`)
- a `config.workspaces` entry that `clients.json` already describes — including one
  spelled differently, which the merge would silently override

`config.workspaces` therefore holds only workspaces `clients.json` does not
describe. Today that is one: **Built Right (1579)**, which is missing from
`clients.json` and should be added there.

Why `series.json` is not tracked: the collector appends to it every weekday, so
committing it would mean a diff a day, guaranteed conflicts, and eventually
hundreds of commits of JSON noise. A fresh clone has no `series.json` at all —
the build handles that and the dashboard renders an explicit "no data collected
yet" state rather than a wall of zeros.

## The funnel model

Getting this wrong produces confident nonsense, which it already did once.

```
all replies -> human replies -> interest pool -> Meeting Booked (TERMINAL)
```

1. **Interest is a pool of three equivalent labels** — `Interested`,
   `Information Request`, `Meeting Request`. Treating Meeting Request alone as
   the entry point reported 97% conversion when the real figure was 31.5%.
2. **Meeting Booked is terminal.** The thread ends there. Nothing follows it.
3. **`Nth call completed` labels are setter dial attempts, not stages.** Reading
   "1st call 71 -> 2nd call 15" as a 79% funnel leak was wrong — most prospects
   are simply called once.

Headline metric: **interest pool -> Meeting Booked**. Measured at 31.5% for
OutreachEngine and 32.8% across five other clients, which suggests it is
structural rather than client-specific.

## Label IDs are per-workspace

Ujet's "Add to Blocklist" is `192287`; OutreachEngine's is `6279`. **Always key on
the label NAME.** Anything hardcoded to one workspace's IDs returns silent garbage
everywhere else.

## The hospital

Diagnosis happens at **domain** level, not mailbox. Two reasons: reputation damage
is domain-wide, and the fleet is too large to enumerate — Dream It Reel alone runs
1,205 connected mailboxes and one workspace's account list is a 1.4 MB payload.

Domain is also the only key shared by all four systems:

| System | Contributes |
|---|---|
| Inboxing | domain provisioned, client tag, mailbox slots |
| Registrar (NameSilo/Porkbun) | creation + expiry date, so age |
| EmailBison | mailbox status, `daily_limit`, so capacity |
| MasterInbox | `channel_id` decoded to a domain, so outcomes |

`channel_id` is base64 of the sending mailbox — that is the join. It is already on
every MasterInbox record, so outcome attribution needs no extra calls.

### Triage states

| State | Meaning |
|---|---|
| `healthy` | Connected, sending, producing bookings |
| `warming` | Under 30 days old or under 15 threads. No verdict yet |
| `watch` | Interest but zero bookings, or noise above 65% |
| `critical` | Real volume with no positives, or noise above 80% |
| `dead` | Every mailbox disconnected |

Thresholds are deliberately conservative. The job is to flag a patient for a human,
not to sentence one.

Also computed: **concentration risk** (what share of bookings rests on the top N
domains — a book where 3 domains carry 60% is one blacklisting from a bad quarter)
and **mortality** (bookings per domain by age bucket, which over time yields the
replacement rate and therefore true cost per meeting).

## Four sending platforms, not one

| Platform | Notes |
|---|---|
| EmailBison `send` | Most clients |
| EmailBison `personal` | Coffee & Contracts, Built Right, Union Omaha, Arnon River, Lend Home, Abra Personal |
| Instantly | Supply Wisdom, Surety Now; Simplexity and lend_home are legacy |
| **HeyReach (LinkedIn)** | Discovered 2026-08-03. Absent from `clients.json`. 125 of Clinintell's 208 records |

Abra and Intellectible appear on two platforms — never sum across platforms
without deduplicating. HeyReach records carry `channel_id: heyreach_<id>` with no
domain and no `last_reply_address`, so they **cannot** be domain-attributed or
calendar-checked. Branch on the record's `source` field or you will report clean
zeros for populations that were never testable.

## API constraints, learned the hard way

| Call | Problem |
|---|---|
| `masterinbox_get_label_stats` | Ignores `label_id`; always returns workspace 1013. Needs a workspace param. |
| `masterinbox_get_prospects` | Ignores `label_id`. **This is the top-priority fix** — it would cut a per-client scan by ~95%. |
| `masterinbox_get_prospects` | `metadata.total` is valid on page 1 only; returns `-1` after. Coverage on long scans is unverifiable. |
| `masterinbox_list_replies` | Broken — demands a `prospect_id`, so it cannot list. |
| `emailbison_list_workspaces` | Returns a PARTIAL set on both instances. Drive inventory from `clients.json`. |
| `emailbison_get_all_workspace_mailbox_counts` | Times out without a `status` filter. |
| `emailbison_list_email_accounts` | Ignores `team_id` — returns the whole instance. |
| disconnected count of exactly `100` | An API page cap. Treat as a floor, not a count. |

Cost consequence: every 100-record page exceeds the tool output limit. OutreachEngine
at 92 pages is roughly 19 MB and cannot be scanned in one context. In the pilot, 72%
of scanned bytes were unlabelled or pure noise — paid for, useless. Hence the
`label_id` filter being the single highest-value fix.

## Known data defects

These soften every number. They are measured, not fixed — read-only system.

- **Calendar mis-threading.** Calendly and Google Calendar mail sent from our own
  mailboxes is filed against the wrong prospect and counted as an inbound reply.
  Detect by testing whether `last_reply_address` sits on one of our domains.
  In OutreachEngine it faked 16 of 29 apparent misses; across five real clients it
  was only 0.19%. **OutreachEngine is an outlier — do not extrapolate its rate.**
  The domain allowlist must be explicit per client: inferring it from `channel_id`
  missed `arnonriverpartners.com` and hid a booked record.
- **Duplicate bookings.** The same thread appears under two prospect records.
  Material at 3–11 bookings per client. Dedupe before quoting any booked figure.
- **Unclassified labels.** `Interest` and `Interest Request` are near-duplicates of
  the real labels and silently dropped out of every metric until classified.
- **`clients.json` churn flags are stale.** It marks Lend Home churned (the client
  returned) and omits churn for Simplexity, AskTuring, Carengen and Nuvo Bath.
- **`Built Right` is missing from `clients.json`** despite having a key and a
  workspace. `MI_KEY_ARNON_RIVER_PARTNERS` is referenced but not set.

## Per-client MasterInbox keys

`MI_KEY_<CLIENT>` in the repo root `.env`, derived from `clients.json` via
`mcp/lib/core.js`. **These do not reach the lead-gen MCP** — that is a separate
codebase serving the `masterinbox_*` tools, and it reads only `MASTERINBOX_API_KEY`.
Adding env vars alone cannot fix per-client funnels; the tools need a
`workspace_key_env` parameter, as the `emailbison_*` tools already have.
