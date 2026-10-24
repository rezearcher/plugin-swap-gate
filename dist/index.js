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
function summarizeSizing(out) {
  const s = out && typeof out === "object" ? out.sizing : null;
  if (!s || typeof s !== "object" || s.max_safe_notional_usd == null) return "";
  const bits = [];
  const be = s.entry_sim?.this_trade?.roundtrip_breakeven_pct;
  if (typeof be === "number") bits.push(`breakeven ${be}%`);
  if (typeof s.max_safe_notional_usd === "number") {
    bits.push(`max safe size $${Math.round(s.max_safe_notional_usd).toLocaleString("en-US")}`);
  }
  const ex = s.exit_sim?.this_trade;
  if (ex && typeof ex.slippage_pct === "number") {
    const notional = s.this_trade?.notional_usd;
    const rec = typeof ex.net_recovered_usd === "number" && typeof notional === "number" ? ` (recover $${Math.round(ex.net_recovered_usd).toLocaleString("en-US")} of $${Math.round(notional).toLocaleString("en-US")})` : "";
    bits.push(`exit slip ${ex.slippage_pct}%${rec}`);
  }
  return bits.join(" \xB7 ");
}
function sizingValues(out) {
  const s = out && typeof out === "object" ? out.sizing : null;
  if (!s || typeof s !== "object" || s.max_safe_notional_usd == null) return null;
  const en = s.entry_sim?.this_trade || {};
  const ex = s.exit_sim?.this_trade || {};
  return {
    roundtrip_breakeven_pct: typeof en.roundtrip_breakeven_pct === "number" ? en.roundtrip_breakeven_pct : null,
    max_safe_notional_usd: typeof s.max_safe_notional_usd === "number" ? s.max_safe_notional_usd : null,
    exit_slippage_pct: typeof ex.slippage_pct === "number" ? ex.slippage_pct : null,
    exit_net_recovered_usd: typeof ex.net_recovered_usd === "number" ? ex.net_recovered_usd : null
  };
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
  const sizing = summarizeSizing(out);
  if (sizing) bits.push(sizing);
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
function buildPreviewUrl({ token, side = "buy", notionalUsd = 100, base = GATE_BASE } = {}) {
  if (!ADDR_RE.test(String(token || ""))) {
    throw new Error(`invalid Base token address: ${token}`);
  }
  const s = side === "sell" ? "sell" : "buy";
  const n = Number(notionalUsd);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid notional_usd: ${notionalUsd}`);
  const qs = new URLSearchParams({ token, side: s, notional_usd: String(n) });
  return `${base}/gate/swap/preview?${qs.toString()}`;
}
function fundOnrampHint() {
  return "Grey Ridge swap-gate is running in FREE preview mode: the honeypot / sellability / liquidity verdict is live, but the paid exit-simulation and trade sizing are withheld. To unlock them, set SWAP_GATE_PRIVATE_KEY to a Base wallet holding ~1 USDC (covers ~125 checks at $0.008 each, paid inline per call via x402 \u2014 no API key, no subscription).";
}
async function fetchGatePreview(args = {}, { previewFetch } = {}) {
  const f = previewFetch || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) throw new Error("no fetch available for gate preview");
  const url = buildPreviewUrl(args);
  const res = await f(url);
  if (!res.ok && res.status !== 200) {
    throw new Error(`gate preview failed: HTTP ${res.status}`);
  }
  return res.json();
}
async function fetchGateOrPreview(payFetch, args = {}, { hasKey = true, previewFetch } = {}) {
  const withActivation = (out2, reason2) => {
    if (out2 && typeof out2 === "object") {
      out2.paid = false;
      let paidUrl;
      try {
        paidUrl = buildGateUrl(args);
      } catch {
        paidUrl = void 0;
      }
      out2.activation = {
        needed: true,
        mode: "free_preview",
        reason: reason2,
        hint: fundOnrampHint(),
        paid_url: out2.upgrade && out2.upgrade.paid_url || paidUrl,
        price_usdc: "0.008"
      };
    }
    return out2;
  };
  if (!hasKey) {
    const out2 = await fetchGatePreview(args, { previewFetch });
    return withActivation(out2, "no SWAP_GATE_PRIVATE_KEY configured");
  }
  const url = buildGateUrl(args);
  const res = await payFetch(url);
  if (res.ok || res.status === 200) {
    const out2 = await res.json();
    if (out2 && typeof out2 === "object") out2.paid = true;
    return out2;
  }
  const reason = res.status === 402 ? "wallet not funded (paid /gate/swap returned 402)" : `paid /gate/swap returned HTTP ${res.status}`;
  const out = await fetchGatePreview(args, { previewFetch });
  return withActivation(out, reason);
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
      const hasKey = typeof privateKey === "string" && privateKey.length > 0;
      const payFetch = makePayFetch(privateKey);
      const out = await fetchGateOrPreview(payFetch, { token, side, notionalUsd, base }, { hasKey });
      const maxBreakevenPct = num(runtime, "SWAP_GATE_MAX_BREAKEVEN_PCT", 15);
      const maxExitSlippagePct = num(runtime, "SWAP_GATE_MAX_EXIT_SLIPPAGE_PCT", 10);
      const verdict = evaluateTrade(out, { maxBreakevenPct, maxExitSlippagePct });
      const summary = summarizeGate(out);
      const sizing = sizingValues(out);
      const activation = out.activation;
      const base2 = verdict.go ? `\u2705 ${summary} \u2014 safe to proceed.` : `\u26D4 ${summary} \u2014 skip: ${verdict.reasons.join("; ")}.`;
      const text2 = activation?.needed ? `${base2}
\u2139\uFE0F ${activation.hint}` : base2;
      await callback?.({ text: text2, content: out });
      return {
        success: true,
        text: text2,
        values: {
          proceed: verdict.go,
          decision: out.decision,
          risk_score: out.risk_score,
          // true when the paid x402 call settled; false on the free-preview path.
          paid: out.paid === true,
          activation_needed: activation?.needed === true,
          // Sizing-aware values: the only pre-trade safety plugin that hands the
          // agent an actionable size/exit alongside the verdict (null if the
          // response had no verifiable pool, e.g. the free preview path).
          roundtrip_breakeven_pct: sizing?.roundtrip_breakeven_pct ?? null,
          max_safe_notional_usd: sizing?.max_safe_notional_usd ?? null,
          exit_slippage_pct: sizing?.exit_slippage_pct ?? null,
          sizing_summary: summarizeSizing(out) || null
        },
        data: { gate: out, verdict, sizing }
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