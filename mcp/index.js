#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENTS = JSON.parse(readFileSync(join(__dirname, "../clients.json"), "utf8"));

const APOLLO_BASE = "https://api.apollo.io/api/v1";
const APOLLO_KEY  = process.env.APOLLO_API_KEY;

const EB_SEND_BASE     = "https://send.outreachenginedashboard.co/api";
const EB_PERSONAL_BASE = "https://personal.outreachenginedashboard.co/api";
const EB_SEND_KEY      = process.env.EMAILBISON_SEND_API_KEY;
const EB_PERSONAL_KEY  = process.env.EMAILBISON_PERSONAL_API_KEY;
const MI_BASE          = "https://api.masterinbox.com";

const MI_KEYS = {
  "AskTuring":              process.env.MI_KEY_ASKTURING,
  "Braintracks":            process.env.MI_KEY_BRAINTRACKS,
  "Bravura Technologies":   process.env.MI_KEY_BRAVURA_TECHNOLOGIES,
  "Chalktalk":              process.env.MI_KEY_CHALKTALK,
  "Coffee & Contracts":     process.env.MI_KEY_COFFEE_AND_CONTRACTS,
  "Dream It Reel":          process.env.MI_KEY_DREAM_IT_REEL,
  "Hubengage":              process.env.MI_KEY_HUBENGAGE,
  "Intellectible":          process.env.MI_KEY_INTELLECTIBLE,
  "Lend Home Improvements": process.env.MI_KEY_LEND_HOME_IMPROVEMENTS,
  "Nuvo Bath":              process.env.MI_KEY_NUVO_BATH,
  "OR Trax":                process.env.MI_KEY_OR_TRAX,
  "Outreach Engine":        process.env.MI_KEY_OUTREACH_ENGINE,
  "ParGo":                  process.env.MI_KEY_PARGO,
  "Savanti Travel":         process.env.MI_KEY_SAVANTI_TRAVEL,
  "Simplexity":             process.env.MI_KEY_SIMPLEXITY,
  "Supply Wisdom":          process.env.MI_KEY_SUPPLY_WISDOM,
  "True Dial":              process.env.MI_KEY_TRUE_DIAL,
  "Westlink":               process.env.MI_KEY_WESTLINK,
  "Carengen":               process.env.MI_KEY_CARENGEN,
  "Clinintell":             process.env.MI_KEY_CLININTELL,
};

const INSTANTLY_KEYS = {
  simplexity:     process.env.INSTANTLY_SIMPLEXITY_API_KEY,
  supply_wisdom:  process.env.INSTANTLY_SUPPLY_WISDOM_API_KEY,
  lend_home:      process.env.INSTANTLY_LEND_HOME_API_KEY,
  surety_now:     process.env.INSTANTLY_SURETY_NOW_API_KEY,
};

const APOLLO_THROTTLE_MS = 300;

// ── Helpers ───────────────────────────────────────────────────────────────────
function getClient(name) {
  const c = CLIENTS.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (!c) throw new Error(`Unknown client: "${name}". Available: ${CLIENTS.map(c=>c.name).join(", ")}`);
  return { ...c, mi_pk: MI_KEYS[c.name] };
}

function ebConfig(client) {
  const isPersonal = client.sequencer === "eb_personal";
  return {
    base: isPersonal ? EB_PERSONAL_BASE : EB_SEND_BASE,
    key:  isPersonal ? EB_PERSONAL_KEY  : EB_SEND_KEY,
    ws_id: client.eb_ws_id,
  };
}

async function ebFetch(method, path, client, body) {
  const { base, key, ws_id } = ebConfig(client);
  // Switch workspace first
  await fetch(`${base}/workspaces/v1.1/switch-workspace`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ team_id: ws_id }),
  });
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function apolloFetch(path, body) {
  if (!APOLLO_KEY) throw new Error("APOLLO_API_KEY is not set in the MCP env config");
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: "POST",
    headers: { "x-api-key": APOLLO_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apolloGet(path) {
  if (!APOLLO_KEY) throw new Error("APOLLO_API_KEY is not set in the MCP env config");
  const res = await fetch(`${APOLLO_BASE}${path}`, {
    method: "GET",
    headers: { "x-api-key": APOLLO_KEY, "Content-Type": "application/json" },
  });
  return res.json();
}

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

async function miFetch(method, path, client, body) {
  const key = client.mi_pk;
  if (!key) throw new Error(`No MI API key for ${client.name}`);
  const res = await fetch(`${MI_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "outreach-engine", version: "1.0.0" });

// ─── Client tools ─────────────────────────────────────────────────────────────
server.tool("list_clients",
  `List all ${CLIENTS.length} Outreach Engine clients with their sequencer platform, workspace IDs, and MasterInbox config.`,
  {},
  async () => ok(CLIENTS.map(c => ({
    name: c.name,
    sequencer: c.sequencer,
    eb_ws_id: c.eb_ws_id ?? null,
    mi_ws_id: c.mi_ws_id ?? null,
    has_mi_key: !!MI_KEYS[c.name],
    inboxing_tags: c.inboxing_tags,
  })))
);

server.tool("get_client",
  "Get full config for a specific client by name.",
  { client_name: z.string().describe("Client name, e.g. 'AskTuring'") },
  async ({ client_name }) => {
    const c = getClient(client_name);
    return ok(c);
  }
);

// ─── Campaign tools ───────────────────────────────────────────────────────────
server.tool("list_campaigns",
  "List all campaigns for a client. Routes automatically to the correct EmailBison or Instantly workspace.",
  { client_name: z.string() },
  async ({ client_name }) => {
    const client = getClient(client_name);
    if (client.sequencer === "instantly") {
      const key = INSTANTLY_KEYS[client.instantly_ws];
      if (!key) return err(new Error(`No Instantly API key configured for workspace "${client.instantly_ws}" (client: ${client_name})`));
      const res = await fetch(`https://api.instantly.ai/api/v1/campaign/list?api_key=${key}`);
      return ok(await res.json());
    }
    const data = await ebFetch("GET", "/campaigns", client);
    return ok(data);
  }
);

server.tool("get_campaign_stats",
  "Get open/reply/bounce stats for a campaign.",
  {
    client_name:  z.string(),
    campaign_id:  z.string(),
  },
  async ({ client_name, campaign_id }) => {
    const client = getClient(client_name);
    const data = await ebFetch("GET", `/campaigns/${campaign_id}/stats`, client);
    return ok(data);
  }
);

server.tool("create_campaign",
  "Create a new outreach campaign for a client.",
  {
    client_name: z.string(),
    name:        z.string().describe("Campaign name"),
    subject:     z.string().describe("Email subject line"),
    body:        z.string().describe("Email body (plain text or HTML)"),
  },
  async ({ client_name, name, subject, body }) => {
    const client = getClient(client_name);
    const data = await ebFetch("POST", "/campaigns", client, { name, subject, body });
    return ok(data);
  }
);

server.tool("launch_campaign",
  "Launch or resume a campaign so emails start sending.",
  { client_name: z.string(), campaign_id: z.string() },
  async ({ client_name, campaign_id }) => {
    const client = getClient(client_name);
    const data = await ebFetch("POST", `/campaigns/${campaign_id}/launch`, client);
    return ok(data);
  }
);

server.tool("pause_campaign",
  "Pause an active campaign.",
  { client_name: z.string(), campaign_id: z.string() },
  async ({ client_name, campaign_id }) => {
    const client = getClient(client_name);
    const data = await ebFetch("POST", `/campaigns/${campaign_id}/pause`, client);
    return ok(data);
  }
);

// ─── Inbox tools (MasterInbox, per-workspace key) ─────────────────────────────
server.tool("list_replies",
  "List recent email replies for a client from MasterInbox.",
  {
    client_name: z.string(),
    limit:       z.number().optional().default(20),
    label:       z.string().optional().describe("Filter by label, e.g. 'interested'"),
  },
  async ({ client_name, limit, label }) => {
    const client = getClient(client_name);
    const body = { page: 1, limit };
    if (label) body.label = label;
    const data = await miFetch("POST", "/api/api-webhook/v1/api/get-threads", client, body);
    return ok(data);
  }
);

server.tool("get_thread",
  "Get the full conversation thread for a specific reply in MasterInbox.",
  { client_name: z.string(), thread_id: z.string() },
  async ({ client_name, thread_id }) => {
    const client = getClient(client_name);
    const data = await miFetch("POST", "/api/api-webhook/v1/api/get-thread", client, { thread_id });
    return ok(data);
  }
);

server.tool("tag_reply",
  "Tag a reply thread in MasterInbox with a label.",
  {
    client_name: z.string(),
    thread_id:   z.string(),
    label:       z.string().describe("Label to apply, e.g. 'interested', 'not_interested', 'follow_up'"),
  },
  async ({ client_name, thread_id, label }) => {
    const client = getClient(client_name);
    const data = await miFetch("POST", "/api/api-webhook/v1/api/update-thread", client, { thread_id, label });
    return ok(data);
  }
);

server.tool("get_interested_replies",
  "Get all interested replies across all clients or for a specific client.",
  { client_name: z.string().optional().describe("Filter to one client, or omit for all") },
  async ({ client_name }) => {
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
    return ok(results);
  }
);

// ─── Sender email tools ───────────────────────────────────────────────────────
async function ebSenderFetch(method, sender_email_id, instance, body) {
  const base = instance === "personal" ? EB_PERSONAL_BASE : EB_SEND_BASE;
  const key  = instance === "personal" ? EB_PERSONAL_KEY  : EB_SEND_KEY;
  const res  = await fetch(`${base}/sender-emails/${sender_email_id}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

server.tool("emailbison_get_sender_email",
  "Retrieve details of a specific sender email account by its numeric ID.",
  {
    instance:        z.enum(["send", "personal"]).describe("Which EmailBison instance"),
    sender_email_id: z.number().describe("Numeric ID of the sender email account"),
  },
  async ({ instance, sender_email_id }) => {
    const result = await ebSenderFetch("GET", sender_email_id, instance);
    return ok(result);
  }
);

server.tool("emailbison_update_sender_email",
  "Update settings for a sender email account (name, daily_limit, email_signature).",
  {
    instance:        z.enum(["send", "personal"]).describe("Which EmailBison instance"),
    sender_email_id: z.number().describe("Numeric ID of the sender email account"),
    name:            z.string().optional().describe("Display name for the sender"),
    daily_limit:     z.number().optional().describe("Max emails per day"),
    email_signature: z.string().nullable().optional().describe("HTML email signature"),
  },
  async ({ instance, sender_email_id, name, daily_limit, email_signature }) => {
    const body = {};
    if (name            !== undefined) body.name            = name;
    if (daily_limit     !== undefined) body.daily_limit     = daily_limit;
    if (email_signature !== undefined) body.email_signature = email_signature;
    const result = await ebSenderFetch("PATCH", sender_email_id, instance, body);
    return ok(result);
  }
);

server.tool("emailbison_delete_sender_email",
  "Delete a sender email account from EmailBison by its numeric ID.",
  {
    instance:        z.enum(["send", "personal"]).describe("Which EmailBison instance"),
    sender_email_id: z.number().describe("Numeric ID of the sender email account to delete"),
  },
  async ({ instance, sender_email_id }) => {
    const result = await ebSenderFetch("DELETE", sender_email_id, instance);
    return ok(result);
  }
);

// ─── Apollo research tools ────────────────────────────────────────────────────
server.tool("find_company",
  "Search Apollo for a company by name or domain. Returns industry, headcount, location, tech stack, revenue estimates, and LinkedIn URL. Provide domain when available — it significantly improves accuracy.",
  {
    company_name: z.string().describe("Company name to search for"),
    domain:       z.string().optional().describe("Company domain, e.g. acme.com — improves match accuracy"),
  },
  async ({ company_name, domain }) => {
    try {
      const body = { q_organization_name: company_name, per_page: 1 };
      if (domain) body.q_organization_domains = [domain];
      const data = await apolloFetch("/mixed_companies/search", body);
      const orgs = data?.organizations ?? data?.accounts ?? [];
      if (!orgs.length) return ok({ note: "No company found", query: { company_name, domain } });
      return ok(orgs[0]);
    } catch (e) { return err(e); }
  }
);


server.tool("enrich_contact",
  "Enrich a specific person in Apollo — returns verified work email, personal email (if available), LinkedIn URL, phone numbers, title, and seniority. Minimum: first_name + last_name + company. Adding domain or linkedin_url greatly improves the match.",
  {
    first_name:              z.string().describe("Contact's first name"),
    last_name:               z.string().describe("Contact's last name"),
    company:                 z.string().describe("Company the contact works at"),
    domain:                  z.string().optional().describe("Company domain — strongly recommended"),
    linkedin_url:            z.string().optional().describe("LinkedIn profile URL — most reliable identifier"),
    reveal_personal_emails:  z.boolean().optional().describe("Attempt to reveal personal emails (default false — set to true only if you explicitly want to spend credits)"),
  },
  async ({ first_name, last_name, company, domain, linkedin_url, reveal_personal_emails }) => {
    try {
      const body = {
        first_name,
        last_name,
        organization_name:       company,
        reveal_personal_emails:  reveal_personal_emails ?? false,
      };
      if (domain)       body.domain       = domain;
      if (linkedin_url) body.linkedin_url = linkedin_url;
      const data   = await apolloFetch("/people/match", body);
      const person = data?.person ?? data;
      if (!person) return ok({ note: "No match found", query: { first_name, last_name, company } });
      return ok(person);
    } catch (e) { return err(e); }
  }
);

server.tool("search_people",
  "Search Apollo for people using rich ICP filters. Returns one page of results with full pagination metadata. Use this to explore and validate your filters before running bulk_pull_contacts. Supports title, seniority, department, industry, company size, location, and keyword filters.",
  {
    titles:                    z.array(z.string()).optional().describe("Job titles to match, e.g. [\"VP of Sales\", \"Head of Growth\"]"),
    seniority_levels:          z.array(z.string()).optional().describe("Seniority levels: owner, founder, c_suite, vp, director, manager, senior, entry, intern"),
    departments:               z.array(z.string()).optional().describe("Departments: sales, marketing, engineering, operations, business_development, finance, human_resources, product, legal"),
    keywords:                  z.string().optional().describe("Keyword search across bios and profiles"),
    industries:                z.array(z.string()).optional().describe("Industries, e.g. [\"Information Technology & Services\", \"SaaS\"]"),
    employee_count_ranges:     z.array(z.string()).optional().describe("Company headcount ranges, e.g. [\"1,50\", \"51,200\", \"201,500\", \"501,1000\", \"1001,5000\"]"),
    locations:                 z.array(z.string()).optional().describe("Person or company locations, e.g. [\"United States\", \"New York, New York, United States\"]"),
    company_names:             z.array(z.string()).optional().describe("Filter to specific company names"),
    has_email:                 z.boolean().optional().describe("If true, only return contacts where Apollo has an email address (default false)"),
    page:                      z.number().optional().describe("Page number, starting at 1 (default 1)"),
    per_page:                  z.number().optional().describe("Results per page, max 100 (default 25)"),
  },
  async ({ titles, seniority_levels, departments, keywords, industries, employee_count_ranges, locations, company_names, has_email, page, per_page }) => {
    try {
      const body = { page: page ?? 1, per_page: Math.min(per_page ?? 25, 100) };
      if (titles?.length)               body.person_titles                    = titles;
      if (seniority_levels?.length)     body.person_seniorities               = seniority_levels;
      if (departments?.length)          body.person_departments               = departments;
      if (keywords)                     body.q_keywords                       = keywords;
      if (industries?.length)           body.organization_industry_tag_ids    = industries;
      if (employee_count_ranges?.length) body.organization_num_employees_ranges = employee_count_ranges;
      if (locations?.length)            body.person_locations                 = locations;
      if (company_names?.length)        body.q_organization_name              = company_names.join(" OR ");

      const data    = await apolloFetch("/mixed_people/search", body);
      let people    = data?.people ?? [];
      if (has_email) people = people.filter(p => p.email);
      const total   = data?.pagination?.total_entries ?? people.length;
      const pages   = data?.pagination?.total_pages   ?? 1;
      return ok({
        total_found:  total,
        total_pages:  pages,
        current_page: page ?? 1,
        returned:     people.length,
        contacts:     people,
      });
    } catch (e) { return err(e); }
  }
);

server.tool("bulk_pull_contacts",
  "Pull a large list of contacts from Apollo by auto-paginating through results. Uses the same ICP filters as search_people. Returns a flat list of contacts with emails. Cap with max_results to control credit usage — Apollo charges per email reveal. Run search_people first to validate your filters and check total_found before pulling in bulk.",
  {
    titles:                    z.array(z.string()).optional().describe("Job titles to match"),
    seniority_levels:          z.array(z.string()).optional().describe("Seniority: owner, founder, c_suite, vp, director, manager, senior, entry"),
    departments:               z.array(z.string()).optional().describe("Departments: sales, marketing, engineering, operations, business_development, finance, human_resources, product"),
    keywords:                  z.string().optional().describe("Keyword search across bios and profiles"),
    industries:                z.array(z.string()).optional().describe("Industries, e.g. [\"Information Technology & Services\", \"SaaS\"]"),
    employee_count_ranges:     z.array(z.string()).optional().describe("Company headcount ranges, e.g. [\"1,50\", \"51,200\", \"201,500\"]"),
    locations:                 z.array(z.string()).optional().describe("Locations, e.g. [\"United States\"]"),
    company_names:             z.array(z.string()).optional().describe("Filter to specific company names"),
    has_email_only:            z.boolean().optional().describe("Only return contacts where Apollo already has an email — no credit charge (default true)"),
    max_results:               z.number().optional().describe("Total contacts to pull across all pages (default 100, max 500 per call to protect credits)"),
    start_page:                z.number().optional().describe("Page to start from, useful for resuming a pull (default 1)"),
  },
  async ({ titles, seniority_levels, departments, keywords, industries, employee_count_ranges, locations, company_names, has_email_only, max_results, start_page }) => {
    try {
      const cap      = Math.min(max_results ?? 100, 500);
      const perPage  = 100;
      const emailOnly = has_email_only !== false; // default true
      let collected  = [];
      let page       = start_page ?? 1;
      let totalFound = null;
      let totalPages = null;

      while (collected.length < cap) {
        const body = { page, per_page: perPage };
        if (titles?.length)                body.person_titles                     = titles;
        if (seniority_levels?.length)      body.person_seniorities                = seniority_levels;
        if (departments?.length)           body.person_departments                = departments;
        if (keywords)                      body.q_keywords                        = keywords;
        if (industries?.length)            body.organization_industry_tag_ids     = industries;
        if (employee_count_ranges?.length) body.organization_num_employees_ranges = employee_count_ranges;
        if (locations?.length)             body.person_locations                  = locations;
        if (company_names?.length)         body.q_organization_name               = company_names.join(" OR ");

        const data = await apolloFetch("/mixed_people/search", body);
        const people = data?.people ?? [];

        if (totalFound === null) totalFound = data?.pagination?.total_entries ?? 0;
        if (totalPages === null) totalPages = data?.pagination?.total_pages ?? 1;

        const filtered = emailOnly ? people.filter(p => p.email) : people;
        collected.push(...filtered);

        if (people.length < perPage || page >= totalPages) break; // no more pages
        page++;

        // Small pause to be polite to the API
        await new Promise(r => setTimeout(r, APOLLO_THROTTLE_MS));
      }

      // Trim to cap and shape output
      collected = collected.slice(0, cap);
      const withEmail    = collected.filter(p => p.email).length;
      const withoutEmail = collected.length - withEmail;

      return ok({
        summary: {
          total_in_apollo:   totalFound,
          pulled:            collected.length,
          with_email:        withEmail,
          without_email:     withoutEmail,
          pages_fetched:     page - (start_page ?? 1) + 1,
          capped_at:         cap,
        },
        contacts: collected.map(p => ({
          id:          p.id,
          name:        `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
          first_name:  p.first_name,
          last_name:   p.last_name,
          title:       p.title,
          email:       p.email,
          linkedin_url: p.linkedin_url,
          company:     p.organization?.name ?? p.organization_name,
          domain:      p.organization?.website_url ?? p.organization_domain,
          location:    p.city ? `${p.city}, ${p.state ?? ""}`.trim().replace(/,$/, "") : null,
          seniority:   p.seniority,
          phone:       p.sanitized_phone,
        })),
      });
    } catch (e) { return err(e); }
  }
);

// ─── Pipeline tools ───────────────────────────────────────────────────────────
server.tool("bulk_push_to_campaign",
  "Take a list of contacts (from Apollo CRM search or any source) and push them into an EmailBison campaign in one operation. Creates each contact as a lead in the correct client workspace, collects all lead IDs, then attaches them to the campaign. Use emailbison_list_campaigns first to get the campaign_id. Contacts must have at least an email address.",
  {
    client_name:  z.string().describe("Client name, e.g. 'AskTuring' — determines which EmailBison workspace and instance to use"),
    campaign_id:  z.string().describe("EmailBison campaign ID to push leads into — get this from list_campaigns"),
    contacts:     z.array(z.object({
      email:      z.string().describe("Contact's email address (required)"),
      first_name: z.string().optional(),
      last_name:  z.string().optional(),
      company:    z.string().optional(),
      title:      z.string().optional(),
      website:    z.string().optional(),
    })).describe("Array of contacts to push. Must include email for each."),
  },
  async ({ client_name, campaign_id, contacts }) => {
    try {
      const client = getClient(client_name);
      const { base, key, ws_id } = ebConfig(client);

      // Switch workspace once
      await fetch(`${base}/workspaces/v1.1/switch-workspace`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ team_id: ws_id }),
      });

      // Create leads one by one, collect IDs
      const created = [];
      const failed  = [];

      for (const contact of contacts) {
        if (!contact.email) { failed.push({ contact, reason: "missing email" }); continue; }
        try {
          const res = await fetch(`${base}/leads`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              email:      contact.email,
              first_name: contact.first_name,
              last_name:  contact.last_name,
              company:    contact.company,
              title:      contact.title,
              website:    contact.website,
            }),
          });
          const data = await res.json();
          const id   = data?.data?.id ?? data?.id;
          if (id) created.push(id);
          else failed.push({ contact, reason: data?.message ?? "no ID returned", raw: data });
        } catch (e) {
          failed.push({ contact, reason: e.message });
        }
      }

      // Attach all created leads to the campaign in one call
      let attachResult = null;
      if (created.length) {
        const attachRes = await fetch(`${base}/campaigns/${campaign_id}/leads/attach-leads`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ lead_ids: created }),
        });
        attachResult = await attachRes.json();
      }

      return ok({
        summary: {
          total_contacts:   contacts.length,
          leads_created:    created.length,
          leads_failed:     failed.length,
          attached_to:      campaign_id,
          attach_status:    attachResult?.message ?? attachResult?.status ?? "ok",
        },
        created_lead_ids: created,
        failed,
      });
    } catch (e) {
      return err(e);
    }
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
