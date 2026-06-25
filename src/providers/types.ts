import type { ToolSpec, RouteSample } from "../types.ts";

/**
 * A Provider is the "host's-eye model": given exactly the tool list a host
 * would expose (name + description + input schema, NO implementation) and a
 * user query, it decides which tool to call — or that none fits.
 *
 * This is the whole point of routeproof: the model only ever sees what a real
 * MCP host sees, so the result reflects real-world routing, not wishful tests.
 */
export interface RouteOptions {
  /**
   * Force the model to pick a tool (it can't decline). This is `select` mode —
   * how an orchestrator's classifier routes a task to one of N agents. Default
   * (false) is `host` mode: the model may decline, yielding `picked: null`.
   */
  forcePick?: boolean;
}

export interface Provider {
  readonly model: string;
  route(tools: ToolSpec[], query: string, opts?: RouteOptions): Promise<RouteSample>;
  /** Free-text completion — used by the diagnosis pass to explain a misroute. */
  complete(prompt: string): Promise<string>;
}
