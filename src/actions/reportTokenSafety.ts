import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

// ElizaOS passes the handler's 5th arg as an untyped options bag (its public
// type for it is not a stable named export across versions), so we type it as a
// plain record and narrow each field we read below.
type HandlerOptions = Record<string, unknown>;
import { makePayFetch } from "../client.js";
// Core money-logic lives in a dependency-free module so it is unit-tested
// without the agent runtime. Imported with the .mjs extension on purpose.
import { extractToken, runTokenReport, GATE_BASE } from "../gate.mjs";

function num(runtime: IAgentRuntime, key: string, fallback: number): number {
  const v = runtime.getSetting(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Token-safety report — the research / watchlist-screening companion to
 * CHECK_TOKEN_BEFORE_SWAP. Runs Grey Ridge /chain/token-report (honeypot +
 * sellability sim, owner-renounce + mint/pause/blacklist/fee-setter/upgradeable
 * checks, measured transfer tax, Uniswap v3 WETH-pool liquidity) and returns a
 * SAFE / CAUTION / AVOID verdict with a `safe` boolean the agent can branch on.
 * Use it to vet a candidate token BEFORE deciding to trade it; use
 * CHECK_TOKEN_BEFORE_SWAP as the final pre-swap gate sized to a notional.
 */
export const reportTokenSafety: Action = {
  name: "REPORT_TOKEN_SAFETY",
  similes: ["TOKEN_REPORT", "TOKEN_AUDIT", "VET_TOKEN", "RUG_CHECK", "SCREEN_TOKEN"],
  description:
    "Token-safety report for a Base ERC-20 via Grey Ridge /chain/token-report ($0.01 USDC per call): SAFE/CAUTION/AVOID verdict + risk_score (0-100) + reasons, bundling honeypot/sellability sim, admin-control checks, measured transfer tax and WETH-pool liquidity. Use to screen a token before deciding to trade.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = (message?.content?.text as string) || "";
    return !!extractToken(text) || !!runtime.getSetting("SWAP_GATE_TOKEN");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const optToken = typeof options?.token === "string" ? (options.token as string) : undefined;
      const text = (message?.content?.text as string) || "";
      const token =
        optToken ||
        (runtime.getSetting("SWAP_GATE_TOKEN") as string) ||
        extractToken(text);
      if (!token) {
        const msg = "No Base token address (0x…40 hex) found to vet.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const base = (runtime.getSetting("SWAP_GATE_BASE_URL") as string) || GATE_BASE;
      const privateKey = runtime.getSetting("SWAP_GATE_PRIVATE_KEY") as string | undefined;
      const maxRiskScore = num(runtime, "TOKEN_REPORT_MAX_RISK_SCORE", 60);

      const payFetch = makePayFetch(privateKey);
      const out = await runTokenReport(payFetch, { token, base }, { maxRiskScore });

      const text2 = out.safe
        ? `✅ ${out.summary} — screened safe.`
        : `⚠️ ${out.summary} — ${(out.guard_reasons || []).join("; ")}.`;

      await callback?.({ text: text2, content: out });

      return {
        success: true,
        text: text2,
        values: { safe: out.safe, verdict: out.verdict, risk_score: out.risk_score },
        data: { report: out },
      };
    } catch (error) {
      const text = `Token-safety report failed: ${(error as Error).message}`;
      await callback?.({ text });
      return { success: false, text, error: error as Error };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "Is 0x4ed4e862860bed51a9570b96d89af5e1b0efefed worth trading?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Running a full token-safety report…",
          actions: ["REPORT_TOKEN_SAFETY"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Rug-check 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 for me." } },
      {
        name: "{{agent}}",
        content: {
          text: "Pulling honeypot/tax/liquidity and an overall verdict.",
          actions: ["REPORT_TOKEN_SAFETY"],
        },
      },
    ],
  ],
};

export default reportTokenSafety;
