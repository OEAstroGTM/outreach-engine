# Clinintell — Identity
> Last updated: 2026-05-27

## Sender Personas

| Name | Email | Domain |
|------|-------|--------|
| Michael James | michaeljames.k@withclinintell.info | withclinintell.info |
| Olivia Lewis | olivialewis.c@withclinintell.info | withclinintell.info |
| William Green | greenwilliam.t@withclinintell.info | withclinintell.info |
| Isabella Garcia | isabellagarcia.w@useclinintell.info | useclinintell.info |
| Sofia Scott | sofiascott.q@useclinintell.info | useclinintell.info |
| Mia Smith | miasmith.o@getclinintell.info | getclinintell.info |
| Anthony Rivera | anthonyrivera.u@getclinintell.info | getclinintell.info |
| Sofia Scott | sofiascott.q@getclinintell.info | getclinintell.info |
| Alexander Anderson | alexanderanderson.a@getclinintell.info | getclinintell.info |
| Alexander James | jamesalexander.q@getclinintell.info | getclinintell.info |
| Henry Gray | henrygray.e@getclinintell.info | getclinintell.info |
| Steven Carter | stevencarter.y@getclinintell.info | getclinintell.info |
| Victoria Wright | wrightvictoria.p@clinintellpro.info | clinintellpro.info |
| Avery Henderson | averyhenderson.v@clinintellpro.info | clinintellpro.info |
| Eleanor Peterson | eleanorpeterson.x@clinintellpro.info | clinintellpro.info |

## Domains

| Domain | Mailboxes |
|--------|-----------|
| getclinintell.info | 7 |
| withclinintell.info | 3 |
| clinintellpro.info | 3 |
| useclinintell.info | 2 |

## Signature Block

```
{SENDER_FULL_NAME}
{{Head of Clinical Analytics|Clinical Analytics Advisor|Severity Reporting Lead|CMI Analytics Advisor}}
{{ClinIntell|ClinIntell Analytics|ClinIntell, Inc.}}
```

## Bison Setup

- **Instance:** send (send.outreachenginedashboard.co)
- **Workspace:** Clinintell — team_id: 48
- **Campaign:** SHell 1 — ID: 605
- **Sequence:** Clinintell Outreach Sequence — ID: 597
- **Mailboxes:** 15 total · Connected · Outlook OAuth · Warmup ON · Daily limit: 5

## Sequence Structure

| Step | Type | Subject | Wait |
|------|------|---------|------|
| 1A | Initial | {FIRST_NAME}, something in {COMPANY}'s data | Day 1 |
| 1B | Variant | {FIRST_NAME}, a pattern across {STATE} hospitals | Day 1 |
| 1C | Variant | {FIRST_NAME}, why CDI doesn't catch this | Day 1 |
| 2 | Thread reply | Re: (Billy Beane nudge + 75% state stat) | Day 3 |
| 3 | Thread reply | Re: (top performer authority confirmation) | Day 3 |

## Custom Variables Required

| Variable | Description |
|----------|-------------|
| {DOLLAROP} | Calculated dollar opportunity per facility |
| {STATE} | Prospect's state |
| {TOPPERFORMER} | Top performing hospital in that state |
