# 4-Sequence Outbound Motion — May 2026

## Overview

Complete rebuild of the OE outbound motion. Replaced ad-hoc campaigns with a structured 4-sequence architecture targeting sales and marketing personas across net new and saved contact pools.

## Campaigns

| Campaign | EB ID | Sequence ID | Audience | Contact pool |
|---|---|---|---|---|
| Net New Sales | 594 | 585 | VP/Dir of Sales | Apollo net new |
| Net New Marketing | 595 | 586 | VP/Dir of Marketing | Apollo net new |
| Saved Sales | 596 | 587 | VP/Dir of Sales | Apollo saved lists |
| Saved Marketing | 597 | 588 | VP/Dir of Marketing | Apollo saved lists |

Instance: send.outreachenginedashboard.co (EB_SEND_KEY_OUTREACH_ENGINE)

---

## Sequence structure (all 4 campaigns)

**Step 1 — 3 variants, wait 1 day**
**Step 2 — Funny nudge with asset links, wait 3 days**
**Step 3 — Authority question with calendar link, wait 3 days**

Subject on all steps: {FIRST_NAME}

---

## Net New Sales

### Step 1 — Variant A
Pain: reps spending too much time finding people to close. Social proof: UKG and OR Trax, 10-20 meetings/month. CTA: open to seeing if the numbers make sense?

### Step 1 — Variant B
Closing problem that looks like a pipeline problem. Reps are fine, calendar is empty. Performance pricing. CTA: worth a quick look?

### Step 1 — Variant C
Multi-channel angle. Email + phone + LinkedIn. Most teams only hit one. Performance pricing. CTA: wanted to put it in front of you.

### Step 2 — Funny nudge
"Guessing this landed somewhere between your LinkedIn requests and a newsletter you definitely meant to unsubscribe from six months ago."
Links:
- [This is how much it costs to run it on your own](https://gamma.app/docs/Outreach-Engine-Case-Studies-spj0v5gzdc2srqu?mode=doc)
- [How other sales teams went from dry spell to 15 meetings a month](https://gamma.app/docs/OutreachEngineco-Your-Outsourced-Sales-Development-Partner-diwj0yk6el3w7fe?mode=doc)

### Step 3 — Authority question
"What percentage of pipeline is rep-sourced versus coming in from other channels? We see most SaaS sales teams sitting around 70-80 percent rep-sourced, and that is usually where things start to get inconsistent."
Calendar: https://calendly.com/kevinn-outreachengine/intro-to-outreach-engine

---

## Net New Marketing

### Step 1 — Variant A
Pain: pipeline too tied to ad spend. When spend drops, pipeline drops. Social proof: Braintracks and UKG, 10-20 meetings/month. CTA: open to testing this?

### Step 1 — Variant B
Marketing blamed for lead quality, sales goes back to self-sourcing. We build the outbound layer that keeps both sides fed. CTA: worth a quick look?

### Step 1 — Variant C
Inbound is working, outbound is not a channel anyone owns, pipeline number is hard to predict. Performance pricing. CTA: wanted to flag it.

### Step 2 — Funny nudge
"Pretty sure this went the same place as that one Slack message you meant to reply to and then just kept moving."
Links:
- [This is how much it costs to run it on your own](https://gamma.app/docs/Outreach-Engine-Case-Studies-spj0v5gzdc2srqu?mode=doc)
- [How others saw their TOFU activity rise like foam](https://gamma.app/docs/OutreachEngineco-Your-Outsourced-Sales-Development-Partner-diwj0yk6el3w7fe?mode=doc)

### Step 3 — Authority question
"What is the split between inbound and outbound as pipeline sources? Most B2B SaaS marketing teams are sitting around 80 percent inbound, and the ones trying to shift that ratio are usually the ones who have decided they need to own a channel that does not depend on algorithm changes or CPCs."
Calendar: https://calendly.com/kevinn-outreachengine/intro-to-outreach-engine

---

## Saved Sales

Proof-first approach. These contacts have already seen the pitch. Lead with AskTuring result, not pain.

### Step 1 — Variant A
AskTuring proof point, direct. Payment to first qualified meeting in under 10 days. CTA: not sure if timing is better now?

### Step 1 — Variant B
Direct resurface. "Throwing this back your way in case the timing is better now." AskTuring: under 10 days, team had been grinding for months. CTA: worth a second look?

### Step 1 — Variant C
Honest acknowledgment of prior outreach. "Sent this before. Not going to pretend otherwise." AskTuring: under 10 days, faster than most teams finish their onboarding deck. CTA: if reps are still spending too much time finding people to close.

### Step 2 — Self-aware nudge
"You know that thing where an email shows up a second time and you think, oh this again? This is that."
Links:
- [This is how much it costs to run it on your own](https://gamma.app/docs/Outreach-Engine-Case-Studies-spj0v5gzdc2srqu?mode=doc)
- [How other sales teams went from dry spell to 15 meetings a month](https://gamma.app/docs/OutreachEngineco-Your-Outsourced-Sales-Development-Partner-diwj0yk6el3w7fe?mode=doc)

### Step 3 — Authority question
"When your team loses a deal, what is the most common reason? Most B2B SaaS sales teams land on price or product, but when we dig in it is usually just that not enough qualified conversations were happening in the first place."
Calendar: https://calendly.com/kevinn-outreachengine/intro-to-outreach-engine

---

## Saved Marketing

Proof-first. Lead with AskTuring speed result framed for marketing persona.

### Step 1 — Variant A
AskTuring proof: payment to first qualified outbound meeting in under 10 days. Marketing angle: we build the outbound layer. CTA: not sure if timing is better now?

### Step 1 — Variant B
Direct resurface. AskTuring: qualified outbound meetings inside first 10 days. Marketing finally had a channel that did not depend on ad spend. CTA: worth a second look?

### Step 1 — Variant C
Honest. "Reached out before. Keeping it honest." AskTuring: first qualified meeting in under 10 days, faster than most marketing campaigns take to get approved. CTA: if still relying on inbound and paid.

### Step 2 — Self-aware nudge
"Second appearance. I know."
Links:
- [This is how much it costs to run it on your own](https://gamma.app/docs/Outreach-Engine-Case-Studies-spj0v5gzdc2srqu?mode=doc)
- [How others saw their TOFU activity rise like foam](https://gamma.app/docs/OutreachEngineco-Your-Outsourced-Sales-Development-Partner-diwj0yk6el3w7fe?mode=doc)

### Step 3 — Authority question
"When leadership asks marketing at {COMPANY} to explain a pipeline shortfall, what is the usual answer? Most teams point to lead quality or sales follow-up. The ones who added outbound as their own channel stopped having that conversation."
Calendar: https://calendly.com/kevinn-outreachengine/intro-to-outreach-engine

---

## Known issues

- Email 2 and Email 3 HTML formatting: sequences were built with `<p>` tags which create ugly double-spacing in the EmailBison preview. The update API is broken for sequences with variant steps (order deduplication bug). All 4 campaigns need manual HTML cleanup in the sequence editor -- replace `<p>`/`</p>` with `<br><br>`.
- Net New Email 3 (step IDs 3067, 3072): calendar link did not land due to update API failure. Needs manual addition.
- Saved sequences (step IDs 3077, 3082): calendar link is in the body but may also be affected by spacing bug.

## Status

Launched: May 22, 2026
Status: Draft (leads not yet added)
Next step: load Apollo contacts and launch
