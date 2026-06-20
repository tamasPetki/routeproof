// Spawn a real MCP server over stdio and read its tool list — the exact
// surface a host consumes. We never look at the implementation; only what the
// server advertises, because that's all the routing model gets either.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSpec } from "./types.ts";
import { tokenize } from "./shell.ts";

export async function loadToolsFromServer(command: string): Promise<ToolSpec[]> {
  const parts = tokenize(command);
  const cmd = parts[0];
  if (!cmd) throw new Error("Empty server command.");

  const transport = new StdioClientTransport({ command: cmd, args: parts.slice(1) });
  const client = new Client({ name: "routeproof", version: "0.1.0" }, { capabilities: {} });

  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
  } finally {
    await client.close();
  }
}
