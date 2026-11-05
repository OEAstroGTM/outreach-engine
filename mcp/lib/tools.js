// ── tools.js ─────────────────────────────────────────────────────────────────
// Operation functions — the actual work behind every tool. Return plain data
// (throw on error). Consumed by both the raw MCP tools (index.js) and the
// delegating agents (agents.js), so business logic lives in exactly one place.
import {
  CLIENTS, MI_KEYS, INSTANTLY_KEYS, APOLLO_THROTTLE_MS,
  getClient, ebConfig, ebFetch, ebPaginate, ebSwitchWorkspace, ebSenderFetch, apolloFetch, miFetch,
  ebDefaultInstance, ebConfiguredInstances, miWorkspaceId, miListWorkspaces,
} from "./core.js";

// ── Clients ──────────────────────────────────────────────────────────────────
export function listClients() {
  return CLIENTS.map(c => {
    const dflt = ebDefaultInstance(c);
    const ebEnv = (dflt === "eb_personal" ? c.eb_personal_key_env : c.eb_send_key_env)
      || c.eb_send_key_env || c.eb_personal_key_env || null;
    return {
      name: c.name,
      sequencer: c.sequencer,
      default_instance: dflt,
      // A client can now be live on both instances; these are per-instance so a
      // send workspace id is never mistaken for a personal one.
      eb_instances: ebConfiguredInstances(c),
      eb_send_ws_id: c.eb_send_ws_id ?? (dflt === "eb_send" ? c.eb_ws_id ?? null : null),
      eb_personal_ws_id: c.eb_personal_ws_id ?? (dflt === "eb_personal" ? c.eb_ws_id ?? null : null),
      eb_ws_id: c.eb_ws_id ?? null,
      mi_ws_id: c.mi_ws_id ?? null,
      has_mi_key: !!MI_KEYS[c.name],
      // Whether the workspace-scoped EmailBison token named in clients.json is
      // actually present in .env. false means calls fall back to the
      // account-level key, which may not reach this client's workspace.
      has_eb_key: ebEnv ? !!process.env[ebEnv] : null,
      has_eb_send_key: c.eb_send_key_env ? !!process.env[c.eb_send_key_env] : null,
      has_eb_personal_key: c.eb_personal_key_env ? !!process.env[c.eb_personal_key_env] : null,
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
export async function listCampaigns({ client_name, page, all, max_pages, status, instance }) {
  const client = getClient(client_name);
  // A client can be live on Instantly AND EmailBison at once. The sequencer is
  // the default route; an explicit instance overrides it, so campaigns on either
  // side stay reachable without changing the client's default.
  if (client.sequencer === "instantly" && !instance) {
    const key = INSTANTLY_KEYS[client.instantly_ws];
    if (!key) throw new Error(`No Instantly API key configured for workspace "${client.instantly_ws}" (client: ${client_name})`);
    const res = await fetch(`https://api.instantly.ai/api/v2/campaigns`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    return res.json();
  }

  const r = await ebPaginate(client, "/campaigns", { page, all, maxPages: max_pages, instance });
  let data = r.rows;
  if (status) data = data.filter(c => c.status === status);

  // Preserve the raw response shape (data/links/meta) so existing callers keep
  // working; add provenance so a truncated list is visible rather than implied.
  return {
    ...r.raw,
    data,
    meta: {
      ...(r.raw?.meta ?? {}),
      instance: r.instance,
      workspace_id: r.ws_id,
      pages_fetched: r.pages_fetched,
      returned: data.length,
      truncated: r.truncated,
    },
  };
}

export async function getCampaignStats({ client_name, campaign_id, instance, start_date, end_date }) {
  // EmailBison's stats route only accepts POST (a GET 405s). Date filtering is
  // undocumented on our side, so we send every plausible key alias for a date
  // range — extras are typically ignored by Laravel-style validation unless a
  // route explicitly forbids unknown fields.
  const body = {};
  if (start_date || end_date) {
    Object.assign(body, {
      start_date, end_date,
      date_from: start_date, date_to: end_date,
      from: start_date, to: end_date,
      from_date: start_date, to_date: end_date,
    });
  }
  return ebFetch("POST", `/campaigns/${campaign_id}/stats`, getClient(client_name), body, instance);
}

// Mirrors the attach/remove-sender-emails routes — GET the current list of
// sender emails (mailboxes) attached to a campaign, so load can be measured
// against capacity (see list_inboxes) without guessing from attach calls.
export async function getCampaignSenders({ client_name, campaign_id, instance }) {
  return ebFetch("GET", `/campaigns/${campaign_id}/sender-emails`, getClient(client_name), undefined, instance);
}

export async function createCampaign({ client_name, name, subject, body, instance }) {
  return ebFetch("POST", "/campaigns", getClient(client_name), { name, subject, body }, instance);
}

export async function launchCampaign({ client_name, campaign_id, instance }) {
  return ebFetch("POST", `/campaigns/${campaign_id}/launch`, getClient(client_name), undefined, instance);
}

export async function pauseCampaign({ client_name, campaign_id, instance }) {
  return ebFetch("POST", `/campaigns/${campaign_id}/pause`, getClient(client_name), undefined, instance);
}

export async function bulkPushToCampaign({ client_name, campaign_id, contacts, instance }) {
  const client = getClient(client_name);
  const cfg = ebConfig(client, instance);
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
export async function listInboxes({ client_name, page, all, max_pages, status, instance }) {
  const client = getClient(client_name);
  const r = await ebPaginate(client, "/sender-emails", { page, all, maxPages: max_pages, instance });

  let inboxes = r.rows.map(shapeInbox);
  const fetched = inboxes.length;
  if (status) inboxes = inboxes.filter(i => i.status === status);

  return {
    client: client.name,
    instance: r.instance,
    workspace_id: r.ws_id,
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

// ── Leads ────────────────────────────────────────────────────────────────────
// The Leads tab. `/leads` is workspace-wide; `/campaigns/{id}/leads` scopes to
// one campaign. Both paginate 15/page and ignore per_page, so a workspace with
// 400k leads is ~30k pages — `all: true` is guarded by max_pages and walks with
// concurrency, but pulling everything is a deliberate act, not a default.
const shapeLead = l => ({
  id: l.id,
  uuid: l.uuid,
  first_name: l.first_name,
  last_name: l.last_name,
  email: l.email,
  title: l.title ?? null,
  company: l.company ?? null,
  status: l.status ?? null,
  tags: (l.tags ?? []).map(t => t.name),
  campaigns: (l.lead_campaign_data ?? []).map(c => ({
    campaign_id: c.campaign_id,
    status: c.status,
    emails_sent: c.emails_sent,
    replies: c.replies,
    opens: c.opens,
    interested: c.interested,
  })),
  stats: l.overall_stats ?? null,
  created_at: l.created_at,
});

export async function listLeads({
  client_name, campaign_id, search, status, campaign_status, interested,
  page, all, max_pages, concurrency, instance,
}) {
  const client = getClient(client_name);
  // Verified against the live API: `search` is the only server-side filter that
  // works on /leads. status, campaign_id and filters[...] as query params are
  // accepted and silently ignored — they return the unfiltered workspace — so
  // campaign scoping goes through the campaign route and the rest are applied
  // here, to the rows actually fetched.
  let path = campaign_id ? `/campaigns/${campaign_id}/leads` : "/leads";
  if (search) path += `?search=${encodeURIComponent(search)}`;

  const r = await ebPaginate(client, path, {
    page, all, maxPages: max_pages, instance,
    concurrency: concurrency ?? 5,
  });

  let leads = r.rows.map(shapeLead);
  const fetched = leads.length;
  if (status) leads = leads.filter(l => l.status === status);
  if (campaign_status) leads = leads.filter(l => l.campaigns.some(c => c.status === campaign_status));
  if (interested != null) leads = leads.filter(l => l.campaigns.some(c => c.interested === interested));

  const clientSide = { status, campaign_status, interested };
  const applied = Object.fromEntries(Object.entries(clientSide).filter(([, v]) => v != null));

  return {
    client: client.name,
    instance: r.instance,
    workspace_id: r.ws_id,
    scope: campaign_id ? `campaign ${campaign_id}` : "workspace",
    total_in_scope: r.total,
    last_page: r.last_page,
    pages_fetched: r.pages_fetched,
    fetched,
    returned: leads.length,
    truncated: r.truncated,
    ...(r.truncated && { note: `Stopped at max_pages — ${fetched} of ${r.total}. Raise max_pages for more.` }),
    ...(search && { server_side_search: search }),
    // Named so a partial filter is never mistaken for a complete one: these ran
    // over `fetched` rows, not over all `total_in_scope`.
    ...(Object.keys(applied).length && { filtered_client_side: applied }),
    leads,
  };
}

export async function getLead({ client_name, lead_id, instance }) {
  return ebFetch("GET", `/leads/${lead_id}`, getClient(client_name), undefined, instance);
}

export async function attachInboxesToCampaign({ client_name, campaign_id, sender_email_ids, instance }) {
  if (!Array.isArray(sender_email_ids) || !sender_email_ids.length) {
    throw new Error("sender_email_ids must be a non-empty array of sender email IDs (see list_inboxes).");
  }
  const res = await ebFetch(
    "POST",
    `/campaigns/${campaign_id}/attach-sender-emails`,
    getClient(client_name),
    { sender_email_ids },
    instance
  );
  return { campaign_id, attached: sender_email_ids, response: res };
}

export async function removeInboxesFromCampaign({ client_name, campaign_id, sender_email_ids, instance }) {
  if (!Array.isArray(sender_email_ids) || !sender_email_ids.length) {
    throw new Error("sender_email_ids must be a non-empty array of sender email IDs.");
  }
  const res = await ebFetch(
    "DELETE",
    `/campaigns/${campaign_id}/remove-sender-emails`,
    getClient(client_name),
    { sender_email_ids },
    instance
  );
  return { campaign_id, removed: sender_email_ids, response: res };
}

// ── Warmup scores (EmailBison) ───────────────────────────────────────────────
// Warmup scores do NOT come from /sender-emails — that route exposes only
// warmup_enabled. They live on /warmup/sender-emails, which also carries the
// domain, and it honours start_date/end_date. The window matters: the same
// mailbox can read 88.89 all-time and 80.33 over the last 30 days, so an
// undated call quietly flatters the numbers.
//
// 2,000+ mailboxes is 130+ pages, so this aggregates per domain and returns a
// summary rather than every row.
export async function warmupScores({
  client_name, instance, start_date, end_date, days, below, max_pages, include_domains,
}) {
  const client = getClient(client_name);
  const threshold = below ?? 80;
  const span = days ?? 30;
  const end = end_date ?? new Date().toISOString().slice(0, 10);
  const start = start_date ?? (() => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (span - 1));
    return d.toISOString().slice(0, 10);
  })();

  const r = await ebPaginate(client, `/warmup/sender-emails?start_date=${start}&end_date=${end}`,
    { all: true, maxPages: max_pages ?? 250, instance, concurrency: 6 });

  const byDomain = new Map();
  let below_count = 0, disabled = 0;
  for (const row of r.rows) {
    const score = row.warmup_score;
    if (score == null) continue;
    if (score < threshold) below_count++;
    if (!row.warmup_enabled) disabled++;
    const d = byDomain.get(row.domain) ?? { domain: row.domain, mailboxes: 0, sum: 0, min: Infinity, max: -Infinity, below: 0 };
    d.mailboxes++; d.sum += score; d.below += score < threshold ? 1 : 0;
    d.min = Math.min(d.min, score); d.max = Math.max(d.max, score);
    byDomain.set(row.domain, d);
  }

  const domains = [...byDomain.values()]
    .map(d => ({
      domain: d.domain, mailboxes: d.mailboxes,
      avg_score: Math.round((d.sum / d.mailboxes) * 100) / 100,
      min_score: d.min, max_score: d.max, mailboxes_below: d.below,
    }))
    .sort((a, b) => a.avg_score - b.avg_score);

  return {
    client: client.name,
    instance: r.instance,
    workspace_id: r.ws_id,
    window: { start_date: start, end_date: end, days: span },
    threshold,
    mailboxes: r.rows.length,
    domains: domains.length,
    mailboxes_below_threshold: below_count,
    // "a domain under 80" is ambiguous, so report each reading rather than pick one.
    domains_avg_below: domains.filter(d => d.avg_score < threshold).length,
    domains_all_below: domains.filter(d => d.mailboxes_below === d.mailboxes).length,
    domains_any_below: domains.filter(d => d.mailboxes_below > 0).length,
    warmup_disabled_mailboxes: disabled,
    pages_fetched: r.pages_fetched,
    truncated: r.truncated,
    ...(r.truncated && { note: `Stopped at max_pages — ${r.rows.length} mailboxes counted. Raise max_pages for the full set.` }),
    ...(include_domains === false ? {} : { domains_detail: domains }),
  };
}

// ── Sender emails, account-level by ID (EmailBison) ──────────────────────────
// client_name is optional but strongly preferred: with it these use the
// client's workspace-scoped token, without it the account master key. The
// master key is refused (401) by /sender-emails on the personal instance, so
// personal-instance calls only work when the client is named.
const senderClient = (client_name) => (client_name ? getClient(client_name) : undefined);

export async function getSenderEmail({ instance, sender_email_id, client_name }) {
  return ebSenderFetch("GET", sender_email_id, instance, undefined, senderClient(client_name));
}

export async function updateSenderEmail({ instance, sender_email_id, name, daily_limit, email_signature, client_name }) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (daily_limit !== undefined) body.daily_limit = daily_limit;
  if (email_signature !== undefined) body.email_signature = email_signature;
  return ebSenderFetch("PATCH", sender_email_id, instance, body, senderClient(client_name));
}

export async function deleteSenderEmail({ instance, sender_email_id, client_name }) {
  return ebSenderFetch("DELETE", sender_email_id, instance, undefined, senderClient(client_name));
}

// ── Inbox (MasterInbox) ──────────────────────────────────────────────────────
// Routes are get-prospects / get-messages / add-prospect-label / get-labels.
// Workspace selection is by workspace_id in the body — the key does not carry it.

export async function listLabels({ client_name }) {
  const data = await miFetch("GET", "/get-labels", getClient(client_name));
  return data?.data ?? data;
}

// Labels are addressed by numeric label_id. Accept a human label name too and
// resolve it, so callers are not forced to look ids up first.
async function resolveLabelId(client, label, label_id) {
  if (label_id != null) return label_id;
  if (!label) return undefined;
  const data = await miFetch("GET", "/get-labels", client);
  const labels = data?.data ?? [];
  const hit = labels.find(l => String(l.label_name).toLowerCase() === String(label).toLowerCase());
  if (!hit) {
    throw new Error(
      `No MasterInbox label named "${label}" for ${client.name}. ` +
      `Available: ${labels.map(l => l.label_name).join(", ") || "(none)"}`
    );
  }
  return hit.label_id;
}

export async function listReplies({ client_name, limit, page, label, label_id }) {
  const client = getClient(client_name);
  const resolved = await resolveLabelId(client, label, label_id);
  return miFetch("POST", "/get-prospects", client, {
    workspace_id: miWorkspaceId(client),
    label_id: resolved,
    page: page ?? 1,
    limit: limit ?? 20,
  });
}

// A thread is looked up by prospect, not by an opaque thread id.
export async function getThread({ client_name, prospect_id, prospect_email }) {
  if (!prospect_id && !prospect_email) {
    throw new Error("getThread needs prospect_id or prospect_email (see list_replies).");
  }
  return miFetch("POST", "/get-messages", getClient(client_name), { prospect_id, prospect_email });
}

export async function tagReply({ client_name, prospect_id, label, label_id }) {
  const client = getClient(client_name);
  const resolved = await resolveLabelId(client, label, label_id);
  if (resolved == null) throw new Error("tagReply needs label or label_id (see list_labels).");
  return miFetch("POST", "/add-prospect-label", client, { prospect_id, label_id: resolved });
}

export async function listMiWorkspaces() {
  return miListWorkspaces();
}

// ── Mailbox connect links (MasterInbox) ──────────────────────────────────────
// There is no credential-based mailbox upload. GET /add-account/{type} accepts
// only "google" or "outlook" (imap and smtp both 400 with
// 'type must be "google" or "outlook"') and returns an OAuth URL a PERSON
// completes. A CSV of mailbox passwords has nowhere to go: the API never takes
// a password, so bulk "upload" means bulk consent, one human click per mailbox.
//
// This mints one fresh URL per mailbox and tags it with login_hint so Google
// preselects that account — turning a 10-click wizard into one click each.
// Each URL carries a single-use state (workspace__timestamp__nonce), so they
// go stale: generate them when you are ready to click, not hours ahead.
export async function mailboxConnectUrls({ client_name, emails, provider = "google" }) {
  if (!["google", "outlook"].includes(provider)) {
    throw new Error(`provider must be "google" or "outlook" (got "${provider}")`);
  }
  if (!Array.isArray(emails) || !emails.length) throw new Error("emails must be a non-empty array");

  const client = getClient(client_name);
  const workspace_id = miWorkspaceId(client);
  const results = [];

  for (const email of emails) {
    try {
      const r = await miFetch("GET", `/add-account/${provider}?workspace_id=${workspace_id}`, client);
      const url = r?.oauthUrl ?? r?.data?.oauthUrl;
      if (!url) throw new Error(`no oauthUrl in response: ${JSON.stringify(r).slice(0, 120)}`);
      const u = new URL(url);
      u.searchParams.set("login_hint", email);   // preselect the account on Google's screen
      results.push({ email, connect_url: u.toString() });
    } catch (e) {
      results.push({ email, error: String(e).slice(0, 180) });
    }
    await new Promise(r => setTimeout(r, 200));
  }

  return {
    client: client.name,
    workspace_id,
    provider,
    requested: emails.length,
    generated: results.filter(r => r.connect_url).length,
    failed: results.filter(r => r.error).length,
    note: "Each URL needs a human to complete Google/Microsoft consent. URLs are single-use and short-lived.",
    results,
  };
}

export async function getInterestedReplies({ client_name } = {}) {
  const targets = client_name
    ? [getClient(client_name)]
    // Skip churned clients — sweeping every workspace for a client that is gone
    // is wasted calls and noise in the result.
    // A per-client MI key is no longer required — miFetch falls back to the
    // account-level master key, which reaches every workspace. Filtering on
    // MI_KEYS here would silently skip any client set up without its own key.
    : CLIENTS.filter(c => c.mi_ws_id && c.status !== "churned");
  const results = [];
  for (const client of targets) {
    try {
      const c = { ...client, mi_pk: MI_KEYS[client.name] };
      const label_id = await resolveLabelId(c, "Interested");
      const data = await miFetch("POST", "/get-prospects", c, {
        workspace_id: miWorkspaceId(c), label_id, page: 1, limit: 50,
      });
      const threads = data?.data ?? [];
      if (threads.length) results.push({ client: client.name, count: threads.length, threads });
    } catch (e) {
      results.push({ client: client.name, error: e.message });
    }
  }
  return results;
}

// ── Sequence steps ───────────────────────────────────────────────────────────
// Read a campaign's sequence steps (subjects, bodies, wait days, variants).
export async function getSequenceSteps({ client_name, campaign_id, instance }) {
  return ebFetch("GET", `/campaigns/${campaign_id}/sequence-steps`, getClient(client_name), undefined, instance);
}

// Copy the sequence from one campaign to another — across instances if needed.
// Copies steps only: no leads, no inboxes, no status change. Refuses to write
// into a destination that already has steps unless allow_existing is true.
export async function copyCampaignSequence({
  client_name, source_campaign_id, source_instance,
  dest_campaign_id, dest_instance, allow_existing = false, dry_run = false,
}) {
  const client = getClient(client_name);
  const src = await ebFetch("GET", `/campaigns/${source_campaign_id}/sequence-steps`, client, undefined, source_instance);
  const srcSteps = src?.data ?? [];
  if (!Array.isArray(srcSteps) || !srcSteps.length) {
    throw new Error(`Source campaign ${source_campaign_id} (${source_instance}) returned no sequence steps: ${JSON.stringify(src).slice(0, 300)}`);
  }

  const dst = await ebFetch("GET", `/campaigns/${dest_campaign_id}/sequence-steps`, client, undefined, dest_instance);
  const dstSteps = Array.isArray(dst?.data) ? dst.data : [];
  if (dstSteps.length && !allow_existing) {
    throw new Error(`Destination campaign ${dest_campaign_id} (${dest_instance}) already has ${dstSteps.length} step(s). Pass allow_existing=true to append anyway.`);
  }

  // Map source step ids → order so variant_from_step can be re-pointed.
  // Main steps by order first, variants (order null) after their parents.
  const sorted = [...srcSteps].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
  const orderById = Object.fromEntries(sorted.map(s => [s.id, s.order]));
  const sequence_steps = sorted.map(s => {
    const step = {
      // EmailBison prepends "Re: " to thread replies on write, so strip it to avoid "Re: Re:".
      email_subject: s.thread_reply ? (s.email_subject ?? "").replace(/^(re:\s*)+/i, "") : (s.email_subject ?? ""),
      email_body:    s.email_body ?? "",
      wait_in_days:  s.wait_in_days ?? 1,
      order:         s.order,
      variant:       !!s.variant,
      thread_reply:  !!s.thread_reply,
    };
    if (s.variant && s.variant_from_step != null) {
      step.variant_from_step = orderById[s.variant_from_step] ?? s.variant_from_step;
    }
    return step;
  });

  const payload = { title: `Sequence copied from campaign ${source_campaign_id}`, sequence_steps };
  if (dry_run) return { dry_run: true, steps: sequence_steps.length, payload };

  const res = await ebFetch("POST", `/campaigns/${dest_campaign_id}/sequence-steps`, client, payload, dest_instance);
  const after = await ebFetch("GET", `/campaigns/${dest_campaign_id}/sequence-steps`, client, undefined, dest_instance);
  return {
    source: { campaign_id: source_campaign_id, instance: source_instance, steps: srcSteps.length },
    dest:   { campaign_id: dest_campaign_id, instance: dest_instance, steps_after: Array.isArray(after?.data) ? after.data.length : null },
    response: res,
  };
}

// Create a new campaign and write a sequence into it in one go. Steps only —
// no leads, no inboxes; the campaign stays in draft. Each step:
// { email_subject, email_body, wait_in_days, order, variant?, variant_from_step?, thread_reply? }
// For variants, set variant=true and variant_from_step to the parent step's order.
export async function createCampaignWithSequence({ client_name, name, instance, sequence_steps, dry_run = false }) {
  if (!Array.isArray(sequence_steps) || !sequence_steps.length) throw new Error("sequence_steps must be a non-empty array.");
  const steps = sequence_steps.map(s => ({
    ...s,
    // EmailBison prepends "Re: " to thread replies on write, so strip it to avoid "Re: Re:".
    email_subject: s.thread_reply ? String(s.email_subject ?? "").replace(/^(re:\s*)+/i, "") : String(s.email_subject ?? ""),
    variant: !!s.variant,
    thread_reply: !!s.thread_reply,
  })).sort((a, b) => (a.variant - b.variant) || ((a.order ?? Infinity) - (b.order ?? Infinity)));
  const payload = { title: `${name} sequence`, sequence_steps: steps };
  if (dry_run) return { dry_run: true, name, steps: steps.length, payload };

  const client = getClient(client_name);
  const created = await ebFetch("POST", "/campaigns", client, { name }, instance);
  const campaign_id = created?.data?.id;
  if (!campaign_id) throw new Error(`Campaign create failed: ${JSON.stringify(created).slice(0, 300)}`);
  const res = await ebFetch("POST", `/campaigns/${campaign_id}/sequence-steps`, client, payload, instance);
  const after = await ebFetch("GET", `/campaigns/${campaign_id}/sequence-steps`, client, undefined, instance);
  return {
    campaign_id, name, status: created?.data?.status ?? null,
    steps_sent: steps.length,
    steps_after: Array.isArray(after?.data) ? after.data.length : null,
    sequence_error: res?.data ? null : res,
  };
}

// ── Bounce messages (EmailBison Bounced folder, read-only) ───────────────────
// Short summary per domain and per reason, so a bounce check costs one call.
export async function bounceMessages({ client_name, domains, days = 7, max_pages = 30, instance }) {
  const client = getClient(client_name);
  const r = await ebPaginate(client, "/replies?folder=bounced", { all: true, maxPages: max_pages, instance, concurrency: 4 });
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const want = domains?.length ? new Set(domains.map(d => d.toLowerCase())) : null;
  const clean = t => String(t ?? "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#39;|&quot;|&amp;/g, " ").replace(/\s+/g, " ").trim();
  const byDomain = {}, byReason = {};
  let seen = 0, matched = 0;
  for (const m of r.rows) {
    seen++;
    const date = String(m?.date_received ?? m?.created_at ?? "").slice(0, 10);
    if (date && date < since) continue;
    const mailbox = String(m?.primary_to_email_address ?? m?.to_email_address ?? m?.sender_email?.email ?? "").toLowerCase();
    const dom = mailbox.split("@")[1] ?? "";
    if (want && !want.has(dom)) continue;
    matched++;
    const body = clean([m?.text_body, m?.html_body].filter(Boolean).join(" "));
    const i = body.search(/the response (from the remote server )?was:?|remote server (returned|was)|diagnostic-code:/i);
    const reason = (i >= 0 ? body.slice(i, i + 200) : body.slice(0, 200)).replace(/^the response (from the remote server )?was:?\s*/i, "");
    const code = (reason.match(/\b[45]\d{2}[ -]+#?[45]\.\d{1,2}\.\d{1,3}\b/) ?? reason.match(/\b[45]\.\d{1,2}\.\d{1,3}\b/) ?? [null])[0];
    const key = code ?? reason.slice(0, 60);
    (byDomain[dom] ??= { bounces: 0, reasons: {} }).bounces++;
    byDomain[dom].reasons[key] = (byDomain[dom].reasons[key] ?? 0) + 1;
    const b = (byReason[key] ??= { count: 0, samples: [] }); b.count++; if (b.samples.length < 2) b.samples.push({ date, mailbox, text: reason.slice(0, 180) });
  }
  return { client: client.name, since, pages_read: r.pages_fetched, truncated: r.truncated, replies_seen: seen, bounces_matched: matched,
    by_domain: byDomain, by_reason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1].count - a[1].count).slice(0, 12)) };
}

// ── Bounce rate per sender domain (EmailBison mailbox counts, read-only) ─────
// Lifetime emails_sent_count / bounced_count per mailbox, added up per domain. Google vs Outlook from the mailbox `type`
// (a domain with 10+ mailboxes counts as Outlook, like the dashboard). Returns only what is asked, so it stays small.
export async function domainBounceRates({ client_names, provider = "google", min_rate = 5, min_sent = 100, instance }) {
  const out = [];
  for (const name of client_names) {
    const client = getClient(name);
    const ci = ebConfiguredInstances(client); const insts = instance ? [instance] : (ci?.length ? ci : [undefined]);
    const per = new Map();
    for (const inst of insts) {
      let r;
      try { r = await ebPaginate(client, "/sender-emails?per_page=500", { all: true, maxPages: 50, instance: inst, concurrency: 4 }); }
      catch (e) { out.push({ client: name, instance: inst ?? null, error: String(e).slice(0, 160) }); continue; }
      for (const m of r.rows) {
        if (!m?.email) continue;
        const d = String(m.email).toLowerCase().split("@")[1] ?? "";
        const x = per.get(d) ?? { domain: d, mailboxes: 0, sent: 0, bounced: 0, google: 0 };
        x.mailboxes++; x.sent += Number(m.emails_sent_count) || 0; x.bounced += Number(m.bounced_count) || 0;
        if (/google|gmail/i.test(String(m.type ?? ""))) x.google++;
        per.set(d, x);
      }
    }
    const doms = [...per.values()].map(x => ({ ...x, provider: x.google >= x.mailboxes / 2 && x.mailboxes < 10 ? "google" : "outlook", rate: x.sent ? Math.round(x.bounced / x.sent * 1000) / 10 : 0 }))
      .filter(x => provider === "all" || x.provider === provider);
    const sent = doms.reduce((a, x) => a + x.sent, 0), bounced = doms.reduce((a, x) => a + x.bounced, 0);
    out.push({ client: client.name, domains: doms.length, mailboxes: doms.reduce((a, x) => a + x.mailboxes, 0), sent, bounced, rate: sent ? Math.round(bounced / sent * 1000) / 10 : 0,
      over: doms.filter(x => x.sent >= min_sent && x.rate > min_rate).sort((a, b) => b.rate - a.rate).map(x => `${x.domain} ${x.rate}% (${x.bounced}/${x.sent})`) });
  }
  return { provider, min_rate, note: "Lifetime counts per mailbox from EmailBison.", clients: out.sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0)) };
}

// Replace a campaign's whole sequence: delete every existing step (variants
// first), then write the new steps. Leads, inboxes and settings are untouched.
// Stops before writing if any delete fails. dry_run shows what would change.
export async function replaceCampaignSequence({ client_name, campaign_id, instance, sequence_steps, dry_run = false }) {
  if (!Array.isArray(sequence_steps) || !sequence_steps.length) throw new Error("sequence_steps must be a non-empty array.");
  const client = getClient(client_name);
  const cfg = ebConfig(client, instance);
  await ebSwitchWorkspace(cfg, client);
  const call = async (method, path, body) => {
    const res = await fetch(`${cfg.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, ok: res.ok, json, text: json ? undefined : text.slice(0, 300) };
  };
  const existing = (await call("GET", `/campaigns/${campaign_id}/sequence-steps`)).json?.data ?? [];
  const steps = sequence_steps.map(s => ({
    ...s,
    email_subject: s.thread_reply ? String(s.email_subject ?? "").replace(/^(re:\s*)+/i, "") : String(s.email_subject ?? ""),
    variant: !!s.variant,
    thread_reply: !!s.thread_reply,
  })).sort((a, b) => (a.variant - b.variant) || ((a.order ?? Infinity) - (b.order ?? Infinity)));
  if (dry_run) return { dry_run: true, campaign_id, existing_steps: existing.map(s => ({ id: s.id, order: s.order, variant: s.variant, subject: s.email_subject })), new_steps: steps.length };

  // EmailBison refuses to delete a campaign's last step, so write the new steps
  // first, then remove the old ones (variants before their parents).
  const post = await call("POST", `/campaigns/${campaign_id}/sequence-steps`, { title: `Campaign ${campaign_id} sequence`, sequence_steps: steps });
  if (!post.ok) {
    throw new Error(`Writing new steps failed (HTTP ${post.status}): ${JSON.stringify(post.json ?? post.text).slice(0, 300)}. Nothing was deleted.`);
  }
  const toDelete = [...existing].sort((a, b) => (b.variant - a.variant));
  const deleted = [], failed = [];
  for (const s of toDelete) {
    const r = await call("DELETE", `/campaigns/sequence-steps/${s.id}`);
    if (r.ok) deleted.push(s.id); else failed.push({ id: s.id, status: r.status, error: r.json ?? r.text });
  }
  const after = (await call("GET", `/campaigns/${campaign_id}/sequence-steps`)).json?.data ?? [];
  return { campaign_id, deleted, failed_deletes: failed, write_status: post.status, steps_after: after.length };
}
