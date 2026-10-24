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
function buildReportUrl({ token, base = GATE_BASE } = {}) {
  if (!ADDR_RE.test(String(token || ""))) {
    throw new Error(`invalid Base token address: ${token}`);
  }
  const qs = new URLSearchParams({ token });
  return `${base}/chain/token-report?${qs.toString()}`;
}
function summarizeReport(out) {
  if (!out || typeof out !== "object") return "no token-report response";
  const verdict = String(out.verdict || "unknown").toUpperCase();
  const bits = [];
  if (typeof out.risk_score === "number") bits.push(`risk ${out.risk_score}/100`);
  const liq = out.liquidity?.wethPoolUsd;
  if (typeof liq === "number") {
    bits.push(`liquidity $${Math.round(liq).toLocaleString("en-US")}`);
  }
  if (Array.isArray(out.reasons) && out.reasons.length) {
    bits.push(out.reasons.slice(0, 3).join("; "));
  }
  return `${verdict}: ${bits.join(" \xB7 ") || "no detail"}`;
}
function evaluateReport(out, { maxRiskScore = 60 } = {}) {
  const reasons = [];
  if (!out || typeof out !== "object") return { safe: false, reasons: ["no token-report response"] };
  const verdict = String(out.verdict || "").toUpperCase();
  const sec = out.security || {};
  if (sec.isHoneypot === true) reasons.push("honeypot: a real wallet cannot sell this token");
  if (sec.sellable === false) reasons.push("not sellable");
  if (verdict === "AVOID") {
    reasons.push(`verdict AVOID: ${(out.reasons || []).slice(0, 3).join("; ") || "high risk"}`);
  }
  if (typeof out.risk_score === "number" && out.risk_score > maxRiskScore) {
    reasons.push(`risk_score ${out.risk_score} > ${maxRiskScore}`);
  }
  if (verdict === "CAUTION" && reasons.length === 0) {
    reasons.push(`verdict CAUTION: ${(out.reasons || []).slice(0, 2).join("; ") || "review before trading"}`);
  }
  const safe = reasons.length === 0 && verdict === "SAFE";
  return { safe, reasons: reasons.length ? reasons : ["cleared \u2014 SAFE"] };
}
async function fetchTokenReport(payFetch, { token, base = GATE_BASE } = {}) {
  const url = buildReportUrl({ token, base });
  const res = await payFetch(url);
  if (!res.ok && res.status !== 200) {
    throw new Error(`token-report request failed: HTTP ${res.status}`);
  }
  return res.json();
}
async function runTokenReport(payFetch, args = {}, { maxRiskScore = 60 } = {}) {
  try {
    const out = await fetchTokenReport(payFetch, args);
    const ev = evaluateReport(out, { maxRiskScore });
    return {
      ...out,
      safe: ev.safe,
      guard_reasons: ev.reasons,
      summary: summarizeReport(out)
    };
  } catch (err) {
    const reason = `token-report unavailable: ${err?.message || err}; fail closed`;
    return {
      verdict: "AVOID",
      risk_score: 100,
      safe: false,
      reason,
      guard_reasons: ["token-report unreachable \u2014 fail closed"],
      summary: "AVOID: token-report unreachable \u2014 fail closed"
    };
  }
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

// src/actions/reportTokenSafety.ts
function num2(runtime, key, fallback) {
  const v = runtime.getSetting(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
var reportTokenSafety = {
  name: "REPORT_TOKEN_SAFETY",
  similes: ["TOKEN_REPORT", "TOKEN_AUDIT", "VET_TOKEN", "RUG_CHECK", "SCREEN_TOKEN"],
  description: "Token-safety report for a Base ERC-20 via Grey Ridge /chain/token-report ($0.01 USDC per call): SAFE/CAUTION/AVOID verdict + risk_score (0-100) + reasons, bundling honeypot/sellability sim, admin-control checks, measured transfer tax and WETH-pool liquidity. Use to screen a token before deciding to trade.",
  validate: async (runtime, message) => {
    const text = message?.content?.text || "";
    return !!extractToken(text) || !!runtime.getSetting("SWAP_GATE_TOKEN");
  },
  handler: async (runtime, message, _state, options, callback) => {
    try {
      const optToken = typeof options?.token === "string" ? options.token : void 0;
      const text = message?.content?.text || "";
      const token = optToken || runtime.getSetting("SWAP_GATE_TOKEN") || extractToken(text);
      if (!token) {
        const msg = "No Base token address (0x\u202640 hex) found to vet.";
        await callback?.({ text: msg });
        return { success: false, text: msg };
      }
      const base = runtime.getSetting("SWAP_GATE_BASE_URL") || GATE_BASE;
      const privateKey = runtime.getSetting("SWAP_GATE_PRIVATE_KEY");
      const maxRiskScore = num2(runtime, "TOKEN_REPORT_MAX_RISK_SCORE", 60);
      const payFetch = makePayFetch(privateKey);
      const out = await runTokenReport(payFetch, { token, base }, { maxRiskScore });
      const text2 = out.safe ? `\u2705 ${out.summary} \u2014 screened safe.` : `\u26A0\uFE0F ${out.summary} \u2014 ${(out.guard_reasons || []).join("; ")}.`;
      await callback?.({ text: text2, content: out });
      return {
        success: true,
        text: text2,
        values: { safe: out.safe, verdict: out.verdict, risk_score: out.risk_score },
        data: { report: out }
      };
    } catch (error) {
      const text = `Token-safety report failed: ${error.message}`;
      await callback?.({ text });
      return { success: false, text, error };
    }
  },
  examples: [
    [
      { name: "{{user}}", content: { text: "Is 0x4ed4e862860bed51a9570b96d89af5e1b0efefed worth trading?" } },
      {
        name: "{{agent}}",
        content: {
          text: "Running a full token-safety report\u2026",
          actions: ["REPORT_TOKEN_SAFETY"]
        }
      }
    ],
    [
      { name: "{{user}}", content: { text: "Rug-check 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 for me." } },
      {
        name: "{{agent}}",
        content: {
          text: "Pulling honeypot/tax/liquidity and an overall verdict.",
          actions: ["REPORT_TOKEN_SAFETY"]
        }
      }
    ]
  ]
};

// src/index.ts
var swapGatePlugin = {
  name: "plugin-swap-gate",
  description: "Token-safety for Base trading agents: CHECK_TOKEN_BEFORE_SWAP (pre-trade gate via /gate/swap) and REPORT_TOKEN_SAFETY (screening report via /chain/token-report) \u2014 honeypot, sellability, admin-control and liquidity checks, paid inline with x402 USDC.",
  actions: [checkTokenBeforeSwap, reportTokenSafety],
  init: async (_config, _runtime) => {
  }
};
var index_default = swapGatePlugin;
export {
  checkTokenBeforeSwap,
  index_default as default,
  reportTokenSafety,
  swapGatePlugin
};
//# sourceMappingURL=index.js.map