# Per-client scan — contract

The weekly job that pages a whole client workspace. Distinct from the daily
snapshot collector (`SNAPSHOT_TASK.md`), which only reads cheap aggregate counts.

**Not yet scheduled.** Run manually per client for now; the storage format below
is what makes it worth scheduling.

## Store per-record label sets, not tallies

This is the point of the whole job. The first pilot stored group totals —
`{interest: 31, booked: 11}` — and those cannot answer any question about
movement, because **a label is mutable state, not an event**. `Meeting Booked: 75`
says 75 records carry that label right now. It says nothing about how many ever
did, or which records they were.

So a ratio between two label counts is not a conversion rate, and a delta on one
label count is net, not gross: `+1` might be three arrivals and two departures.

Store instead, via `encodeScan()` in `../lib/cohort.js`:

```json
{
  "ts": "2026-08-11T07:40:00Z",
  "vocab": ["Interested", "Meeting Booked", "OOO Sequence"],
  "recs": { "someone@example.com": [0, 1], "other@example.com": [2] },
  "count": 2
}
```

Labels are interned against `vocab` so the same ~30 strings are not repeated
thousands of times. The key is the prospect email — stable, readable, and it
survives the record `_id` changing.

Append to `data/series.json` under:

```
record_scans.by_workspace["<ws_id>"] = [ scan, scan, ... ]
```

Keep **at least the two most recent scans** per workspace. Two scans at least 24
hours apart is what unlocks:

- `transitions(prev, next)` — gross entered/exited/held per state group, plus the
  per-record label changes
- `cohortConversion(prev, next)` — of the records in `interest` at t0, how many
  are in `success` by t1, excluding records that did not exist at t0
- `composition(scan)` — the point-in-time state mix, which is all a single scan
  can honestly give

`canComputeConversion()` gates all of it and refuses when scans are fewer than two
or less than 24 hours apart. Do not work around the gate.

## The other three outputs

The same page-through still yields, from fields already in the list payload:

- **Domain attribution** — `channel_id` is base64 of the sending mailbox; decode
  it and roll up by domain. Skip HeyReach records (`channel_id: heyreach_<id>`),
  which have no domain.
- **Calendar-artifact rate** — flag records whose `last_reply_address` sits on one
  of our own sending domains. These are Calendly/Google Calendar messages
  mis-filed against the wrong prospect and counted as inbound replies.
- **Awaiting reply** — `last_msg_from == "prospect"` plus an interest label, minus
  the calendar artifacts.

## Cost, and the one fix that changes it

Every 100-record page exceeds the tool output limit and spills to a file, so a
scan is one file round-trip per page. OutreachEngine at ~92 pages is roughly
19 MB — not feasible in a single agent context.

In the pilot, **72% of scanned bytes were unlabelled or pure noise records**, paid
for and useless. Making `get_prospects` honour its `label_id` argument would cut a
scan to about three pages per client and turn this from a weekly rotation into a
daily sweep. It is the highest-value fix on the board.

Until then: rotate. One or two small clients per night; leave the five largest
until the filter lands.

## Read-only

Same prohibition as the daily collector — see `../README.md`. This job reads
MasterInbox and writes only `data/series.json`.
