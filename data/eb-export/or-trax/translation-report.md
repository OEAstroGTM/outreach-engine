# EmailBison → PlusVibe copy translation

Source: `data/eb-export/or-trax/plusvibe.json`  →  `data/eb-export/or-trax/plusvibe.translated.json`

- spintax sections rewritten to `{{random|…}}`: **297**
- merge tags rewritten: **343**
- `{SENDER_FULL_NAME}` mapped to `{{sender_first_name}}`
- sections violating PlusVibe limits: **0**  (no length cap — PlusVibe documents none)

## Custom variables your leads MUST carry

These are not PlusVibe built-ins. Each only resolves if the lead supplies it — `custom_variables` on `POST /lead/add`, or a mapped column on CSV import. If it's missing the token renders **empty**, mid-sentence, with no error.

- `{{state}}`  — 32 occurrence(s)

