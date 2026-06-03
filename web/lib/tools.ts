import type Anthropic from "@anthropic-ai/sdk";

export const tools: Anthropic.Tool[] = [
  // ── Campaigns ──────────────────────────────────────────────────────────────
  {
    name: "list_campaigns",
    description: "List all EmailBison campaigns for Intellectible with status and stats.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_campaign_stats",
    description: "Get detailed stats for a specific campaign (sent, replies, interested, bounces).",
    input_schema: {
      type: "object",
      properties: {
        campaign_id: { type: "string", description: "The campaign ID" },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "launch_campaign",
    description: "Activate a paused campaign so it starts sending.",
    input_schema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
      },
      required: ["campaign_id"],
    },
  },
  {
    name: "pause_campaign",
    description: "Pause a running campaign.",
    input_schema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
      },
      required: ["campaign_id"],
    },
  },

  // ── Inbox ──────────────────────────────────────────────────────────────────
  {
    name: "list_replies",
    description: "List prospects/replies in the Intellectible MasterInbox workspace. Optionally filter by label.",
    input_schema: {
      type: "object",
      properties: {
        label_id: { type: "string", description: "Filter by label ID — use list_labels first" },
        page:     { type: "number" },
        limit:    { type: "number" },
      },
      required: [],
    },
  },
  {
    name: "list_labels",
    description: "List all labels in MasterInbox (Interested, Not Interested, OOO, etc.).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_reply_thread",
    description: "Get the full conversation thread for a specific prospect.",
    input_schema: {
      type: "object",
      properties: {
        prospect_id:    { type: "string" },
        prospect_email: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "tag_reply",
    description: "Assign a label to a prospect (e.g. mark as Interested).",
    input_schema: {
      type: "object",
      properties: {
        prospect_id: { type: "string" },
        label_id:    { type: "string", description: "Get label IDs from list_labels" },
      },
      required: ["prospect_id", "label_id"],
    },
  },
  {
    name: "send_reply",
    description: "Send a reply message to a prospect.",
    input_schema: {
      type: "object",
      properties: {
        prospect_id: { type: "string" },
        message:     { type: "string" },
      },
      required: ["prospect_id", "message"],
    },
  },

  // ── Research ───────────────────────────────────────────────────────────────
  {
    name: "find_company",
    description: "Find and enrich a company by name or domain. Returns industry, size, location.",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        domain:       { type: "string" },
      },
      required: ["company_name"],
    },
  },
  {
    name: "find_contacts",
    description: "Find decision-maker contacts at a company matching target titles.",
    input_schema: {
      type: "object",
      properties: {
        company_name: { type: "string" },
        domain:       { type: "string" },
        titles: {
          type: "array",
          items: { type: "string" },
          description: "Target job titles e.g. ['VP of BD', 'Capture Director']",
        },
        limit: { type: "number" },
      },
      required: ["company_name", "titles"],
    },
  },
];
