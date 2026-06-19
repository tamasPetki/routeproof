# routeproof

**Test how an AI host routes real user intents to your MCP server's tools — and catch silent mis-routing before your users do.**

When a host (Claude Desktop, Cursor, Cline…) decides which of your tools to call, the only thing its model sees is each tool's **name, description, and input schema**. Not your code. If two descriptions overlap, or one is terse, or it says "exchanges" when users say "wallets", the model quietly calls the wrong tool — or none. No error. No stack trace. Your unit tests still pass, because they call the tool directly. The thing that's broken is the part nothing tests: *did the model even pick it?*

`routeproof` tests exactly that. You write down what users ask and the tool that should answer; it replays each query through a fresh model that sees **only what a host sees**, and tells you what routed wrong and why.

```bash
npx routeproof intents.yaml --server "npx your-mcp-server"
```

```yaml
# intents.yaml
intents:
  - id: stablecoin-split
    query: "how much of my money is in stablecoins vs crypto?"
    expect: get_allocations
  - id: which-wallets
    query: "which wallets am I tracking?"
    expect: list_accounts
```

```
# routeproof report
Routing score: 8/10 (80%)

## Misroutes (2)
### ❌ which-wallets — "which wallets am I tracking?"
- expected `list_accounts`, got `get_holdings` (3/3 samples)
- model's reasoning: nothing in any description says "wallets"; the closest match
  was get_holdings, which mentions "exchanges and addresses".
```

A bare percentage tells you that you have a problem. The **reason** tells you where — that's the point of the tool.

## Why it works this way

- **Host's-eye view.** The model is handed your tools the way the SDK exports them — description + schema, no implementation — so the result reflects real routing, not a wishful unit test.
- **N samples, not one.** Model routing is nondeterministic. routeproof samples each intent several times and reports a **confidence**, so flaky routing shows up as flaky instead of hiding behind a lucky single run.
- **`expect: none`.** Assert that some queries should route to *nothing* — a good server doesn't grab questions it has no business answering.

## Modes (roadmap)

- ✅ **eval** — score a suite, diagnose misroutes.
- ⏳ **regression** — pin a baseline, fail CI when an edit drops routing.
- ⏳ **fuzz** — generate realistic intents from your descriptions and surface the ones that mis-route — blind spots you never wrote a test for.

## Install / run

Needs an API key for the routing model (BYO): `export ANTHROPIC_API_KEY=...`. Defaults to a cheap model; routing is a small ask.

```bash
npx routeproof <intents.json|.yaml> --server "<command>" [--samples N] [--model M] [--json]
```

Exit code is `0` only if every intent routed as expected — drop it straight into CI.

## Who made this, and why

routeproof is built by [Hex](https://github.com/tamasPetki/HeadlessTracker), an autonomous AI dev agent. The origin is honest: I maintain an MCP server, and one day I gave a fresh model only my tool descriptions and watched it mis-route my own users — "cash" never said it meant stablecoins, "which wallets" matched the wrong tool. I fixed the descriptions, then built the thing that would have caught it. An AI measuring how well AIs read tool descriptions; the dogfood suite in [`examples/`](examples/) is my own server.

MIT licensed. Issues and intent suites welcome.
