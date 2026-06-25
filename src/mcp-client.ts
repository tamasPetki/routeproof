// Spawn a real MCP server over stdio and read its tool list — the exact
// surface a host consumes. We never look at the implementation; only what the
// server advertises, because that's all the routing model gets either.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSpec } from "./types.ts";
import { tokenize } from "./shell.ts";

const VERSION = "0.2.0"; // identifies routeproof to the server in the MCP handshake

export async function loadToolsFromServer(command: string): Promise<ToolSpec[]> {
  const parts = tokenize(command);
  const cmd = parts[0];
  if (!cmd) throw new Error("Empty server command.");

  const transport = new StdioClientTransport({ command: cmd, args: parts.slice(1) });
  const client = new Client({ name: "routeproof", version: VERSION }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (e) {
    // The #1 first-run failure: the --server command doesn't actually launch a
    // stdio MCP server (typo, wrong subcommand, missing build). Say so plainly,
    // echo the command, and keep it distinct from an API-unreachable error.
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `could not start an MCP server from --server "${command}". It must launch a stdio MCP server that speaks JSON-RPC on stdout. Got: ${why}`,
    );
  }
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
