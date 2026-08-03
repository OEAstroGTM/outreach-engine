# Daily snapshot collector

This is the prompt run by the `pipeline-snapshot` scheduled task (weekdays, 07:33
local). Kept in the repo so the collector is reviewable and versioned alongside the
taxonomy it depends on. The live copy is at
`~/Documents/Claude/Scheduled/pipeline-snapshot/SKILL.md` — **edit both together or
they drift.**

## Contract

- **Read-only.** See the prohibited-tools list in `../README.md`. Never write to a
  source system, even when the fix is obvious.
- **Cheap.** One `get_prospects` call per client with `limit: 1` (for
  `metadata.total`) plus one `get_label_stats`. Roughly 23 calls, under a minute.
- **Appends, never rewrites.** Historical snapshots stay truthful even when a client
  churns; the dashboard filters at render time.
- **Self-upgrading.** It probes whether `get_label_stats` has gained workspace
  scoping and switches to full per-client funnels the moment it does.

## Steps

1. Load `masterinbox_list_workspaces`, `masterinbox_get_prospects`,
   `masterinbox_get_label_stats`.
2. Enumerate workspaces. Anything absent from `workspaces`, `churned` *and*
   `internal` is genuinely new — add it, but flag it for confirmation as a real
   client rather than another mailbox workspace.
3. Per active client: `get_prospects {workspace_id, limit: 1}`, read
   `metadata.total`. Ignore record content entirely.
4. `get_label_stats {label_id: "5074"}`, then call again with a label ID belonging
   to a different workspace (e.g. `192287`, Ujet's "Add to Blocklist"). If the two
   responses differ, scoping now works — collect per client and say so. If
   identical, record workspace 1013 only.
5. Append one snapshot object to `snapshots` with `ts`, `source`, `totals`,
   `labels`, `notes`. Notes carry only genuinely notable things: errors, new
   workspaces, unusually large label movements, unclassified labels. Empty array
   if nothing. Do not pad.
6. Rebuild the dashboard: substitute `__HISTORY__` in `dashboard/template.html`,
   write the result, confirm the placeholder is gone, update the artifact, verify
   no JS errors.

## Reporting

Six lines maximum: snapshot number, total replies and change, three biggest movers,
OutreachEngine interest-pool and Meeting Booked movement with current conversion,
anything that errored, and — once ten snapshots exist — one line on the trend.

Do not restate methodology. Do not re-describe defects already recorded in
`history.json`. Do not offer next steps unless something is broken.

## Exclusions

Driven by two maps in `history.json`. `list_workspaces` still returns these; ignore
them and never re-add them.

- `churned` — former clients. Their figures stay in historical snapshots.
- `internal` — infrastructure. Currently `329 INBOXING UPLOADS`.

## What this collector cannot do

Per-client funnels, because `get_label_stats` is locked to workspace 1013. Domain
attribution, calendar-contamination rates and awaiting-reply queues all require
paging a full workspace — that is the weekly rotation, not this daily job. See
`../README.md` for the cost analysis and the one API fix that would collapse it.
