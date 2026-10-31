// The one agent loop every crew member shares. An agent can only call the tools it is handed,
// so its permissions are the list below and nothing else.
import { client, MODEL } from "../claude.ts";

export interface AgentTool {
  name: string;
  description: string;
  input_schema: object;
  run: (input: any) => Promise<string>;
  // Calling this tool ends the agent's turn.
  ends?: boolean;
}

export const text = (description: string) => ({ type: "string", description });

export const schema = (properties: Record<string, object>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

export async function runAgent(a: {
  name: string;
  system: string;
  prompt: string;
  tools: AgentTool[];
  maxTurns: number;
  onCall?: (tool: string, input: any) => void;
}): Promise<void> {
  const messages: any[] = [{ role: "user", content: a.prompt }];
  const tools = a.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema, strict: true }));

  for (let turn = 0; turn < a.maxTurns; turn++) {
    const res: any = await client().beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: a.system,
      tools,
      tool_choice: { type: "auto" },
      messages,
    } as any);
    if (res.stop_reason === "refusal") throw new Error(`${a.name}: Claude declined this request`);
    messages.push({ role: "assistant", content: res.content });

    const calls = res.content.filter((b: any) => b.type === "tool_use");
    if (!calls.length) return;

    const results = await Promise.all(
      calls.map(async (call: any) => {
        a.onCall?.(call.name, call.input);
        const tool = a.tools.find((t) => t.name === call.name);
        try {
          if (!tool) throw new Error(`no such tool: ${call.name}`);
          return { type: "tool_result", tool_use_id: call.id, content: await tool.run(call.input) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: call.id, content: (e as Error).message, is_error: true };
        }
      }),
    );
    if (calls.some((call: any) => a.tools.find((t) => t.name === call.name)?.ends)) return;
    messages.push({ role: "user", content: results });
  }
}
