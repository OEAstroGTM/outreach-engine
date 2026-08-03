# Ujet — Voice & Messaging
> Last updated: 2026-07-30 · Source: UJET-Spiral-Campaign-Messaging-Paths

## Tone Profile
Plain-text, direct, one idea per touch. Conversational question openers ("Quick question."). No HTML formatting. Short. The rep is a peer asking about the prospect's operation, not a vendor describing features — feature language is stripped entirely on Path C.

## Script Skeleton (do not restructure)
Five steps, conditional greeting, company fallback, spintax rotations, and closing line are the outreach team's proven scripts. **Persona tuning changes only the middle "noticing" and value lines.**

| Step | Day | Purpose |
|---|---|---|
| 1A | 1 | Root-cause angle |
| 1B | 4 | Trend-speed angle |
| 1C | 8 | Insight-to-action angle |
| 2 | 12 | Bump + routing ask |
| 3 | 16 | Breakup + calendar link |

## Template Syntax
- Conditionals: `{% if %}…{% endif %}`
- Merge tokens: `{FIRST_NAME}` `{COMPANY}` `{SENDER_FULL_NAME}` `{CALENDAR_LINK}`
- Spintax: `{option A|option B|option C}`

**⚠️ QA rule:** source scripts arrived with curly quotes (`'` `'`) inside conditionals. These **must** be straight quotes (`'`) in the sending platform or the conditionals fail silently.

`{CALENDAR_LINK}` must resolve to the assigned UJET AE's native HubSpot scheduling link so booked meetings land in standard reporting.

## Standard Openers
```
Hi {% if '{FIRST_NAME}' != '' %}{FIRST_NAME}{% else %}there{% endif %},
```
Company fallback:
```
{% if '{COMPANY}' != '' %}{COMPANY}{% else %}your company{% endif %}
```

## Closing CTA Spintax
- `{Worth a quick conversation?|Interested in seeing how it works?|Open to a short overview?}`
- `{Would it be worth comparing approaches?|Open to a quick walkthrough?|Interested in learning more?}`
- `{Worth a conversation?|Open to seeing a few examples?|Interested in learning more?}`

## Step 2 Bump Spintax
Pop-culture variants (Paths A, B, D):
`{Following up before this turns into another mission from Mission: Impossible.|Circling back before this disappears like a work memory in Severance.|Checking back before this gets buried in the chaos like The Bear.|Following up before this takes more turns than F1.}`

Plain variants (Path C exec audience — **open decision**, see identity.md):
`{Following up in case this got buried.|Circling back once before I close the loop.|Checking in - timing may have been off.}`

## Banned In Cold Copy
"decision-grade," "AI Issue Hub," "unknown unknowns," the 95% and 98% figures, weasel words, condescending filler. Dynamic Sales is never named.

## Subject Lines / Angles That Generated Replies
No data yet — see `positioning.md` for the proposed spintax awaiting sign-off.

## What Prospects Say When They Engage
No data yet.
