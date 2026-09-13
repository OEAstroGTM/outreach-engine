// ── valley.js ────────────────────────────────────────────────────────────────
// Valley (https://joinvalley.co) — LinkedIn AI outbound sequencer.
//
// Shape mirrors an email sequencer, with one substitution: where EmailBison /
// Instantly send from provisioned *infra* (domains + mailboxes), Valley sends
// from *collaborators* — Valley users whose LinkedIn account is attached. So
// there is nothing to register or DNS-point; sending capacity is seats.
//
// Valley-only concepts with no email analogue:
//   • approvals — AI-drafted messages queued for human approve / unapprove /
//     unschedule before they ever send.
//   • warmlist  — warm signals (profile viewers / followers / engagers), each
//     bucketed by ICP fit.
//
// Env:
//   VALLEY_API_KEY        valley_<hex>. Owner-scoped to ONE Valley user: every
//                         call acts as that user and sees only their workspaces.
//   VALLEY_API_BASE_URL   defaults to the live host below.
//
// Verified against the live API 2026-09-14. Notes the published docs omit:
//   • GET /inbox/conversations   requires ?view=inbox|archived      (else 400)
//   • GET /approvals/messages    requires ?view=pending|approved|scheduled
//   • GET /analytics/overview    requires startDate + endDate + workspaceId
//   • pagination envelope is { limit, offset, total, hasMore }
import { cockpitSecret } from "./core.js";

export const VALLEY_BASE =
  (process.env.VALLEY_API_BASE_URL || "https://api.joinvalley.co/public/v1").replace(/\/$/, "");

const valleyKey = () =>
  cockpitSecret("__global__", "valley") ?? process.env.VALLEY_API_KEY;

const MAX_LIMIT = 100; // API caps limit at 100; higher values are silently clamped.

async function valley(method, path, { query, body } = {}) {
  const key = valleyKey();
  if (!key) throw new Error("VALLEY_API_KEY is not set");

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const url = `${VALLEY_BASE}${path}${qs.toString() ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    method,
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }

  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    throw new Error(`Valley rate limited (429)${reset ? `; resets ${reset}` : ""} — back off before retrying`);
  }
  if (!res.ok) {
    // Valley returns a useful `message` on 400s (e.g. a missing `view` param).
    throw new Error(`Valley ${method} ${path} → HTTP ${res.status}: ${data?.message ?? data?.raw ?? ""}`);
  }
  return data?.data ?? data;
}

// Page through an offset-paginated collection rather than silently returning
// only the first page — the failure mode that made inboxingListDomains() report
// 50 of 406 domains.
async function paginate(path, { query = {}, key, limit = MAX_LIMIT, max = Infinity } = {}) {
  const out = [];
  let offset = 0;
  for (;;) {
    const page = await valley("GET", path, {
      query: { ...query, limit: Math.min(limit, MAX_LIMIT), offset },
    });
    const rows = page?.[key] ?? [];
    out.push(...rows);
    const p = page?.pagination;
    if (!rows.length || !p?.hasMore || out.length >= max) break;
    offset += rows.length;
    if (offset >= (p.total ?? Infinity)) break;
  }
  return max === Infinity ? out : out.slice(0, max);
}

// ── Identity / workspaces ────────────────────────────────────────────────────
export const getMe = () => valley("GET", "/users/me");

export const listWorkspaces = ({ all = true, limit } = {}) =>
  all ? paginate("/workspaces", { key: "workspaces" })
      : valley("GET", "/workspaces", { query: { limit } });

// Collaborators = the workspace's Valley users. These are the people whose
// LinkedIn sends; the API exposes identity + role (OWNER/ADMIN/MEMBER) but NOT
// LinkedIn connection status, so "is this seat actually able to send?" is only
// observable via campaign_owner_* on a campaign.
export const listCollaborators = ({ workspace_id }) => {
  if (!workspace_id) throw new Error("workspace_id is required");
  return paginate(`/workspaces/${encodeURIComponent(workspace_id)}/users`, { key: "users" });
};

export const listWorkspaceProducts = () =>
  paginate("/workspace-products", { key: "workspace_products" });

// ── Campaigns ────────────────────────────────────────────────────────────────
export const listCampaigns = ({ workspace_id, all = true, limit } = {}) =>
  all ? paginate("/campaigns/get-all", { key: "campaigns", query: { workspaceId: workspace_id } })
      : valley("GET", "/campaigns/get-all", { query: { workspaceId: workspace_id, limit } });

export const getCampaign = ({ campaign_id }) =>
  valley("GET", `/campaigns/${encodeURIComponent(campaign_id)}`);

export const getCampaignProspects = ({ campaign_id, all = true }) =>
  all ? paginate(`/campaigns/${encodeURIComponent(campaign_id)}/prospects`, { key: "prospects" })
      : valley("GET", `/campaigns/${encodeURIComponent(campaign_id)}/prospects`);

// Like /analytics/overview, this needs an explicit date window — undocumented,
// and a 400 without it.
export const getCampaignAnalytics = ({ campaign_id, start_date, end_date }) => {
  const missing = ["campaign_id", "start_date", "end_date"]
    .filter(k => !({ campaign_id, start_date, end_date })[k]);
  if (missing.length) throw new Error(`getCampaignAnalytics requires: ${missing.join(", ")}`);
  return valley("GET", `/campaigns/${encodeURIComponent(campaign_id)}/analytics`, {
    query: { startDate: start_date, endDate: end_date },
  });
};

export const createCampaign = (body) => valley("POST", "/campaigns", { body });

export const updateCampaign = ({ campaign_id, ...body }) =>
  valley("PATCH", `/campaigns/${encodeURIComponent(campaign_id)}`, { body });

const lifecycle = (action) => ({ campaign_id }) =>
  valley("POST", `/campaigns/${encodeURIComponent(campaign_id)}/${action}`);

export const startCampaign  = lifecycle("start");
export const pauseCampaign  = lifecycle("pause");
export const resumeCampaign = lifecycle("resume");
export const archiveCampaign = lifecycle("archive");

// NOT IDEMPOTENT — Valley's docs say so explicitly. A timed-out call may have
// landed; re-firing it can double-add the lead. On timeout, verify with
// getCampaignProspects() before retrying rather than retrying blind.
export const addLeadToCampaign = (body) =>
  valley("POST", "/campaigns/add-lead-to-campaign", { body });

export const getImportJob = ({ job_id }) =>
  valley("GET", `/import-jobs/${encodeURIComponent(job_id)}`);

// ── Inbox ────────────────────────────────────────────────────────────────────
const INBOX_VIEWS = ["inbox", "archived"];

export const listConversations = ({ workspace_id, view = "inbox", all = true } = {}) => {
  if (!INBOX_VIEWS.includes(view)) {
    throw new Error(`view must be one of: ${INBOX_VIEWS.join(", ")}`);
  }
  const query = { view, workspaceId: workspace_id };
  return all ? paginate("/inbox/conversations", { key: "conversations", query })
             : valley("GET", "/inbox/conversations", { query });
};

const convoAction = (action) => ({ conversation_id }) =>
  valley("POST", `/inbox/conversations/${encodeURIComponent(conversation_id)}/${action}`);

export const markConversationRead    = convoAction("read");
export const markConversationUnread  = convoAction("unread");
export const archiveConversation     = convoAction("archive");
export const unarchiveConversation   = convoAction("unarchive");

// ── Approvals (no email-sequencer analogue) ──────────────────────────────────
const APPROVAL_VIEWS = ["pending", "approved", "scheduled"];

export const listApprovalMessages = ({ workspace_id, view = "pending", all = true } = {}) => {
  if (!APPROVAL_VIEWS.includes(view)) {
    throw new Error(`view must be one of: ${APPROVAL_VIEWS.join(", ")}`);
  }
  const query = { view, workspaceId: workspace_id };
  return all ? paginate("/approvals/messages", { key: "messages", query })
             : valley("GET", "/approvals/messages", { query });
};

const approvalAction = (action) => ({ message_id }) =>
  valley("POST", `/approvals/messages/${encodeURIComponent(message_id)}/${action}`);

// Each of these SENDS or UNSENDS real LinkedIn outreach — never call
// speculatively, and never batch without an explicit operator go-ahead.
export const approveMessage    = approvalAction("approve");
export const unapproveMessage  = approvalAction("unapprove");
export const unscheduleMessage = approvalAction("unschedule");

// ── Warmlist (warm signals) ──────────────────────────────────────────────────
export const warmlistStats = ({ workspace_id }) => {
  if (!workspace_id) throw new Error("workspace_id is required");
  return valley("GET", `/warmlist/${encodeURIComponent(workspace_id)}/stats`);
};

const warmlistSegment = (segment) => ({ workspace_id, all = true, limit }) => {
  if (!workspace_id) throw new Error("workspace_id is required");
  const path = `/warmlist/${encodeURIComponent(workspace_id)}/${segment}`;
  return all ? paginate(path, { key: "prospects" })
             : valley("GET", path, { query: { limit } });
};

export const warmlistFollowers = warmlistSegment("followers");
export const warmlistViewers   = warmlistSegment("viewers");
export const warmlistEngagers  = warmlistSegment("engagers");

// ── Analytics ────────────────────────────────────────────────────────────────
// All three params are required; omitting any yields a 400.
export const analyticsOverview = ({ workspace_id, start_date, end_date }) => {
  const missing = ["workspace_id", "start_date", "end_date"]
    .filter(k => !({ workspace_id, start_date, end_date })[k]);
  if (missing.length) throw new Error(`analyticsOverview requires: ${missing.join(", ")}`);
  return valley("GET", "/analytics/overview", {
    query: { workspaceId: workspace_id, startDate: start_date, endDate: end_date },
  });
};

// ── Misc metadata ────────────────────────────────────────────────────────────
export const listTemplates     = () => paginate("/templates", { key: "templates" });
export const listWritingStyles = () => paginate("/writing-styles", { key: "writing_styles" });
