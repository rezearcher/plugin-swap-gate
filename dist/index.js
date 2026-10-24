// src/client.ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
var cached = null;
function makePayFetch(privateKey) {
  if (!privateKey) return fetch;
  if (cached) return cached;
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(privateKey)
  });
  cached = wrapFetchWithPayment(fetch, client);
  return cached;
}

// src/gate.mjs
var GATE_BASE = "https://x402-data-api.sigrunner.workers.dev";
var ADDR_RE = /0x[a-fA-F0-9]{40}/;
function extractToken(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(ADDR_RE);
  return m ? m[0] : null;
}
function buildGateUrl({ token, side = "buy", notionalUsd = 100, base = GATE_BASE } = {}) {
  if (!ADDR_RE.test(String(token || ""))) {
    throw new Error(`invalid Base token address: ${token}`);
  }
  const s = side === "sell" ? "sell" : "buy";
  const n = Number(notionalUsd);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid notional_usd: ${notionalUsd}`);
  const qs = new URLSearchParams({ token, side: s, notional_usd: String(n) });
  return `${base}/gate/swap?${qs.toString()}`;
}
function summarizeGate(out) {
  if (!out || typeof out !== "object") return "no gate response";
  const decision = String(out.decision || "unknown").toUpperCase();
  const bits = [];
  if (out.reason) bits.push(out.reason);
  if (typeof out.risk_score === "number") bits.push(`risk ${out.risk_score}/100`);
  if (typeof out.liquidity_usd === "number") {
    bits.push(`liquidity $${Math.round(out.liquidity_usd).toLocaleString("en-US")}`);
  }
  return `${decision}: ${bits.join(" \xB7 ") || "no detail"}`;
}
function evaluateTrade(out, { maxBreakevenPct = 15, maxExitSlippagePct = 10 } = {}) {
  const reasons = [];
  if (!out || typeof out !== "object") return { go: false, reasons: ["no gate response"] };
  if (out.decision !== "go") {
    reasons.push(`gate ${String(out.decision).toUpperCase()}: ${out.reason || "not cleared"}`);
    return { go: false, reasons };
  }
  const en = out.sizing?.entry_sim?.this_trade;
  if (en && typeof en.roundtrip_breakeven_pct === "number" && en.roundtrip_breakeven_pct > maxBreakevenPct) {
    reasons.push(
      `round-trip breakeven ${en.roundtrip_breakeven_pct}% > ${maxBreakevenPct}% \u2014 friction eats the thesis`
    );
  }
  const ex = out.sizing?.exit_sim?.this_trade;
  if (ex && typeof ex.slippage_pct === "number" && ex.slippage_pct > maxExitSlippagePct) {
    reasons.push(
      `exit slippage ${ex.slippage_pct}% > ${maxExitSlippagePct}% \u2014 recover only $${ex.net_recovered_usd}`
    );
  }
  return { go: reasons.length === 0, reasons: reasons.length ? reasons : ["cleared"] };
}
async function fetchGate(payFetch, { token, side = "buy", notionalUsd = 100, base = GATE_BASE } = {}) {
  const url = buildGateUrl({ token, side, notionalUsd, base });
  const res = await payFetch(url);
  if (!res.ok && res.status !== 200) {
    throw new Error(`gate request failed: HTTP ${res.status}`);
  }
  return res.json();
}

// src/actions/checkTokenBeforeSwap.ts
function num(runtime, key, fallback) {
  const v = runtime.getSetting(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
var checkTokenBeforeSwap = {
  name: "CHECK_TOKEN_BEFORE_SWAP",
  similes: ["HONEYPOT_CHECK", "TOKEN_SAFETY", "PRE_TRADE_SAFETY", "SWAP_GUARD"],
  description: "Pre-trade honeypot/tax/liquidity safety check for a Base token via Grey Ridge /gate/swap ($0.008 USDC per call). Returns GO/HOLD/BLOCK and a round-trip-friction-aware decision. Run before every swap.",
  validate: async (runtime, message) => {
    const text = message?.content?.text || "";
    return !!extractToken(text) || !!runtime.getSetting("SWAP_GATE_TOKEN");
  },
  handler: async (runtime, message, _state, options, callback) => {
    try {
      const optToken = typeof options?.token === "string" ? options.token : void 0;
      const optSide = options?.side === "sell" || options?.side === "buy" ? options.side : void 0;
      const optNotional = typeof options?.notional_usd === "number" ? options.notional_usd : void 0;
      const text = message?.content?.text || "";
      const token = optToken || runtime.getSetting("SWAP_GATE_TOKEN") || extractToken(text);
      if (!token) {
        const msg = "No Base token address (0x\u202640 hex) found to check.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }
      const side = optSide === "sell" ? "sell" : "buy";
      const notionalUsd = optNotional ?? num(runtime, "SWAP_GATE_NOTIONAL_USD", 100);
      const base = runtime.getSetting("SWAP_GATE_BASE_URL") || GATE_BASE;
      const privateKey = runtime.getSetting("SWAP_GATE_PRIVATE_KEY");
      const payFetch = makePayFetch(privateKey);
      const out = await fetchGate(payFetch, { token, side, notionalUsd, base });
      const maxBreakevenPct = num(runtime, "SWAP_GATE_MAX_BREAKEVEN_PCT", 15);
      const maxExitSlippagePct = num(runtime, "SWAP_GATE_MAX_EXIT_SLIPPAGE_PCT", 10);
      const verdict = evaluateTrade(out, { maxBreakevenPct, maxExitSlippagePct });
      const summary = summarizeGate(out);
      const text2 = verdict.go ? `\u2705 ${summary} \u2014 safe to proceed.` : `\u26D4 ${summary} \u2014 skip: ${verdict.reasons.join("; ")}.`;
      await callback?.({ text: text2, content: out });
      return {
        success: true,
        text: text2,
        values: { proceed: verdict.go, decision: out.decision, risk_score: out.risk_score },
        data: { gate: out, verdict }
      };
    } catch (error) {
      const text = `Pre-trade safety check failed: ${error.message}`;
      await callback?.({ text });
      return { success: false, text, error };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Should I buy 0x4ed4e862860bed51a9570b96d89af5e1b0efefed?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Running a pre-trade safety check\u2026",
          actions: ["CHECK_TOKEN_BEFORE_SWAP"]
        }
      }
    ],
    [
      { name: "{{user}}", content: { text: "Is 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 a honeypot?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Checking honeypot/tax/liquidity before any swap.",
          actions: ["CHECK_TOKEN_BEFORE_SWAP"]
        }
      }
    ]
  ]
};

// src/index.ts
var swapGatePlugin = {
  name: "plugin-swap-gate",
  description: "Pre-trade token-safety gate for Base trading agents: honeypot, sellability, admin-control and liquidity-vs-size checks via Grey Ridge /gate/swap, paid inline with x402 USDC. Call before every swap.",
  actions: [checkTokenBeforeSwap],
  init: async (_config, _runtime) => {
  }
};
var index_default = swapGatePlugin;
export {
  checkTokenBeforeSwap,
  index_default as default,
  swapGatePlugin
};
//# sourceMappingURL=index.js.map