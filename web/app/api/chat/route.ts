import Anthropic from "@anthropic-ai/sdk";
import { tools } from "@/lib/tools";
import { executeTool } from "@/lib/executors";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `You are the brain of an outreach engine. You manage cold email campaigns, leads, and client relationships.

## Your knowledge sources (always use these before answering questions about clients):

1. **Notion** (primary source of truth):
   - Each client has a Notion page with notes, campaign focus, key contacts, timezone, and services
   - Each client has a Notion leads database with all interested replies, statuses, and campaign data
   - Use read_notion_client to load a client's page before discussing them
   - Use query_client_leads to see their lead pipeline
   - Use append_notion_client_note or update_notion_client_notes to write new information back

2. **GitHub** (deep memory & patterns):
   - Each client has a private GitHub repo storing: profile.md, insights.md, meetings/, campaigns/, leads/
   - Use read_client_profile to load long-term patterns and history
   - Use update_client_insights, save_meeting_transcript, save_campaign_data to persist new learnings

3. **Live tools** (real-time data):
   - EmailBison & Instantly: campaign stats, lists, launches
   - MasterInbox: inbox replies, tagging, follow-ups
   - browse_url: fetch any public URL (company websites, LinkedIn, articles) — use this whenever someone shares a URL or you need to research a prospect or company

## Rules:
- When asked about a client: ALWAYS call read_notion_client FIRST — this gives you their team_id, instance, and leadsDbId
- ALWAYS pass team_id when calling list_campaigns or get_campaign_stats for EmailBison — never call without it or you'll get all clients' campaigns mixed together
- When asked for a summary of ALL clients: call list_all_clients to show the roster, then ask which specific client(s) to drill into — do NOT call list_campaigns for every client at once, it will time out
- When the user shares new info (meeting notes, campaign results, strategy changes): save it to BOTH Notion and GitHub
- When you spot patterns over time: write them to insights.md
- Be concise and think like a strategic outreach operator who learns and improves over time`;

export async function POST(req: Request) {
  const { messages } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const history = [...messages];

      while (true) {
        const response = await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: SYSTEM,
          tools: tools as Anthropic.Tool[],
          messages: history,
        });

        history.push({ role: "assistant", content: response.content });

        for (const block of response.content) {
          if (block.type === "text") {
            send({ type: "text", text: block.text });
          } else if (block.type === "tool_use") {
            send({ type: "tool_call", name: block.name, input: block.input });
            const result = await executeTool(block.name, block.input as Record<string, unknown>);
            // Emit structured card data for campaign and lead results
            if (block.name === "list_campaigns") {
              const campaigns = (result as Record<string, unknown>)?.data ?? result;
              if (Array.isArray(campaigns) && campaigns.length > 0) {
                send({ type: "campaigns_card", campaigns });
              }
            }
            if (block.name === "query_client_leads") {
              const r = result as Record<string, unknown>;
              if (Array.isArray(r?.leads) && (r.leads as unknown[]).length > 0) {
                send({ type: "leads_card", client: r.client, leads: r.leads });
              }
            }
            send({ type: "tool_result", name: block.name, result });
            history.push({
              role: "user",
              content: [{ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) }],
            });
          }
        }

        if (response.stop_reason === "end_turn") break;
      }

      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
