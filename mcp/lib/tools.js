// ── tools.js ─────────────────────────────────────────────────────────────────
// Operation functions — the actual work behind every tool. Return plain data
// (throw on error). Consumed by both the raw MCP tools (index.js) and the
// delegating agents (agents.js), so business logic lives in exactly one place.
import {
  CLIENTS, MI_KEYS, INSTANTLY_KEYS, APOLLO_THROTTLE_MS,
  getClient, ebConfig, ebFetch, ebPaginate, ebSwitchWorkspace, ebSenderFetch, apolloFetch, miFetch,
} from "./core.js";

// ── Clients ──────────────────────────────────────────────────────────────────
export function listClients() {
  return CLIENTS.map(c => {
    const ebEnv = c.eb_send_key_env || c.eb_personal_key_env || null;
    return {
      name: c.name,
      sequencer: c.sequencer,
      eb_ws_id: c.eb_ws_id ?? null,
      mi_ws_id: c.mi_ws_id ?? null,
      has_mi_key: !!MI_KEYS[c.name],
      // Whether the workspace-scoped EmailBison token named in clients.json is
      // actually present in .env. false means calls fall back to the
      // account-level key, which may not reach this client's workspace.
      has_eb_key: ebEnv ? !!process.env[ebEnv] : null,
      inboxing_tags: c.inboxing_tags,
    };
  });
}

export function getClientInfo({ client_name }) {
  return getClient(client_name);
}

// ── Research (Apollo) ────────────────────────────────────────────────────────
export async function findCompany({ company_name, domain }) {
  const body = { q_organization_name: company_name, per_page: 1 };
  if (domain) body.q_organization_domains = [domain];
  const data = await apolloFetch("/mixed_companies/search", body);
  const orgs = data?.organizations ?? data?.accounts ?? [];
  if (!orgs.length) return { note: "No company found", query: { company_name, domain } };
  return orgs[0];
}

export async function enrichContact({ first_name, last_name, company, domain, linkedin_url, reveal_personal_emails }) {
  const body = {
    first_name, last_name,
    organization_name: company,
    reveal_personal_emails: reveal_personal_emails ?? false,
  };
  if (domain) body.domain = domain;
  if (linkedin_url) body.linkedin_url = linkedin_url;
  const data = await apolloFetch("/people/match", body);
  const person = data?.person ?? data;
  if (!person) return { note: "No match found", query: { first_name, last_name, company } };
  return person;
}

function buildPeopleQuery(f) {
  const body = {};
  if (f.titles?.length)                body.person_titles                     = f.titles;
  if (f.seniority_levels?.length)      body.person_seniorities                = f.seniority_levels;
  if (f.departments?.length)           body.person_departments                = f.departments;
  if (f.keywords)                      body.q_keywords                        = f.keywords;
  if (f.industries?.length)            body.organization_industry_tag_ids     = f.industries;
  if (f.employee_count_ranges?.length) body.organization_num_employees_ranges = f.employee_count_ranges;
  if (f.locations?.length)             body.person_locations                  = f.locations;
  if (f.company_names?.length)         body.q_organization_name               = f.company_names.join(" OR ");
  return body;
}

export async function searchPeople(f) {
  const body = { ...buildPeopleQuery(f), page: f.page ?? 1, per_page: Math.min(f.per_page ?? 25, 100) };
  const data = await apolloFetch("/mixed_people/search", body);
  let people = data?.people ?? [];
  if (f.has_email) people = people.filter(p => p.email);
  return {
    total_found:  data?.pagination?.total_entries ?? people.length,
    total_pages:  data?.pagination?.total_pages ?? 1,
    current_page: f.page ?? 1,
    returned:     people.length,
    contacts:     people,
  };
}

export async function bulkPullContacts(f) {
  const cap       = Math.min(f.max_results ?? 100, 500);
  const perPage   = 100;
  const emailOnly = f.has_email_only !== false; // default true
  let collected   = [];
  let page        = f.start_page ?? 1;
  let totalFound  = null;
  let totalPages  = null;

  while (collected.length < cap) {
    const body = { ...buildPeopleQuery(f), page, per_page: perPage };
    const data = await apolloFetch("/mixed_people/search", body);
    const people = data?.people ?? [];
    if (totalFound === null) totalFound = data?.pagination?.total_entries ?? 0;
    if (totalPages === null) totalPages = data?.pagination?.total_pages ?? 1;
    collected.push(...(emailOnly ? people.filter(p => p.email) : people));
    if (people.length < perPage || page >= totalPages) break;
    page++;
    await new Promise(r => setTimeout(r, APOLLO_THROTTLE_MS));
  }

  collected = collected.slice(0, cap);
  const withEmail = collected.filter(p => p.email).length;
  return {
    summary: {
      total_in_apollo: totalFound,
      pulled: collected.length,
      with_email: withEmail,
      without_email: collected.length - withEmail,
      pages_fetched: page - (f.start_page ?? 1) + 1,
      capped_at: cap,
    },
    contacts: collected.map(p => ({
      id: p.id,
      name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
      first_name: p.first_name,
      last_name: p.last_name,
      title: p.title,
      email: p.email,
      linkedin_url: p.linkedin_url,
      company: p.organization?.name ?? p.organization_name,
      domain: p.organization?.website_url ?? p.organization_domain,
      location: p.city ? `${p.city}, ${p.state ?? ""}`.trim().replace(/,$/, "") : null,
      seniority: p.seniority,
      phone: p.sanitized_phone,
    })),
  };
}

// ── Campaigns (EmailBison / Instantly) ───────────────────────────────────────
// EmailBison paginates index routes at 15 per page. Without `all: true` you get
// page 1 only — which silently looks like "this client has 15 campaigns".
export async function listCampaigns({ client_name, page, all, max_pages, status }) {
  const client = getClient(client_name);
  if (client.sequencer === "instantly") {
    const key = INSTANTLY_KEYS[client.instantly_ws];
    if (!key) throw new Error(`No Instantly API key configured for workspace "${client.instantly_ws}" (client: ${client_name})`);
    const res = await fetch(`https://api.instantly.ai/api/v1/campaign/list?api_key=${key}`);
    return res.json();
  }

  const r = await ebPaginate(client, "/campaigns", { page, all, maxPages: max_pages });
  let data = r.rows;
  if (status) data = data.filter(c => c.status === status);

  // Preserve the raw response shape (data/links/meta) so existing callers keep
  // working; add provenance so a truncated list is visible rather than implied.
  return {
    ...r.raw,
    data,
    meta: {
      ...(r.raw?.meta ?? {}),
      pages_fetched: r.pages_fetched,
      returned: data.length,
      truncated: r.truncated,
    },
  };
}

export async function getCampaignStats({ client_name, campaign_id }) {
  return ebFetch("GET", `/campaigns/${campaign_id}/stats`, getClient(client_name));
}

export async function createCampaign({ client_name, name, subject, body }) {
  return ebFetch("POST", "/campaigns", getClient(client_name), { name, subject, body });
}

export async function launchCampaign({ client_name, campaign_id }) {
  return ebFetch("POST", `/campaigns/${campaign_id}/launch`, getClient(client_name));
}

export async function pauseCampaign({ client_name, campaign_id }) {
  return ebFetch("POST", `/campaigns/${campaign_id}/pause`, getClient(client_name));
}

export async function bulkPushToCampaign({ client_name, campaign_id, contacts }) {
  const client = getClient(client_name);
  const cfg = ebConfig(client);
  const { base, key } = cfg;
  // Shared, verified switch — throws rather than writing leads into whatever
  // workspace the token was last pointed at.
  await ebSwitchWorkspace(cfg, client);
  const created = [];
  const failed  = [];
  for (const contact of contacts) {
    if (!contact.email) { failed.push({ contact, reason: "missing email" }); continue; }
    try {
      const res = await fetch(`${base}/leads`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: contact.email, first_name: contact.first_name, last_name: contact.last_name,
          company: contact.company, title: contact.title, website: contact.website,
        }),
      });
      const data = await res.json();
      const id = data?.data?.id ?? data?.id;
      if (id) created.push(id);
      else failed.push({ contact, reason: data?.message ?? "no ID returned", raw: data });
    } catch (e) { failed.push({ contact, reason: e.message }); }
  }
  let attachResult = null;
  if (created.length) {
    const attachRes = await fetch(`${base}/campaigns/${campaign_id}/leads/attach-leads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ lead_ids: created }),
    });
    attachResult = await attachRes.json();
  }
  return {
    summary: {
      total_contacts: contacts.length,
      leads_created: created.length,
      leads_failed: failed.length,
      attached_to: campaign_id,
      attach_status: attachResult?.message ?? attachResult?.status ?? "ok",
    },
    created_lead_ids: created,
    failed,
  };
}

// ── Inboxes / sender emails per client (EmailBison) ──────────────────────────
// Inbox assignment lives at the workspace level, so these all route through
// ebFetch and therefore through the verified workspace switch.

const shapeInbox = s => ({
  id: s.id,
  email: s.email,
  name: s.name,
  status: s.status ?? s.connection_status ?? null,
  daily_limit: s.daily_limit ?? null,
  type: s.type ?? null,
});

// EmailBison paginates at 15 per page. `all: true` walks every page (one
// workspace switch for the whole walk), guarded by max_pages.
export async function listInboxes({ client_name, page, all, max_pages, status }) {
  const client = getClient(client_name);
  const r = await ebPaginate(client, "/sender-emails", { page, all, maxPages: max_pages });

  let inboxes = r.rows.map(shapeInbox);
  const fetched = inboxes.length;
  if (status) inboxes = inboxes.filter(i => i.status === status);

  return {
    client: client.name,
    workspace_id: client.eb_ws_id,
    total_in_workspace: r.total,
    last_page: r.last_page,
    pages_fetched: r.pages_fetched,
    fetched,
    returned: inboxes.length,
    truncated: r.truncated,
    ...(r.truncated && { note: `Stopped at max_pages — ${fetched} of ${r.total}. Raise max_pages for the full list.` }),
    ...(status && { filtered_by_status: status }),
    inboxes,
  };
}

export async function attachInboxesToCampaign({ client_name, campaign_id, sender_email_ids }) {
  if (!Array.isArray(sender_email_ids) || !sender_email_ids.length) {
    throw new Error("sender_email_ids must be a non-empty array of sender email IDs (see list_inboxes).");
  }
  const res = await ebFetch(
    "POST",
    `/campaigns/${campaign_id}/attach-sender-emails`,
    getClient(client_name),
    { sender_email_ids }
  );
  return { campaign_id, attached: sender_email_ids, response: res };
}

export async function removeInboxesFromCampaign({ client_name, campaign_id, sender_email_ids }) {
  if (!Array.isArray(sender_email_ids) || !sender_email_ids.length) {
    throw new Error("sender_email_ids must be a non-empty array of sender email IDs.");
  }
  const res = await ebFetch(
    "DELETE",
    `/campaigns/${campaign_id}/remove-sender-emails`,
    getClient(client_name),
    { sender_email_ids }
  );
  return { campaign_id, removed: sender_email_ids, response: res };
}

// ── Sender emails, account-level by ID (EmailBison) ──────────────────────────
export async function getSenderEmail({ instance, sender_email_id }) {
  return ebSenderFetch("GET", sender_email_id, instance);
}

export async function updateSenderEmail({ instance, sender_email_id, name, daily_limit, email_signature }) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (daily_limit !== undefined) body.daily_limit = daily_limit;
  if (email_signature !== undefined) body.email_signature = email_signature;
  return ebSenderFetch("PATCH", sender_email_id, instance, body);
}

export async function deleteSenderEmail({ instance, sender_email_id }) {
  return ebSenderFetch("DELETE", sender_email_id, instance);
}

// ── Inbox (MasterInbox) ──────────────────────────────────────────────────────
export async function listReplies({ client_name, limit, label }) {
  const body = { page: 1, limit: limit ?? 20 };
  if (label) body.label = label;
  return miFetch("POST", "/api/api-webhook/v1/api/get-threads", getClient(client_name), body);
}

export async function getThread({ client_name, thread_id }) {
  return miFetch("POST", "/api/api-webhook/v1/api/get-thread", getClient(client_name), { thread_id });
}

export async function tagReply({ client_name, thread_id, label }) {
  return miFetch("POST", "/api/api-webhook/v1/api/update-thread", getClient(client_name), { thread_id, label });
}

export async function getInterestedReplies({ client_name } = {}) {
  const targets = client_name ? [getClient(client_name)] : CLIENTS.filter(c => c.mi_ws_id && MI_KEYS[c.name]);
  const results = [];
  for (const client of targets) {
    try {
      const c = { ...client, mi_pk: MI_KEYS[client.name] };
      const data = await miFetch("POST", "/api/api-webhook/v1/api/get-threads", c, { page: 1, limit: 50, label: "interested" });
      const threads = data?.data ?? [];
      if (threads.length) results.push({ client: client.name, threads });
    } catch (e) {
      results.push({ client: client.name, error: e.message });
    }
  }
  return results;
}
