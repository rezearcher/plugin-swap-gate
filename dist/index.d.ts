import { Action, Plugin } from '@elizaos/core';

/**
 * Pre-trade safety gate. Call this BEFORE any Base swap: it runs Grey Ridge
 * /gate/swap (honeypot + sellability + admin-control + liquidity-vs-size) and
 * returns GO / HOLD / BLOCK plus a sizing-aware go/no-go the agent can branch on.
 */
declare const checkTokenBeforeSwap: Action;

/**
 * Token-safety report — the research / watchlist-screening companion to
 * CHECK_TOKEN_BEFORE_SWAP. Runs Grey Ridge /chain/token-report (honeypot +
 * sellability sim, owner-renounce + mint/pause/blacklist/fee-setter/upgradeable
 * checks, measured transfer tax, Uniswap v3 WETH-pool liquidity) and returns a
 * SAFE / CAUTION / AVOID verdict with a `safe` boolean the agent can branch on.
 * Use it to vet a candidate token BEFORE deciding to trade it; use
 * CHECK_TOKEN_BEFORE_SWAP as the final pre-swap gate sized to a notional.
 */
declare const reportTokenSafety: Action;

/**
 * Grey Ridge pre-trade safety gate for ElizaOS trading agents.
 *
 * Two actions, both paid inline per call via x402 USDC — no API key, no
 * subscription: CHECK_TOKEN_BEFORE_SWAP wraps /gate/swap (the final pre-swap
 * gate, sized to a notional, $0.008); REPORT_TOKEN_SAFETY wraps
 * /chain/token-report (a full SAFE/CAUTION/AVOID screening report, $0.01) for
 * vetting a candidate token before deciding to trade it.
 */
declare const swapGatePlugin: Plugin;

export { checkTokenBeforeSwap, swapGatePlugin as default, reportTokenSafety, swapGatePlugin };
