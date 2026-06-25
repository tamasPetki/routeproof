#!/usr/bin/env node
// registry-adapter.mjs — turn any "selector" registry into a thin stdio MCP
// server so routeproof can regression-test its routing. ZERO dependencies.
//
// A "selector" is anything where a model picks one option by reading short
// descriptions: a multi-agent orchestrator routing a task to one of N agents,
// a skill/command router, a plugin dispatcher. routeproof only needs the menu
// the selector sees — each option's name, description, and argument schema — so
// this adapter exposes each registry entry as an MCP "tool" and stops there.
//
// SELECTION-ONLY by design: routeproof reads the tool list and asks a fresh
// model which one a query routes to. It never calls the tool, so nothing here
// ever runs your real agents. That's what makes it safe to point at a live
// registry — you regression-test routing without firing anything.
//
// Usage:
//   node registry-adapter.mjs <registry.json>
//   npx routeproof intents.yaml --server "node registry-adapter.mjs registry.json"
//
// <registry.json> is either an array of entries or { "tools": [ ... ] }, each:
//   { "name": "...", "description": "...", "inputSchema"?: { ...JSON Schema } }
// Use the EXACT description string your orchestrator matches on — that string
// is the interface routeproof tests.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: node registry-adapter.mjs <registry.json>\n");
  process.exit(1);
}

let tools;
try {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(raw) ? raw : raw && raw.tools;
  if (!Array.isArray(list)) throw new Error('expected a JSON array, or { "tools": [...] }');
  tools = list.map((t, i) => {
    if (!t || typeof t.name !== "string" || !t.name) throw new Error(`entry ${i} is missing a string "name"`);
    if (typeof t.description !== "string") throw new Error(`entry "${t.name}" is missing a string "description"`);
    return {
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    };
  });
  if (!tools.length) throw new Error("registry is empty");
} catch (e) {
  process.stderr.write(`registry-adapter: could not load ${path}: ${e.message}\n`);
  process.exit(1);
}

// Newline-delimited JSON-RPC over stdio (the MCP stdio transport). Anything
// other than a response written to stdout corrupts the stream — debug → stderr.
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(req) {
  const { id, method, params } = req;
  if (id === undefined || id === null) return; // notification — no reply

  switch (method) {
    case "initialize":
      // Echo the client's protocol version so negotiation always succeeds.
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "routeproof-registry-adapter", version: "1.0.0" },
        },
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools } });
      return;
    case "tools/call":
      // routeproof never reaches this (it stops at selection). If some other
      // client calls it, return a harmless stub — we never run real agents.
      send({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "registry-adapter is selection-only; the agent was not invoked." }] },
      });
      return;
    case "ping":
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue; // ignore a malformed line rather than crash the server
    }
    handle(req);
  }
});
process.stdin.on("end", () => process.exit(0));
