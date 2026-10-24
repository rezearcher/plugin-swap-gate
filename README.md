# plugin-swap-gate

**Pre-trade token-safety gate for Base trading agents.** One action your ElizaOS agent runs *before every swap*: is this token a honeypot, can you actually sell it, do its admin controls let the deployer rug it, and is your order too big for the pool? You get a `GO` / `HOLD` / `BLOCK` decision and a round-trip-friction-aware go/no-go in a single fast call.

Paid inline per call with **x402 USDC — $0.008/call**. No API key, no dashboard, no subscription. Base-native.

```
A honeypot or a 30% round-trip tax costs your agent real funds on a single trade.
This check costs $0.008 and runs in one call before the swap fires.
```

## Why this over the alternatives

| | plugin-swap-gate | GoPlus token API | 1inch / router safety | roll-your-own |
|---|---|---|---|---|
| Honeypot + **sellability** sim | ✅ | partial | — | you build it |
| **Liquidity-vs-your-size** price-impact guard | ✅ | — | partial | you build it |
| **Round-trip** entry+exit slippage sizing | ✅ | — | — | you build it |
| Admin-control / mint / blacklist checks | ✅ | ✅ | — | you build it |
| Pay-per-call, no key, no signup | ✅ x402 USDC | API-key tiers | key/SDK | — |
| One call, one decision | ✅ | multi-endpoint | — | — |
| Base-native | ✅ | multi-chain | multi-chain | — |

Price point: **~1/25th** of pre-trade checks that bill up to $0.25/call.

## Scope & honesty

This is a **heuristic pre-trade risk signal**, not financial advice and not a guarantee. `GO` means our checks found no blocker at scan time — it is **not** a promise the token is safe, and on-chain state changes after the scan. Size positions accordingly. (See the `disclaimer` field on every response.)

## Install

```bash
npm install github:rezearcher/plugin-swap-gate
# or: bun add github:rezearcher/plugin-swap-gate
```

Installs directly from source — the build is committed, so there is nothing to compile.

Add it to your character/agent plugins:

```ts
import swapGatePlugin from "plugin-swap-gate";

export const character = {
  name: "MyTrader",
  plugins: [swapGatePlugin],
  // ...
};
```

## Two actions

The plugin registers **two** paid pre-trade safety actions; the agent picks the right one from the user's intent:

| Action | Route | Price | When the agent uses it |
|---|---|---|---|
| `CHECK_TOKEN_BEFORE_SWAP` | `/gate/swap` | $0.008 | The final gate *right before a swap*, sized to a notional — returns `GO / HOLD / BLOCK` + a round-trip-friction-aware `proceed`. |
| `REPORT_TOKEN_SAFETY` | `/chain/token-report` | $0.01 | **Screening** a candidate token earlier ("is 0x… worth trading / is it a rug?") — returns a `SAFE / CAUTION / AVOID` verdict + a `safe` boolean, no trade size needed. |

Both are paid inline with x402 USDC and **fail closed** (skip / `safe:false`) if the route is unreachable, so an outage can never green-light a trade.

## Configure (agent settings / env)

| Setting | Required | Default | Purpose |
|---|---|---|---|
| `SWAP_GATE_PRIVATE_KEY` | no* | — | Hex key of the agent's Base wallet; signs the x402 USDC payment. Omit → free preview path only. |
| `SWAP_GATE_NOTIONAL_USD` | no | `100` | Default trade size for the liquidity / sizing checks. |
| `SWAP_GATE_MAX_BREAKEVEN_PCT` | no | `15` | Skip a `GO` whose round-trip friction exceeds this %. |
| `SWAP_GATE_MAX_EXIT_SLIPPAGE_PCT` | no | `10` | Skip a `GO` whose modelled exit slippage exceeds this %. |
| `SWAP_GATE_BASE_URL` | no | hosted Worker | Override the gate endpoint. |

\* Without a key the action still runs but only reaches the free preview; wire the key so paid calls return the full `sizing` block and a real paid verdict.

## Use

The action is `CHECK_TOKEN_BEFORE_SWAP` (similes: `HONEYPOT_CHECK`, `TOKEN_SAFETY`, `PRE_TRADE_SAFETY`, `SWAP_GUARD`). It fires when a message contains a Base token address, or call it directly from your trade flow with explicit options:

```ts
const res = await runtime.processAction("CHECK_TOKEN_BEFORE_SWAP", message, state, {
  token: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed",
  side: "buy",
  notional_usd: 500,
});
// res.values.proceed === true  → safe to submit the swap
// res.data.gate               → full gate response (decision, risk_score, flags, sizing…)
```

Branch your trade on `res.values.proceed`. When it's `false`, `res.text` explains why (BLOCK reason, or round-trip/exit-slippage over your thresholds).

## What the gate checks

Honeypot & transfer-tax simulation · sellability (can you exit) · admin controls (mint, blacklist, pausable, ownership) · Uniswap v3 WETH-pool liquidity vs. your notional (price-impact guard) · entry-leg and exit-leg slippage with a `$100 / $1k / $10k / $50k` sizing ladder.

## Links

- Endpoint & docs: https://x402-data-api.sigrunner.workers.dev
- Free, no-wallet preview: `GET /gate/swap/preview?token=degen`
- By Grey Ridge Signals Group LLC

MIT licensed.
