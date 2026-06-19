// Day-1 smoke: prove routeproof's MCP client can read a real server's tools.
import { loadToolsFromServer } from "../src/mcp-client.ts";

const server = process.argv[2];
if (!server) throw new Error('usage: bun scripts/list-tools.ts "<server command>"');

const tools = await loadToolsFromServer(server);
console.log(`Read ${tools.length} tools from: ${server}\n`);
for (const t of tools) {
  console.log(`• ${t.name} — ${t.description.slice(0, 90)}${t.description.length > 90 ? "…" : ""}`);
}
