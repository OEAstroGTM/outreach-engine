# Supply Wisdom — Instantly → PlusVibe copy

- campaigns: **36**
- steps: **108**, variations: **228**, disabled variants: **76**
- spintax sections carried across unchanged: **2161**
  (Instantly writes `{{RANDOM|…}}`; PlusVibe accepts it — its keyword is case-insensitive)
- `{{sendingAccountName}}` mapped to `{{sender_first_name}}`

## Custom variables your leads MUST carry

Not PlusVibe built-ins. Each resolves only if the lead supplies it via `custom_variables` on `POST /lead/add` or a mapped CSV column. Missing → renders empty, mid-sentence, silently.

- `{{colleaguename}}` — 12×
- `{{company}}` — 3×
- `{{account_signature}}` — 3×
- `{{calendar_link}}` — 1×

## Declared in Instantly

These campaigns declare `custom_variables`: `state`, `industry`, `pause_until`, `colleaguename`, `colleguename`, `title`, `products`, `colleagueMention`, `city`, `colleaguemention`, `email`, `campaign`

Note any near-duplicates — Instantly tolerates typo'd variable names that silently never resolve.

## Variables snake_cased by guess

- `{{colleaguename}}` → `{{colleaguename}}` (12×)
- `{{company}}` → `{{company}}` (3×)
- `{{calendarLink}}` → `{{calendar_link}}` (1×)
- `{{accountSignature}}` → `{{account_signature}}` (3×)

## Step-1 subjects backfilled (2)

PlusVibe rejects an empty subject on step 1; Instantly allowed it. Each of these took the subject from a sibling variant on the same step.

- `10bbf711-822b-4fc1-9316-f0f6eba7159d` variation D → `risk review {{first_name}}`  (Healthcare - Risk Assmt)
- `10bbf711-822b-4fc1-9316-f0f6eba7159d` variation E → `risk review {{first_name}}`  (Healthcare - Risk Assmt)

