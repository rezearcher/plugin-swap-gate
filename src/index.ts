import type { Plugin } from "@elizaos/core";
import { checkTokenBeforeSwap } from "./actions/checkTokenBeforeSwap.js";
import { reportTokenSafety } from "./actions/reportTokenSafety.js";

/**
 * Grey Ridge pre-trade safety gate for ElizaOS trading agents.
 *
 * Two actions, both paid inline per call via x402 USDC — no API key, no
 * subscription: CHECK_TOKEN_BEFORE_SWAP wraps /gate/swap (the final pre-swap
 * gate, sized to a notional, $0.008); REPORT_TOKEN_SAFETY wraps
 * /chain/token-report (a full SAFE/CAUTION/AVOID screening report, $0.01) for
 * vetting a candidate token before deciding to trade it.
 */
export const swapGatePlugin: Plugin = {
  name: "plugin-swap-gate",
  description:
    "Token-safety for Base trading agents: CHECK_TOKEN_BEFORE_SWAP (pre-trade gate via /gate/swap) and REPORT_TOKEN_SAFETY (screening report via /chain/token-report) — honeypot, sellability, admin-control and liquidity checks, paid inline with x402 USDC.",
  actions: [checkTokenBeforeSwap, reportTokenSafety],
  init: async (_config, _runtime) => {
    // Nothing to warm up; each action lazily builds its x402 fetch on first use.
  },
};

export { checkTokenBeforeSwap, reportTokenSafety };
export default swapGatePlugin;
