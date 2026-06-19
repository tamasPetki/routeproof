import type { ToolSpec, RouteSample } from "../types.ts";

/**
 * A Provider is the "host's-eye model": given exactly the tool list a host
 * would expose (name + description + input schema, NO implementation) and a
 * user query, it decides which tool to call — or that none fits.
 *
 * This is the whole point of routeproof: the model only ever sees what a real
 * MCP host sees, so the result reflects real-world routing, not wishful tests.
 */
export interface Provider {
  readonly model: string;
  route(tools: ToolSpec[], query: string): Promise<RouteSample>;
}
