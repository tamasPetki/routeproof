// Anthropic provider: hands the model the tools exactly as a host would, and
// reads back which one it called. BYO key via ANTHROPIC_API_KEY.

import type { ToolSpec, RouteSample } from "../types.ts";
import type { Provider } from "./types.ts";

const API = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001"; // cheap by default; routing is a small ask

export class AnthropicProvider implements Provider {
  readonly model: string;
  #apiKey: string;

  constructor(model = DEFAULT_MODEL, apiKey = process.env.ANTHROPIC_API_KEY ?? "") {
    this.model = model;
    this.#apiKey = apiKey;
    if (!this.#apiKey) {
      throw new Error("Set ANTHROPIC_API_KEY to evaluate routing against Anthropic models.");
    }
  }

  async route(tools: ToolSpec[], query: string): Promise<RouteSample> {
    // The host's-eye view — the model sees ONLY name + description + schema.
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: (t.inputSchema as object) ?? { type: "object", properties: {} },
    }));

    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        tools: anthropicTools,
        messages: [{ role: "user", content: query }],
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { content?: Array<Record<string, unknown>> };
    const blocks = data.content ?? [];
    const toolUse = blocks.find((b) => b.type === "tool_use");
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join(" ")
      .trim();

    if (toolUse) {
      return { picked: String(toolUse.name), reason: `called ${String(toolUse.name)}` };
    }
    return { picked: null, reason: text || "no tool called" };
  }
}
