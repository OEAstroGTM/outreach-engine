let SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY, INBOXING_API_KEY,
    EMAILBISON_SEND_API_KEY, EMAILBISON_PERSONAL_API_KEY, MASTERINBOX_API_KEY;

const EMAILBISON_SEND_URL = "https://send.outreachenginedashboard.co";
const EMAILBISON_PERSONAL_URL = "https://personal.outreachenginedashboard.co";

// Still needed as Cloudflare Worker secrets:
//   INSTANTLY_SUPPLY_WISDOM_API_KEY
//   INSTANTLY_LEND_HOME_API_KEY
//   INSTANTLY_SURETY_NOW_API_KEY
//   WINNR_LEND_HOME_API_KEY
//   PORKBUN_API_KEY
//   PORKBUN_SECRET_API_KEY
// KV namespace binding: SKILLS

const MI = "https://api.masterinbox.com/api/api-webhook/v1/api";
const INTERNAL_WS = ["crash dummy", "inboxinguploads", "felipe", "zdeact", "inboxing personal", "inboxing uploads"];
const isInternal = (name) => INTERNAL_WS.some(i => (name || "").toLowerCase().includes(i));

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "emailbison_list_campaigns",
    description: "List all campaigns in an EmailBison instance with their status and stats.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"], description: "'send' = main outreach (ClawOE), 'personal' = personal instance" }
      },
      required: ["instance"]
    }
  },
  {
    name: "emailbison_get_campaign_stats",
    description: "Get detailed stats for a specific campaign (sent, replies, interested, bounces).",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] },
        campaign_id: { type: "string" }
      },
      required: ["instance", "campaign_id"]
    }
  },
  {
    name: "emailbison_list_replies",
    description: "List replies in an EmailBison instance. Optionally switch to a workspace first and filter to interested only.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] },
        team_id: { type: "number", description: "Workspace team ID to switch to (optional)" },
        interested_only: { type: "boolean", description: "Only return interested replies" }
      },
      required: ["instance"]
    }
  },
  {
    name: "emailbison_get_interested_replies_all_workspaces",
    description: "Fetch interested replies across ALL non-internal workspaces in an EmailBison instance.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] }
      },
      required: ["instance"]
    }
  },
  {
    name: "emailbison_list_email_accounts",
    description: "List all sender email accounts in an EmailBison instance. Optionally switch to a workspace first.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] },
        team_id: { type: "number", description: "Workspace team ID to switch to (optional)" }
      },
      required: ["instance"]
    }
  },
  {
    name: "emailbison_get_all_workspace_mailbox_counts",
    description: "Get sender email counts for all non-internal workspaces in an EmailBison instance.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] }
      },
      required: ["instance"]
    }
  },
  {
    name: "emailbison_launch_campaign",
    description: "Launch (activate) a campaign so it starts sending.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] },
        campaign_id: { type: "string" }
      },
      required: ["instance", "campaign_id"]
    }
  },
  {
    name: "emailbison_pause_campaign",
    description: "Pause a running campaign.",
    input_schema: {
      type: "object",
      properties: {
        instance: { type: "string", enum: ["send", "personal"] },
        campaign_id: { type: "string" }
      },
      required: ["instance", "campaign_id"]
    }
  },
  {
    name: "masterinbox_list_workspaces",
    description: "List all client workspaces in MasterInbox.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "masterinbox_list_replies",
    description: "List replies in MasterInbox. Optionally filter by workspace_id or label_id.",
    input_schema: {
      type: "object",
      properties: {
        workspace_id: { type: "string" },
        label_id: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "masterinbox_get_thread",
    description: "Get the full conversation thread for a prospect by email or prospect ID.",
    input_schema: {
      type: "object",
      properties: {
        prospect_email: { type: "string" },
        prospect_id: { type: "string" }
      }
    }
  },
  {
    name: "masterinbox_list_labels",
    description: "List all labels in MasterInbox (e.g. Interested, Not Interested, Demo Booked).",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "masterinbox_get_label_stats",
    description: "Get how many prospects are tagged with a specific label in MasterInbox.",
    input_schema: {
      type: "object",
      properties: {
        label_id: { type: "string" }
      },
      required: ["label_id"]
    }
  },
  {
    name: "masterinbox_tag_reply",
    description: "Assign a label to a prospect in MasterInbox (e.g. mark as Interested).",
    input_schema: {
      type: "object",
      properties: {
        prospect_id: { type: "string" },
        label_id: { type: "string" }
      },
      required: ["prospect_id", "label_id"]
    }
  },
  {
    name: "masterinbox_get_prospects",
    description: "Search prospects in MasterInbox by name, email, label, or workspace.",
    input_schema: {
      type: "object",
      properties: {
        search: { type: "string" },
        label_id: { type: "string" },
        workspace_id: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "masterinbox_get_prospects_by_email",
    description: "Look up a specific prospect in MasterInbox by email address.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string" }
      },
      required: ["email"]
    }
  },
  {
    name: "masterinbox_send_message",
    description: "Send a reply to a prospect from MasterInbox.",
    input_schema: {
      type: "object",
      properties: {
        prospect_id: { type: "string" },
        message: { type: "string" },
        workspace_id: { type: "string" }
      },
      required: ["prospect_id", "message"]
    }
  },
  {
    name: "inboxing_list_domains",
    description: "List all domains in Inboxing with their status. Supports filtering by status and search term.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: active, pending, dns_setup, queued, setting_up" },
        search: { type: "string", description: "Search by domain name" },
        page: { type: "number" },
        limit: { type: "number" }
      }
    }
  },
  {
    name: "inboxing_check_domain_status",
    description: "Check the setup status of a specific domain in Inboxing.",
    input_schema: {
      type: "object",
      properties: {
        domain_id: { type: "string" }
      },
      required: ["domain_id"]
    }
  },
  {
    name: "inboxing_get_slots",
    description: "Check available, used, and remaining mailbox slots in Inboxing.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "instantly_list_accounts",
    description: "List all sending email accounts in an Instantly workspace (warmup status, daily limits, domains).",
    input_schema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["supply_wisdom", "lend_home", "surety_now"], description: "supply_wisdom = Supply Wisdom, lend_home = LendHome/Built Right, surety_now = Surety Now" },
        limit: { type: "number" },
        starting_after: { type: "string" }
      },
      required: ["workspace"]
    }
  },
  {
    name: "instantly_list_campaigns",
    description: "List all campaigns in an Instantly workspace.",
    input_schema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["supply_wisdom", "lend_home", "surety_now"] },
        limit: { type: "number" },
        starting_after: { type: "string" }
      },
      required: ["workspace"]
    }
  },
  {
    name: "instantly_get_campaign_analytics",
    description: "Get analytics for an Instantly workspace (sent, opens, replies, bounces). Omit campaign_id for overview across all campaigns.",
    input_schema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["supply_wisdom", "lend_home", "surety_now"] },
        campaign_id: { type: "string", description: "Specific campaign ID — omit for full overview" }
      },
      required: ["workspace"]
    }
  },
  {
    name: "instantly_list_leads",
    description: "List leads in an Instantly workspace, optionally filtered by campaign.",
    input_schema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["supply_wisdom", "lend_home", "surety_now"] },
        campaign_id: { type: "string" },
        limit: { type: "number" },
        starting_after: { type: "string" }
      },
      required: ["workspace"]
    }
  },
  {
    name: "instantly_list_replies",
    description: "List email replies in an Instantly workspace. Use email_type='received' for incoming replies. Use i_status=2 for interested only.",
    input_schema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["supply_wisdom", "lend_home", "surety_now"] },
        campaign_id: { type: "string" },
        email_type: { type: "string", enum: ["received", "sent", "manual"] },
        i_status: { type: "number", description: "2=interested, -1=not interested, 0=neutral" },
        limit: { type: "number" },
        starting_after: { type: "string" }
      },
      required: ["workspace"]
    }
  },
  {
    name: "instantly_get_interested_replies",
    description: "Fetch ALL interested replies across an Instantly workspace, auto-paginating through all results.",
    input_schema: {
      type: "object",
      properties: {
        workspace: { type: "string", enum: ["supply_wisdom", "lend_home", "surety_now"] }
      },
      required: ["workspace"]
    }
  },
  {
    name: "winnr_list_domains",
    description: "List all email domains in the Winnr account (LendHome / Built Right) with status, DNS, expiry, and mailbox count.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "number" },
        cursor: { type: "string" }
      }
    }
  },
  {
    name: "winnr_list_email_users",
    description: "List all email mailboxes in the Winnr account. Optionally filter by domain.",
    input_schema: {
      type: "object",
      properties: {
        domain_id: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" }
      }
    }
  },
  {
    name: "winnr_get_domain",
    description: "Get details for a specific Winnr domain (DNS status, registrar, mailbox count).",
    input_schema: {
      type: "object",
      properties: {
        domain_id: { type: "string" }
      },
      required: ["domain_id"]
    }
  },
  {
    name: "porkbun_list_domains",
    description: "List all domains registered in the Porkbun account with expiry dates and status.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "porkbun_get_dns_records",
    description: "Retrieve all DNS records for a domain in Porkbun.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "The domain name (e.g. example.com)" }
      },
      required: ["domain"]
    }
  },
  {
    name: "porkbun_create_dns_record",
    description: "Create a new DNS record for a domain in Porkbun. Supports A, MX, TXT, CNAME, AAAA, NS, SRV, CAA, and more.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        type: { type: "string", enum: ["A", "MX", "CNAME", "ALIAS", "TXT", "NS", "AAAA", "SRV", "TLSA", "CAA", "HTTPS", "SVCB"] },
        content: { type: "string", description: "Record value (IP, hostname, TXT string, etc.)" },
        name: { type: "string", description: "Subdomain — blank for root (@), * for wildcard" },
        ttl: { type: "number", description: "TTL in seconds (min 600)" },
        prio: { type: "number", description: "Priority — required for MX and SRV" }
      },
      required: ["domain", "type", "content"]
    }
  },
  {
    name: "porkbun_edit_dns_record",
    description: "Edit an existing DNS record by ID. Get IDs from porkbun_get_dns_records.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        record_id: { type: "string" },
        type: { type: "string", enum: ["A", "MX", "CNAME", "ALIAS", "TXT", "NS", "AAAA", "SRV", "TLSA", "CAA", "HTTPS", "SVCB"] },
        content: { type: "string" },
        name: { type: "string" },
        ttl: { type: "number" },
        prio: { type: "number" }
      },
      required: ["domain", "record_id", "type", "content"]
    }
  },
  {
    name: "porkbun_delete_dns_record",
    description: "Delete a DNS record by ID. Get IDs from porkbun_get_dns_records.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string" },
        record_id: { type: "string" }
      },
      required: ["domain", "record_id"]
    }
  },
  {
    name: "porkbun_check_domain_availability",
    description: "Check if a domain is available to register and get its price.",
    input_schema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Full domain name to check (e.g. mycoolbrand.com)" }
      },
      required: ["domain"]
    }
  },
  {
    name: "porkbun_get_pricing",
    description: "Get registration, renewal, and transfer prices for all TLDs on Porkbun.",
    input_schema: { type: "object", properties: {} }
  }
];

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(method, url, body, headers) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `Non-JSON response (${res.status})`, body: text.slice(0, 500) };
  }
}

function ebBase(instance) {
  return (instance === "send" ? EMAILBISON_SEND_URL : EMAILBISON_PERSONAL_URL) + "/api";
}

function ebAuth(instance) {
  return { Authorization: `Bearer ${instance === "send" ? EMAILBISON_SEND_API_KEY : EMAILBISON_PERSONAL_API_KEY}` };
}

function miAuth() {
  return { Authorization: `Bearer ${MASTERINBOX_API_KEY}` };
}

function pbFetch(path, body, env) {
  return apiFetch("POST", `https://api.porkbun.com/api/json/v3${path}`, {
    apikey: env.PORKBUN_API_KEY,
    secretapikey: env.PORKBUN_SECRET_API_KEY,
    ...body
  }, {});
}

function instKey(workspace, env) {
  const keys = {
    supply_wisdom: env.INSTANTLY_SUPPLY_WISDOM_API_KEY,
    lend_home: env.INSTANTLY_LEND_HOME_API_KEY,
    surety_now: env.INSTANTLY_SURETY_NOW_API_KEY
  };
  return keys[workspace];
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, input, env) {
  try {
    switch (name) {
      case "emailbison_list_campaigns":
        return apiFetch("GET", `${ebBase(input.instance)}/campaigns`, undefined, ebAuth(input.instance));

      case "emailbison_get_campaign_stats":
        return apiFetch("GET", `${ebBase(input.instance)}/campaigns/${input.campaign_id}`, undefined, ebAuth(input.instance));

      case "emailbison_list_replies": {
        const base = ebBase(input.instance);
        const auth = ebAuth(input.instance);
        if (input.team_id) await apiFetch("POST", `${base}/workspaces/v1.1/switch-workspace`, { team_id: input.team_id }, auth);
        const res = await apiFetch("GET", `${base}/replies`, undefined, auth);
        let replies = res?.data ?? res ?? [];
        if (input.interested_only && Array.isArray(replies)) replies = replies.filter(r => r.interested === true);
        return { data: replies, total: Array.isArray(replies) ? replies.length : undefined };
      }

      case "emailbison_get_interested_replies_all_workspaces": {
        const base = ebBase(input.instance);
        const auth = ebAuth(input.instance);
        const wsRes = await apiFetch("POST", `${base}/workspaces/v1.1/list-workspaces`, {}, auth);
        const workspaces = wsRes?.data ?? wsRes ?? [];
        const results = [];
        for (const ws of workspaces) {
          if (isInternal(ws.name)) continue;
          const teamId = ws.id ?? ws.team_id;
          if (!teamId) continue;
          await apiFetch("POST", `${base}/workspaces/v1.1/switch-workspace`, { team_id: teamId }, auth);
          const repliesRes = await apiFetch("GET", `${base}/replies`, undefined, auth);
          const all = repliesRes?.data ?? repliesRes ?? [];
          const interested = Array.isArray(all) ? all.filter(r => r.interested === true) : [];
          results.push({ workspace: ws.name, team_id: teamId, interested_count: interested.length, replies: interested });
        }
        return { total_interested: results.reduce((s, r) => s + r.interested_count, 0), workspaces: results };
      }

      case "emailbison_list_email_accounts": {
        const base = ebBase(input.instance);
        const auth = ebAuth(input.instance);
        if (input.team_id) await apiFetch("POST", `${base}/workspaces/v1.1/switch-workspace`, { team_id: input.team_id }, auth);
        const res = await apiFetch("GET", `${base}/sender-emails`, undefined, auth);
        const accounts = res?.data ?? res ?? [];
        return { total: accounts.length, accounts };
      }

      case "emailbison_get_all_workspace_mailbox_counts": {
        const base = ebBase(input.instance);
        const auth = ebAuth(input.instance);
        const wsRes = await apiFetch("GET", `${base}/workspaces`, undefined, auth);
        const workspaces = (wsRes?.data ?? wsRes ?? []).filter(w => !isInternal(w.name));
        const results = [];
        for (const ws of workspaces) {
          const teamId = ws.id ?? ws.team_id;
          if (!teamId) continue;
          await apiFetch("POST", `${base}/workspaces/v1.1/switch-workspace`, { team_id: teamId }, auth);
          const sRes = await apiFetch("GET", `${base}/sender-emails`, undefined, auth);
          const emails = sRes?.data ?? sRes ?? [];
          results.push({ workspace: ws.name, team_id: teamId, sender_email_count: emails.length });
        }
        return { total_sender_emails: results.reduce((s, r) => s + r.sender_email_count, 0), workspaces: results };
      }

      case "emailbison_launch_campaign":
        return apiFetch("PATCH", `${ebBase(input.instance)}/campaigns/${input.campaign_id}`, { status: "active" }, ebAuth(input.instance));

      case "emailbison_pause_campaign":
        return apiFetch("POST", `${ebBase(input.instance)}/campaigns/${input.campaign_id}/pause`, {}, ebAuth(input.instance));

      case "masterinbox_list_workspaces":
        return apiFetch("GET", `${MI}/get-all-workspaces`, undefined, miAuth());

      case "masterinbox_list_replies":
        return apiFetch("POST", `${MI}/get-prospects`, { label_id: input.label_id, workspace_id: input.workspace_id, page: input.page, limit: input.limit }, miAuth());

      case "masterinbox_get_thread":
        return apiFetch("POST", `${MI}/get-messages`, { prospect_email: input.prospect_email, prospect_id: input.prospect_id }, miAuth());

      case "masterinbox_list_labels":
        return apiFetch("GET", `${MI}/get-labels`, undefined, miAuth());

      case "masterinbox_get_label_stats":
        return apiFetch("POST", `${MI}/get-label-stats`, { label_id: input.label_id }, miAuth());

      case "masterinbox_tag_reply":
        return apiFetch("POST", `${MI}/add-prospect-label`, { prospect_id: input.prospect_id, label_id: input.label_id }, miAuth());

      case "masterinbox_get_prospects":
        return apiFetch("POST", `${MI}/get-prospects`, { search: input.search, label_id: input.label_id, workspace_id: input.workspace_id, page: input.page, limit: input.limit }, miAuth());

      case "masterinbox_get_prospects_by_email":
        return apiFetch("POST", `${MI}/get-prospects-by-email`, { email: input.email }, miAuth());

      case "masterinbox_send_message":
        return apiFetch("POST", `${MI}/send-message`, { prospect_id: input.prospect_id, message: input.message, workspace_id: input.workspace_id }, miAuth());

      case "inboxing_list_domains": {
        const params = new URLSearchParams();
        if (input.status) params.set("status", input.status);
        if (input.search) params.set("search", input.search);
        if (input.page) params.set("page", String(input.page));
        if (input.limit) params.set("limit", String(input.limit));
        const qs = params.toString();
        return apiFetch("GET", `https://v2.inboxing.com/api/v2/domains${qs ? "?" + qs : ""}`, undefined, { "X-API-Key": INBOXING_API_KEY });
      }

      case "inboxing_check_domain_status":
        return apiFetch("GET", `https://v2.inboxing.com/api/v2/domains/${input.domain_id}/status`, undefined, { "X-API-Key": INBOXING_API_KEY });

      case "inboxing_get_slots":
        return apiFetch("GET", "https://v2.inboxing.com/api/v2/slots", undefined, { "X-API-Key": INBOXING_API_KEY });

      case "instantly_list_accounts": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
        if (input.starting_after) params.set("starting_after", input.starting_after);
        return apiFetch("GET", `https://api.instantly.ai/api/v2/accounts?${params}`, undefined, { Authorization: `Bearer ${instKey(input.workspace, env)}` });
      }

      case "instantly_list_campaigns": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 10) });
        if (input.starting_after) params.set("starting_after", input.starting_after);
        return apiFetch("GET", `https://api.instantly.ai/api/v2/campaigns?${params}`, undefined, { Authorization: `Bearer ${instKey(input.workspace, env)}` });
      }

      case "instantly_get_campaign_analytics": {
        const auth = { Authorization: `Bearer ${instKey(input.workspace, env)}` };
        if (input.campaign_id) {
          return apiFetch("GET", `https://api.instantly.ai/api/v2/campaigns/analytics?campaign_id=${input.campaign_id}`, undefined, auth);
        }
        return apiFetch("GET", "https://api.instantly.ai/api/v2/campaigns/analytics/overview", undefined, auth);
      }

      case "instantly_list_leads": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
        if (input.campaign_id) params.set("campaign_id", input.campaign_id);
        if (input.starting_after) params.set("starting_after", input.starting_after);
        return apiFetch("GET", `https://api.instantly.ai/api/v2/leads?${params}`, undefined, { Authorization: `Bearer ${instKey(input.workspace, env)}` });
      }

      case "instantly_list_replies": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 20) });
        if (input.campaign_id) params.set("campaign_id", input.campaign_id);
        if (input.email_type) params.set("email_type", input.email_type);
        if (input.i_status !== undefined) params.set("i_status", String(input.i_status));
        if (input.starting_after) params.set("starting_after", input.starting_after);
        return apiFetch("GET", `https://api.instantly.ai/api/v2/emails?${params}`, undefined, { Authorization: `Bearer ${instKey(input.workspace, env)}` });
      }

      case "instantly_get_interested_replies": {
        const auth = { Authorization: `Bearer ${instKey(input.workspace, env)}` };
        const allReplies = [];
        let cursor;
        const MAX_PAGES = 100;
        let pages = 0;
        while (pages < MAX_PAGES) {
          pages++;
          const params = new URLSearchParams({ limit: "100", email_type: "received", i_status: "2" });
          if (cursor) params.set("starting_after", cursor);
          const res = await apiFetch("GET", `https://api.instantly.ai/api/v2/emails?${params}`, undefined, auth);
          const items = res?.items ?? [];
          allReplies.push(...items);
          cursor = res?.next_cursor;
          if (!cursor || items.length === 0) break;
        }
        const byCampaign = {};
        for (const e of allReplies) {
          const cid = e.campaign_id ?? "no_campaign";
          if (!byCampaign[cid]) byCampaign[cid] = { campaign_id: cid, count: 0 };
          byCampaign[cid].count++;
        }
        return { workspace: input.workspace, total_interested: allReplies.length, by_campaign: Object.values(byCampaign), replies: allReplies };
      }

      case "winnr_list_domains": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
        if (input.cursor) params.set("cursor", input.cursor);
        return apiFetch("GET", `https://api.winnr.app/v1/domains?${params}`, undefined, { Authorization: `Bearer ${env.WINNR_LEND_HOME_API_KEY}` });
      }

      case "winnr_list_email_users": {
        const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
        if (input.domain_id) params.set("domain_id", input.domain_id);
        if (input.cursor) params.set("cursor", input.cursor);
        return apiFetch("GET", `https://api.winnr.app/v1/email-users?${params}`, undefined, { Authorization: `Bearer ${env.WINNR_LEND_HOME_API_KEY}` });
      }

      case "winnr_get_domain":
        return apiFetch("GET", `https://api.winnr.app/v1/domains/${input.domain_id}`, undefined, { Authorization: `Bearer ${env.WINNR_LEND_HOME_API_KEY}` });

      case "porkbun_list_domains":
        return pbFetch(`/domain/listAll`, {}, env);

      case "porkbun_get_dns_records":
        return pbFetch(`/dns/retrieve/${input.domain}`, {}, env);

      case "porkbun_create_dns_record":
        return pbFetch(`/dns/create/${input.domain}`, {
          type: input.type,
          content: input.content,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.ttl !== undefined ? { ttl: String(input.ttl) } : {}),
          ...(input.prio !== undefined ? { prio: String(input.prio) } : {}),
        }, env);

      case "porkbun_edit_dns_record":
        return pbFetch(`/dns/edit/${input.domain}/${input.record_id}`, {
          type: input.type,
          content: input.content,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.ttl !== undefined ? { ttl: String(input.ttl) } : {}),
          ...(input.prio !== undefined ? { prio: String(input.prio) } : {}),
        }, env);

      case "porkbun_delete_dns_record":
        return pbFetch(`/dns/delete/${input.domain}/${input.record_id}`, {}, env);

      case "porkbun_check_domain_availability":
        return pbFetch(`/domain/availability`, { domain: input.domain }, env);

      case "porkbun_get_pricing":
        return pbFetch(`/pricing/get`, {}, env);

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: String(e) };
  }
}

// ── Skills (Cloudflare KV) ────────────────────────────────────────────────────

async function getSkills(kv) {
  if (!kv) return [];
  const index = await kv.get("__index__", "json");
  if (!Array.isArray(index)) return [];
  const skills = await Promise.all(index.map(key => kv.get(key, "json")));
  return skills.filter(Boolean);
}

async function saveSkill(kv, name, description, user) {
  if (!kv) return;
  const key = name.toLowerCase().trim();
  await kv.put(key, JSON.stringify({ name, description, createdBy: user, createdAt: new Date().toISOString() }));
  const index = (await kv.get("__index__", "json")) || [];
  if (!index.includes(key)) await kv.put("__index__", JSON.stringify([...index, key]));
}

async function forgetSkill(kv, name) {
  if (!kv) return;
  const key = name.toLowerCase().trim();
  await kv.delete(key);
  const index = ((await kv.get("__index__", "json")) || []).filter(k => k !== key);
  await kv.put("__index__", JSON.stringify(index));
}

function buildSystemPrompt(skills) {
  let prompt = `You are Flor, an AI ops assistant for Outreach Engine. You help manage cold email infrastructure using your tools:
- EmailBison ("send" instance = ClawOE main outreach, "personal" = personal instance): campaigns, replies, mailboxes
- MasterInbox: unified reply inbox across all clients, labels, workspaces
- Inboxing: domain and mailbox provisioning

Be concise. When asked to do something, use your tools and report back clearly. If a task requires multiple steps, do them all.`;

  if (skills.length > 0) {
    prompt += `\n\n## Team Knowledge\n` + skills.map(s => `- **${s.name}**: ${s.description}`).join("\n");
  }
  return prompt;
}

// ── Claude with tool use loop ─────────────────────────────────────────────────

async function runClaude(messages, systemPrompt, env) {
  const MAX_ITERATIONS = 15;
  let i = 0;

  while (i < MAX_ITERATIONS) {
    i++;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: systemPrompt,
        tools: TOOLS,
        messages
      })
    });

    const data = await res.json();

    if (data.stop_reason === "end_turn") {
      return data.content.find(b => b.type === "text")?.text ?? "Done.";
    }

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, block.input, env);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const stopReason = data?.stop_reason ?? "unknown";
    const errorDetail = data?.error ? JSON.stringify(data.error) : "no error detail";
    return `Stopped unexpectedly (reason: ${stopReason}, detail: ${errorDetail})`;
  }

  return "Hit the max iteration limit — the task may be too complex to complete in one shot.";
}

// ── Slack utilities ───────────────────────────────────────────────────────────

async function verifySlackSignature(request, body) {
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`));
  const computed = "v0=" + Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computed === signature;
}

async function getThreadHistory(channel, thread_ts) {
  const res = await fetch(`https://slack.com/api/conversations.replies?channel=${channel}&ts=${thread_ts}`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
  });
  const data = await res.json();
  return data.messages || [];
}

async function postToSlack(channel, text, thread_ts) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel, text, thread_ts })
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Bind env to module-level vars so helper functions can access them
    SLACK_BOT_TOKEN = env.SLACK_BOT_TOKEN;
    SLACK_SIGNING_SECRET = env.SLACK_SIGNING_SECRET;
    ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    INBOXING_API_KEY = env.INBOXING_API_KEY;
    EMAILBISON_SEND_API_KEY = env.EMAILBISON_SEND_API_KEY;
    EMAILBISON_PERSONAL_API_KEY = env.EMAILBISON_PERSONAL_API_KEY;
    MASTERINBOX_API_KEY = env.MASTERINBOX_API_KEY;

    const body = await request.text();

    const valid = await verifySlackSignature(request, body);
    if (!valid) return new Response("Unauthorized", { status: 401 });

    const payload = JSON.parse(body);

    if (payload.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    const event = payload.event;
    if (!event || event.bot_id || event.subtype) return new Response("OK");

    const isAppMention = event.type === "app_mention";
    const isThreadReply = event.type === "message" && event.thread_ts && event.thread_ts !== event.ts;
    if (!isAppMention && !isThreadReply) return new Response("OK");

    const { channel, ts, thread_ts, user } = event;
    const replyThread = thread_ts || ts;

    ctx.waitUntil((async () => {
      const history = await getThreadHistory(channel, replyThread);
      if (isThreadReply && !history.some(m => m.bot_id)) return;

      const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

      // learn: [name] | [description]
      const learnMatch = rawText.match(/^learn:\s*(.+?)\s*\|\s*(.+)$/is);
      if (learnMatch) {
        await saveSkill(env.SKILLS, learnMatch[1].trim(), learnMatch[2].trim(), user);
        await postToSlack(channel, `Got it! I've learned: *${learnMatch[1].trim()}*`, replyThread);
        return;
      }

      // forget: [name]
      const forgetMatch = rawText.match(/^forget:\s*(.+)$/i);
      if (forgetMatch) {
        await forgetSkill(env.SKILLS, forgetMatch[1].trim());
        await postToSlack(channel, `Done. I've forgotten: *${forgetMatch[1].trim()}*`, replyThread);
        return;
      }

      // list skills
      if (/^(list skills|skills|what do you know\??)$/i.test(rawText)) {
        const skills = await getSkills(env.SKILLS);
        if (!skills.length) {
          await postToSlack(channel, "No learned skills yet. Teach me one with:\n`learn: [name] | [description]`", replyThread);
        } else {
          const list = skills.map(s => `• *${s.name}*: ${s.description}`).join("\n");
          await postToSlack(channel, `Here's what I know:\n${list}`, replyThread);
        }
        return;
      }

      // Build conversation for Claude
      const skills = await getSkills(env.SKILLS);
      const systemPrompt = buildSystemPrompt(skills);

      const messages = [];
      for (const msg of history) {
        if (!msg.text) continue;
        const role = msg.bot_id ? "assistant" : "user";
        const content = msg.text.replace(/<@[A-Z0-9]+>/g, "").trim();
        if (!content) continue;
        if (messages.length > 0 && messages[messages.length - 1].role === role) {
          messages[messages.length - 1].content += "\n" + content;
        } else {
          messages.push({ role, content });
        }
      }

      if (!messages.length || messages[messages.length - 1].role !== "user") return;

      await postToSlack(channel, "_Working on it..._", replyThread);

      try {
        const reply = await runClaude(messages, systemPrompt, env);
        await postToSlack(channel, reply, replyThread);
      } catch (e) {
        await postToSlack(channel, `Error: ${String(e)}`, replyThread);
      }
    })());

    return new Response("OK");
  }
};
