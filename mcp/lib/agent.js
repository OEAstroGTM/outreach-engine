// ── agent.js ─────────────────────────────────────────────────────────────────
// Generic delegating-agent runner. Each operator agent = a system prompt + a set
// of tools (each tool: {name, description, input_schema, handler}). The operator
// hands the agent a goal; this runs an Anthropic tool-use loop until the agent
// finishes, then returns its final message plus a transcript of tool calls.
import Anthropic from "@anthropic-ai/sdk";

const MODEL       = process.env.AGENT_MODEL || "claude-sonnet-4-6";
const MAX_TURNS   = Number(process.env.AGENT_MAX_TURNS || 25);
const MAX_TOKENS  = Number(process.env.AGENT_MAX_TOKENS || 4096);

let _anthropic = null;
function client() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set — required to run delegating agents.");
  }
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

/**
 * @param {object} agent  { name, systemPrompt, tools: [{name, description, input_schema, handler}] }
 * @param {string} goal   Natural-language objective from the operator.
 * @param {object} [opts] { context?: string }
 * @returns {Promise<{ agent, final_text, tool_calls, turns }>}
 */
export async function runAgent(agent, goal, opts = {}) {
  const anthropic = client();
  const toolMap = Object.fromEntries(agent.tools.map(t => [t.name, t]));
  const apiTools = agent.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));

  const system = opts.context
    ? `${agent.systemPrompt}\n\n## Operator context\n${opts.context}`
    : agent.systemPrompt;

  const messages = [{ role: "user", content: goal }];
  const toolCalls = [];
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools: apiTools,
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      const finalText = resp.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return { agent: agent.name, final_text: finalText, tool_calls: toolCalls, turns };
    }

    // Execute every requested tool, feed results back.
    const toolResults = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const tool = toolMap[block.name];
      let resultText;
      let isError = false;
      try {
        if (!tool) throw new Error(`Unknown tool: ${block.name}`);
        const out = await tool.handler(block.input || {});
        resultText = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      } catch (e) {
        resultText = `Error: ${e.message}`;
        isError = true;
      }
      toolCalls.push({ tool: block.name, input: block.input, ok: !isError });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: resultText,
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    agent: agent.name,
    final_text: `Stopped after hitting the ${MAX_TURNS}-turn limit before finishing.`,
    tool_calls: toolCalls,
    turns,
  };
}
