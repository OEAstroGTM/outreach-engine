// Intellectible workspace config
const EB_BASE    = process.env.EMAILBISON_SEND_URL ?? "https://send.outreachenginedashboard.co";
const EB_KEY     = process.env.EMAILBISON_SEND_API_KEY!;
const EB_WS_ID   = 28;

const MI_BASE    = "https://api.masterinbox.com/api/api-webhook/v1/api";
const MI_KEY     = process.env.MASTERINBOX_API_KEY!;
const MI_WS_ID   = "1058";

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const APOLLO_KEY  = process.env.APOLLO_API_KEY;

// ── EmailBison helpers ─────────────────────────────────────────────────────

async function ebFetch(path: string, method = "GET", body?: object) {
  // Switch workspace first
  await fetch(`${EB_BASE}/api/workspaces/v1.1/switch-workspace`, {
    method: "POST",
    headers: { Authorization: `Bearer ${EB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ team_id: EB_WS_ID }),
  });

  const res = await fetch(`${EB_BASE}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${EB_KEY}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// ── MasterInbox helpers ────────────────────────────────────────────────────

async function miFetch(path: string, method = "GET", body?: object) {
  const res = await fetch(`${MI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${MI_KEY}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

// ── Apollo helpers ─────────────────────────────────────────────────────────

async function apolloPost(path: string, body: object) {
  if (!APOLLO_KEY) return { error: "APOLLO_API_KEY not configured" };
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": APOLLO_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Tool executors ─────────────────────────────────────────────────────────

export async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    // Campaigns
    case "list_campaigns":
      return ebFetch("/campaigns");

    case "get_campaign_stats":
      return ebFetch(`/campaigns/${input.campaign_id}`);

    case "launch_campaign":
      return ebFetch(`/campaigns/${input.campaign_id}`, "PATCH", { status: "active" });

    case "pause_campaign":
      return ebFetch(`/campaigns/${input.campaign_id}/pause`, "POST");

    // Inbox
    case "list_replies":
      return miFetch("/get-prospects", "POST", {
        workspace_id: MI_WS_ID,
        label_id:     input.label_id,
        page:         input.page,
        limit:        input.limit ?? 20,
      });

    case "list_labels":
      return miFetch("/get-labels");

    case "get_reply_thread":
      return miFetch("/get-messages", "POST", {
        prospect_id:    input.prospect_id,
        prospect_email: input.prospect_email,
      });

    case "tag_reply":
      return miFetch("/add-prospect-label", "POST", {
        prospect_id: input.prospect_id,
        label_id:    input.label_id,
      });

    case "send_reply":
      return miFetch("/send-message", "POST", {
        prospect_id:  input.prospect_id,
        message:      input.message,
        workspace_id: MI_WS_ID,
      });

    // Research
    case "find_company":
      return apolloPost("/mixed_companies/search", {
        q_organization_name:    input.company_name,
        q_organization_domains: input.domain ? [input.domain] : [],
        per_page: 1,
      });

    case "find_contacts":
      return apolloPost("/mixed_people/search", {
        q_organization_name:    input.company_name,
        q_organization_domains: input.domain ? [input.domain] : [],
        person_titles:          input.titles ?? [],
        per_page:               input.limit ?? 5,
      });

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
