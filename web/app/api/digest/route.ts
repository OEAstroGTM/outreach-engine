import { CLIENT_MAP } from "@/lib/notion";
import { NextRequest } from "next/server";

export const maxDuration = 60;

const MI_API = "https://api.masterinbox.com/api/api-webhook/v1/api";
const MASTERINBOX_KEY = process.env.MASTERINBOX_API_KEY!;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL!;
const CRON_SECRET = process.env.CRON_SECRET;
const DIGEST_SECRET = process.env.DIGEST_SECRET ?? "digest-secret";

// Reverse map: masterinboxWsId → display client name
const WS_TO_CLIENT: Record<number, string> = {};
for (const [name, cfg] of Object.entries(CLIENT_MAP)) {
  if (cfg.masterinboxWsId) {
    WS_TO_CLIENT[cfg.masterinboxWsId] = name
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
}

type Prospect = {
  workspace_id: number;
  name: string;
  first_name?: string;
  email: string;
  company?: string;
  campaign_name?: string;
  labels: number[];
  last_received_at: number;
  thread_url?: string;
};

async function fetchProspects(labelId: number, limit = 150): Promise<Prospect[]> {
  try {
    const r = await fetch(`${MI_API}/get-prospects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MASTERINBOX_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label_id: String(labelId), limit, page: 1 }),
    });
    if (!r.ok) return [];
    const data = await r.json() as { data?: Prospect[] };
    return (data.data ?? []).filter((p) => p.labels.includes(labelId));
  } catch {
    return [];
  }
}

function groupByClient(prospects: Prospect[]): Record<string, Prospect[]> {
  const map: Record<string, Prospect[]> = {};
  for (const p of prospects) {
    const client = WS_TO_CLIENT[p.workspace_id] ?? `Workspace ${p.workspace_id}`;
    if (!map[client]) map[client] = [];
    map[client].push(p);
  }
  return map;
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

function buildSlackMessage(
  interested: Prospect[],
  meetingRequests: Prospect[],
  meetingBooked: Prospect[],
): object {
  const date = formatDate();
  const total = interested.length + meetingRequests.length + meetingBooked.length;

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🌅 Daily Outreach Digest — ${date}`, emoji: true },
    },
    { type: "divider" },
  ];

  if (total === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No new activity in the last 24 hours. Keep sending!_" },
    });
  } else {
    // Meeting Booked (highest priority)
    if (meetingBooked.length > 0) {
      const grouped = groupByClient(meetingBooked);
      const lines = Object.entries(grouped)
        .map(([client, ps]) => {
          const names = ps.map((p) => `*${p.first_name || p.name}* (${p.company || p.email})`).join(", ");
          return `• *${client}* — ${names}`;
        })
        .join("\n");

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📅 *Meeting Booked* — ${meetingBooked.length} ${meetingBooked.length === 1 ? "meeting" : "meetings"} today\n${lines}`,
        },
      });
      blocks.push({ type: "divider" });
    }

    // Meeting Requests
    if (meetingRequests.length > 0) {
      const grouped = groupByClient(meetingRequests);
      const lines = Object.entries(grouped)
        .map(([client, ps]) => {
          const names = ps.map((p) => `*${p.first_name || p.name}* (${p.company || p.email})`).join(", ");
          return `• *${client}* — ${names}`;
        })
        .join("\n");

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🤝 *Meeting Requests* — ${meetingRequests.length} new\n${lines}`,
        },
      });
      blocks.push({ type: "divider" });
    }

    // Interested leads
    if (interested.length > 0) {
      const grouped = groupByClient(interested);
      const sortedClients = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);

      const lines = sortedClients
        .map(([client, ps]) => {
          const preview = ps
            .slice(0, 2)
            .map((p) => `${p.first_name || p.name}${p.company ? ` @ ${p.company}` : ""}`)
            .join(", ");
          const extra = ps.length > 2 ? ` +${ps.length - 2} more` : "";
          return `• *${client}* (${ps.length}) — ${preview}${extra}`;
        })
        .join("\n");

      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💬 *Interested Leads* — ${interested.length} new in the last 24h\n${lines}`,
        },
      });
      blocks.push({ type: "divider" });
    }
  }

  // Footer
  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<https://app.masterinbox.com|Open MasterInbox> · <https://web-vert-nu-59.vercel.app|Open Brain> · Auto-generated at 7AM`,
      },
    ],
  });

  return { blocks };
}

export async function GET(req: NextRequest) {
  // Accept Vercel's cron Authorization header or a manual ?secret= query param
  const authHeader = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const validCron = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  const validManual = querySecret === DIGEST_SECRET;
  if (!validCron && !validManual) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!SLACK_WEBHOOK_URL) {
    return new Response(JSON.stringify({ error: "SLACK_WEBHOOK_URL not configured" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const yesterday = Date.now() - 86_400_000;

  const [interested, meetingRequests, meetingBooked] = await Promise.all([
    fetchProspects(5074),   // Interested
    fetchProspects(6277),   // Meeting Request
    fetchProspects(6270),   // Meeting Booked
  ]);

  const interestedToday = interested.filter((p) => p.last_received_at > yesterday);
  const meetingRequestsToday = meetingRequests.filter((p) => p.last_received_at > yesterday);
  const meetingBookedToday = meetingBooked.filter((p) => p.last_received_at > yesterday);

  const payload = buildSlackMessage(interestedToday, meetingRequestsToday, meetingBookedToday);

  const slackRes = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!slackRes.ok) {
    const text = await slackRes.text();
    return new Response(JSON.stringify({ error: "Slack failed", detail: text }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      sent: {
        interested: interestedToday.length,
        meeting_requests: meetingRequestsToday.length,
        meeting_booked: meetingBookedToday.length,
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
