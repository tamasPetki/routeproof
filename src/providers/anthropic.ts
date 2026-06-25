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

    const blocks = await this.#post({
      model: this.model,
      max_tokens: 1024,
      tools: anthropicTools,
      messages: [{ role: "user", content: query }],
    });

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

  async complete(prompt: string): Promise<string> {
    const blocks = await this.#post({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });
    return blocks
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join("")
      .trim();
  }

  async #post(
    body: Record<string, unknown>,
    attempt = 0,
  ): Promise<Array<Record<string, unknown>>> {
    let res: Response;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A thrown fetch (DNS, TLS, proxy, offline) surfaces as a bare "fetch
      // failed" — useless to a new user. Name the endpoint and the usual causes,
      // and keep it distinct from an MCP-server failure (which reads differently).
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(
        `could not reach the Anthropic API at ${API} (${why}). Check ANTHROPIC_API_KEY, your network, and any HTTPS_PROXY / NO_PROXY settings.`,
      );
    }

    // Retry transient overload / rate limits with exponential backoff so a big
    // suite doesn't die on the first 429.
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(waitMs);
      return this.#post(body, attempt + 1);
    }

    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { content?: Array<Record<string, unknown>> };
    return data.content ?? [];
  }
}

const MAX_RETRIES = 4;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
