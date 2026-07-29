// ── tools.js ─────────────────────────────────────────────────────────────────
// Operation functions — the actual work behind every tool. Return plain data
// (throw on error). Consumed by both the raw MCP tools (index.js) and the
// delegating agents (agents.js), so business logic lives in exactly one place.
import {
  CLIENTS, MI_KEYS, INSTANTLY_KEYS, APOLLO_THROTTLE_MS,
  getClient, ebConfig, ebFetch, ebSenderFetch, apolloFetch, miFetch,
} from "./core.js";

// ── Clients ──────────────────────────────────────────────────────────────────
export function listClients() {
  return CLIENTS.map(c => ({
    name: c.name,
    sequencer: c.sequencer,
    eb_ws_id: c.eb_ws_id ?? null,
    mi_ws_id: c.mi_ws_id ?? null,
    has_mi_key: !!MI_KEYS[c.name],
    inboxing_tags: c.inboxing_tags,
  }));
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
export async function listCampaigns({ client_name }) {
  const client = getClient(client_name);
  if (client.sequencer === "instantly") {
    const key = INSTANTLY_KEYS[client.instantly_ws];
    if (!key) throw new Error(`No Instantly API key configured for workspace "${client.instantly_ws}" (client: ${client_name})`);
    const res = await fetch(`https://api.instantly.ai/api/v1/campaign/list?api_key=${key}`);
    return res.json();
  }
  return ebFetch("GET", "/campaigns", client);
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
  const { base, key, ws_id } = ebConfig(client);
  await fetch(`${base}/workspaces/v1.1/switch-workspace`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ team_id: ws_id }),
  });
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

// ── Sender emails (EmailBison) ───────────────────────────────────────────────
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
