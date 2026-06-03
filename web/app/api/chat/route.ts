import Anthropic from "@anthropic-ai/sdk";
import { tools } from "@/lib/tools";
import { executeTool } from "@/lib/executors";
import { loadClientContext } from "@/lib/context";

export const maxDuration = 60;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLIENT_CONTEXT = loadClientContext("intellectible");

const SYSTEM = `You are a GTM operator helping run Intellectible's outbound motion.
Intellectible is a GovCon intelligence platform. Your job is to help the user understand
what's happening in the pipeline, diagnose what's working or not, and take action.

${CLIENT_CONTEXT}

---

## How to operate

When asked about campaigns or pipeline: pull the data first, then give a clear read.
When diagnosing low performance: identify the specific constraint — targeting, messaging, volume, or deliverability.
When asked to act (tag a reply, send a follow-up, launch a campaign): do it, then confirm.

Use the client context above to inform every answer — ICP, positioning angles, voice rules, what objections look like.
Never use language the voice guide bans. Never pitch features — lead with the problem.

Be direct. Short answers unless the situation calls for depth.`.trim();

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

            // Emit structured cards for the UI
            if (block.name === "list_campaigns") {
              const campaigns = (result as Record<string, unknown>)?.data ?? result;
              if (Array.isArray(campaigns) && campaigns.length > 0) {
                send({ type: "campaigns_card", campaigns });
              }
            }
            if (block.name === "list_replies") {
              const r = result as Record<string, unknown>;
              const leads = Array.isArray(r?.data) ? r.data : [];
              if (leads.length > 0) {
                send({ type: "leads_card", client: "Intellectible", leads });
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
