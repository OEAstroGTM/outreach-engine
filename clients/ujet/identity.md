# Ujet — Identity

## Credentials

| Service | Env var | Notes |
|---------|---------|-------|
| MasterInbox | `MI_KEY_UJET` | workspace public key |
| EmailBison Send | `EB_SEND_KEY_UJET` | send instance, workspace-scoped token |

## MasterInbox

- **Workspace ID:** 2096
- **Workspace name:** Ujet

## Bison Setup

- **Instance:** send (send.outreachenginedashboard.co)
- **Workspace ID:** 78
- **Campaigns:** 16 built (incl. 1164 dummy/test); named by region + persona path,
  e.g. "West Aug – Ujet – CX/Support Ops Leadership" (Path B)
- **Sequence:** —
- **Mailboxes:** 905 total on `ujetoutreach.digital` · Daily limit: —

> The account-level EmailBison key cannot reach workspace 78 — it returns
> "unauthorized". Calls for Ujet must use the workspace-scoped `EB_SEND_KEY_UJET`.

## Sender Personas

| Name | Email | Domain |
|------|-------|--------|
| | | |

## Domains

| Domain | Mailboxes |
|--------|-----------|
| | |

## Signature Block

All outreach is UJET-branded — UJET email addresses, signatures, caller ID, and
UJET-affiliated LinkedIn presence. Dynamic Sales is never named to a prospect.

```
Thanks,

{SENDER_FULL_NAME}
{Title}
UJET
```

## Sequence Structure

Email drip — 5 touches over ~16 business days. Same skeleton on all four paths;
only the middle "noticing" and value lines change per persona.

| Step | Type | Angle | Wait |
|------|------|-------|------|
| 1A | Initial | Root cause | Day 1 |
| 1B | Follow-up | Trend speed | Day 4 |
| 1C | Follow-up | Insight to action | Day 8 |
| 2 | Bump | Bump + routing ask | Day 12 |
| 3 | Breakup | Breakup + calendar link | Day 16 |

Then: LinkedIn (LI-1 connect, LI-2 angle, LI-3 proof, LI-4 breakup) starting 5
business days after Step 3 with no interest signal. Phone is interest-triggered
only, same or next business day.

## Custom Variables

| Variable | Description |
|----------|-------------|
| `{FIRST_NAME}` | Falls back to "there" via conditional |
| `{COMPANY}` | Falls back to "your company" via conditional |
| `{SENDER_FULL_NAME}` | Rep's UJET identity |
| `{CALENDAR_LINK}` | Assigned UJET AE's native HubSpot scheduling link |

**⚠️ Load-time QA:** the source scripts use curly quotes inside `{% if %}`
conditionals. Convert to straight quotes before loading into EmailBison or the
conditionals fail silently.

## Open Items (from messaging doc)

- Template QA — confirm EmailBison conditional/spintax syntax matches the scripts
- Subject lines need outreach-team sign-off (+ A/B slots if rotating)
- Path C Step 2: pop-culture spintax vs. plain variants for exec titles — undecided
- UJET-branded sending infrastructure (subdomain, signatures, caller ID) — gates Day-1 launch
- Turo metrics approval for LinkedIn/phone use
- Named target account list, suppression list, offer/incentive decision
- SLA for AE first-touch after Meeting Booked (recommend same business day)
