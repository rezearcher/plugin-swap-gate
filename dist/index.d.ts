import { Action, Plugin } from '@elizaos/core';

/**
 * Pre-trade safety gate. Call this BEFORE any Base swap: it runs Grey Ridge
 * /gate/swap (honeypot + sellability + admin-control + liquidity-vs-size) and
 * returns GO / HOLD / BLOCK plus a sizing-aware go/no-go the agent can branch on.
 */
declare const checkTokenBeforeSwap: Action;

/**
 * Grey Ridge pre-trade safety gate for ElizaOS trading agents.
 *
 * Wraps the Base-native /gate/swap route (honeypot + sellability +
 * admin-control + liquidity-vs-trade-size) as a single pre-trade action,
 * paid inline per call via x402 USDC ($0.008) — no API key, no subscription.
 */
declare const swapGatePlugin: Plugin;

export { checkTokenBeforeSwap, swapGatePlugin as default, swapGatePlugin };
