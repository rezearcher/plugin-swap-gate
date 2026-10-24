import type { Plugin } from "@elizaos/core";
import { checkTokenBeforeSwap } from "./actions/checkTokenBeforeSwap.js";

/**
 * Grey Ridge pre-trade safety gate for ElizaOS trading agents.
 *
 * Wraps the Base-native /gate/swap route (honeypot + sellability +
 * admin-control + liquidity-vs-trade-size) as a single pre-trade action,
 * paid inline per call via x402 USDC ($0.008) — no API key, no subscription.
 */
export const swapGatePlugin: Plugin = {
  name: "plugin-swap-gate",
  description:
    "Pre-trade token-safety gate for Base trading agents: honeypot, sellability, admin-control and liquidity-vs-size checks via Grey Ridge /gate/swap, paid inline with x402 USDC. Call before every swap.",
  actions: [checkTokenBeforeSwap],
  init: async (_config, _runtime) => {
    // Nothing to warm up; the action lazily builds its x402 fetch on first use.
  },
};

export { checkTokenBeforeSwap };
export default swapGatePlugin;
