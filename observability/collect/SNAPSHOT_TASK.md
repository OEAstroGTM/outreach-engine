# Daily snapshot collector — contract

**The executable prompt is NOT in this file.** It lives in exactly one place:

```
~/Documents/Claude/Scheduled/pipeline-snapshot/SKILL.md
```

Read it with `mcp__scheduled-tasks__list_scheduled_tasks` (returns the path) or edit
it with `update_scheduled_task`. This document records *why* the collector behaves as
it does — the parts worth version-controlling — and deliberately does not restate the
steps. An earlier version of this file did copy them, and the two drifted within a
day: the scheduled copy still pointed at `history.json` after the repo had moved to
`config.json` + `data/series.json`, and a run aborted because of it.

Schedule: weekdays 07:33 local, cron `30 7 * * 1-5`, with a few minutes of dispatch
jitter.

## What it may write

Exactly one file: `observability/data/series.json`. Nothing else, ever.

Configuration has other owners — `../clients.json` for client identity and churn
status, `config.json` for taxonomy and the platform/tag maps. The collector reports
config problems in text and lets a human edit the file that owns them. `build.mjs`
refuses to build if any value ends up with two homes, so a collector that "helpfully"
wrote config would break the next render rather than corrupt the data quietly.

## Why it mounts the repo itself

The `oe` repo is not mounted automatically in a scheduled run. The collector must
request `/Users/felipesoza/dev/oe` before touching anything, and abort if it cannot
get it. Collecting into a temporary directory would silently discard the snapshot —
the run would look successful and the time series would simply not grow.

## Why the trend is gated

The report may only quote a daily or weekly rate when there are **at least 5
snapshots carrying a `totals` object, spanning at least 5 distinct calendar dates.**

This exists because the first readings were two totals 21 hours apart, among twelve
snapshots that were otherwise config corrections. A "daily average" from that pair
would have described when the sampler happened to run, not the business. Config-only
snapshots must not be counted as readings — that was the specific bug.

Below the threshold the collector says "sampling too sparse for a rate — N readings
across M dates" and stops. Saying nothing beats publishing an artifact.

## Why it is cheap

One `get_prospects` call per active client with `limit: 1`, read `metadata.total`,
discard the record. Plus one `get_label_stats`. Roughly 23 calls, under a minute.
`metadata.total` is only valid on page 1 — it returns `-1` afterwards — which is why
the collector never paginates.

Per-client funnels, domain attribution and reply queues need a full page-through of
each workspace. That is the weekly rotation, not this job. See `../README.md` for the
cost analysis and the single API fix that would collapse it.

## Self-upgrading

Each run probes whether `masterinbox_get_label_stats` has gained workspace scoping —
it currently ignores its `label_id` and always returns workspace 1013. The moment
that changes, the collector starts recording per-client funnels for every client and
says so in its report. No code change needed on our side.
