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
import {
  extractToken,
  fetchGateOrPreview,
  summarizeGate,
  summarizeSizing,
  sizingValues,
  evaluateTrade,
  GATE_BASE,
} from "../gate.mjs";

function num(runtime: IAgentRuntime, key: string, fallback: number): number {
  const v = runtime.getSetting(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Pre-trade safety gate. Call this BEFORE any Base swap: it runs Grey Ridge
 * /gate/swap (honeypot + sellability + admin-control + liquidity-vs-size) and
 * returns GO / HOLD / BLOCK plus a sizing-aware go/no-go the agent can branch on.
 */
export const checkTokenBeforeSwap: Action = {
  name: "CHECK_TOKEN_BEFORE_SWAP",
  similes: ["HONEYPOT_CHECK", "TOKEN_SAFETY", "PRE_TRADE_SAFETY", "SWAP_GUARD"],
  description:
    "Pre-trade honeypot/tax/liquidity safety check for a Base token via Grey Ridge /gate/swap ($0.008 USDC per call). Returns GO/HOLD/BLOCK and a round-trip-friction-aware decision. Run before every swap.",

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Usable whenever the message carries a Base token address; a configured
    // key only decides paid vs free-preview, it does not gate the action.
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
      // ElizaOS passes options as a HandlerOptions bag with an index signature,
      // so caller-supplied token/side/notional arrive as `unknown` — read + narrow.
      const optToken = typeof options?.token === "string" ? (options.token as string) : undefined;
      const optSide = options?.side === "sell" || options?.side === "buy" ? (options.side as string) : undefined;
      const optNotional = typeof options?.notional_usd === "number" ? (options.notional_usd as number) : undefined;

      const text = (message?.content?.text as string) || "";
      const token =
        optToken ||
        (runtime.getSetting("SWAP_GATE_TOKEN") as string) ||
        extractToken(text);
      if (!token) {
        const msg = "No Base token address (0x…40 hex) found to check.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }

      const side = optSide === "sell" ? "sell" : "buy";
      const notionalUsd = optNotional ?? num(runtime, "SWAP_GATE_NOTIONAL_USD", 100);
      const base = (runtime.getSetting("SWAP_GATE_BASE_URL") as string) || GATE_BASE;
      const privateKey = runtime.getSetting("SWAP_GATE_PRIVATE_KEY") as string | undefined;
      const hasKey = typeof privateKey === "string" && privateKey.length > 0;

      const payFetch = makePayFetch(privateKey);
      // Degrades OPEN to the free preview when no wallet is configured/funded,
      // so a fresh install returns a real GO/BLOCK plus a fund-onramp hint
      // instead of an opaque "HTTP 402" throw that would block every trade.
      const out = await fetchGateOrPreview(payFetch, { token, side, notionalUsd, base }, { hasKey });

      const maxBreakevenPct = num(runtime, "SWAP_GATE_MAX_BREAKEVEN_PCT", 15);
      const maxExitSlippagePct = num(runtime, "SWAP_GATE_MAX_EXIT_SLIPPAGE_PCT", 10);
      const verdict = evaluateTrade(out, { maxBreakevenPct, maxExitSlippagePct });

      // summarizeGate already folds in the paid sizing line; keep a separate
      // handle on it so an app branching on `values` gets the moat numbers too.
      const summary = summarizeGate(out);
      const sizing = sizingValues(out);
      const activation = (out as { activation?: { needed?: boolean; hint?: string } }).activation;
      const base2 = verdict.go
        ? `✅ ${summary} — safe to proceed.`
        : `⛔ ${summary} — skip: ${verdict.reasons.join("; ")}.`;
      // Free-preview mode: tell the dev how to unlock the paid tier (never silent).
      const text2 = activation?.needed ? `${base2}\nℹ️ ${activation.hint}` : base2;

      await callback?.({ text: text2, content: out });

      return {
        success: true,
        text: text2,
        values: {
          proceed: verdict.go,
          decision: out.decision,
          risk_score: out.risk_score,
          // true when the paid x402 call settled; false on the free-preview path.
          paid: (out as { paid?: boolean }).paid === true,
          activation_needed: activation?.needed === true,
          // Sizing-aware values: the only pre-trade safety plugin that hands the
          // agent an actionable size/exit alongside the verdict (null if the
          // response had no verifiable pool, e.g. the free preview path).
          roundtrip_breakeven_pct: sizing?.roundtrip_breakeven_pct ?? null,
          max_safe_notional_usd: sizing?.max_safe_notional_usd ?? null,
          exit_slippage_pct: sizing?.exit_slippage_pct ?? null,
          sizing_summary: summarizeSizing(out) || null,
        },
        data: { gate: out, verdict, sizing },
      };
    } catch (error) {
      const text = `Pre-trade safety check failed: ${(error as Error).message}`;
      await callback?.({ text });
      return { success: false, text, error: error as Error };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "Should I buy 0x4ed4e862860bed51a9570b96d89af5e1b0efefed?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Running a pre-trade safety check…",
          actions: ["CHECK_TOKEN_BEFORE_SWAP"],
        },
      },
    ],
    [
      { name: "{{user}}", content: { text: "Is 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 a honeypot?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Checking honeypot/tax/liquidity before any swap.",
          actions: ["CHECK_TOKEN_BEFORE_SWAP"],
        },
      },
    ],
  ],
};

export default checkTokenBeforeSwap;
