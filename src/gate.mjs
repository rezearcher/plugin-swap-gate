// Pure, dependency-free core for the Grey Ridge pre-trade safety gate.
// No ElizaOS and no x402 imports live here so the money logic can be unit-tested
// offline and against the live endpoint without the agent runtime.

export const GATE_BASE = "https://x402-data-api.sigrunner.workers.dev";

const ADDR_RE = /0x[a-fA-F0-9]{40}/;

/** Pull the first Base token address out of free text, or return null. */
export function extractToken(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(ADDR_RE);
  return m ? m[0] : null;
}

/** Build the paid /gate/swap URL. Throws on a malformed token so a bad call never silently costs a payment. */
export function buildGateUrl({ token, side = "buy", notionalUsd = 100, base = GATE_BASE } = {}) {
  if (!ADDR_RE.test(String(token || ""))) {
    throw new Error(`invalid Base token address: ${token}`);
  }
  const s = side === "sell" ? "sell" : "buy";
  const n = Number(notionalUsd);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid notional_usd: ${notionalUsd}`);
  const qs = new URLSearchParams({ token, side: s, notional_usd: String(n) });
  return `${base}/gate/swap?${qs.toString()}`;
}

/** One-line human summary of a gate response. */
export function summarizeGate(out) {
  if (!out || typeof out !== "object") return "no gate response";
  const decision = String(out.decision || "unknown").toUpperCase();
  const bits = [];
  if (out.reason) bits.push(out.reason);
  if (typeof out.risk_score === "number") bits.push(`risk ${out.risk_score}/100`);
  if (typeof out.liquidity_usd === "number") {
    bits.push(`liquidity $${Math.round(out.liquidity_usd).toLocaleString("en-US")}`);
  }
  return `${decision}: ${bits.join(" · ") || "no detail"}`;
}

/**
 * Decide whether to proceed, honouring BOTH the gate's own decision and the
 * round-trip friction from the paid sizing block (when present). Mirrors the
 * guard in docs/examples/swap-gate/gate.mjs so the plugin and the reference
 * stay consistent.
 * @returns {{ go: boolean, reasons: string[] }}
 */
export function evaluateTrade(out, { maxBreakevenPct = 15, maxExitSlippagePct = 10 } = {}) {
  const reasons = [];
  if (!out || typeof out !== "object") return { go: false, reasons: ["no gate response"] };
  if (out.decision !== "go") {
    reasons.push(`gate ${String(out.decision).toUpperCase()}: ${out.reason || "not cleared"}`);
    return { go: false, reasons };
  }
  const en = out.sizing?.entry_sim?.this_trade;
  if (en && typeof en.roundtrip_breakeven_pct === "number" && en.roundtrip_breakeven_pct > maxBreakevenPct) {
    reasons.push(
      `round-trip breakeven ${en.roundtrip_breakeven_pct}% > ${maxBreakevenPct}% — friction eats the thesis`
    );
  }
  const ex = out.sizing?.exit_sim?.this_trade;
  if (ex && typeof ex.slippage_pct === "number" && ex.slippage_pct > maxExitSlippagePct) {
    reasons.push(
      `exit slippage ${ex.slippage_pct}% > ${maxExitSlippagePct}% — recover only $${ex.net_recovered_usd}`
    );
  }
  return { go: reasons.length === 0, reasons: reasons.length ? reasons : ["cleared"] };
}

/**
 * Run the gate. `payFetch` must be an x402-wrapped fetch (handles the 402 +
 * USDC payment); a plain fetch works only against the free preview.
 * @returns {Promise<object>} parsed gate JSON
 */
export async function fetchGate(payFetch, { token, side = "buy", notionalUsd = 100, base = GATE_BASE } = {}) {
  const url = buildGateUrl({ token, side, notionalUsd, base });
  const res = await payFetch(url);
  if (!res.ok && res.status !== 200) {
    // 402 here means payment was not completed (plain fetch, or signer missing).
    throw new Error(`gate request failed: HTTP ${res.status}`);
  }
  return res.json();
}

/** Build the paid /chain/token-report URL. Throws on a malformed token so a bad call never silently costs a payment. */
export function buildReportUrl({ token, base = GATE_BASE } = {}) {
  if (!ADDR_RE.test(String(token || ""))) {
    throw new Error(`invalid Base token address: ${token}`);
  }
  const qs = new URLSearchParams({ token });
  return `${base}/chain/token-report?${qs.toString()}`;
}

/** One-line human summary of a /chain/token-report response. */
export function summarizeReport(out) {
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
  return `${verdict}: ${bits.join(" · ") || "no detail"}`;
}

/**
 * Turn a token-report into a safe/unsafe decision for a screening agent.
 * SAFE verdict with no tripped flag => safe:true. Honeypot or not-sellable
 * forces unsafe regardless of the verdict text; risk_score over the threshold
 * or an AVOID verdict is unsafe; CAUTION is surfaced but only hard-fails when a
 * risk/honeypot flag also tripped.
 * @returns {{ safe: boolean, reasons: string[] }}
 */
export function evaluateReport(out, { maxRiskScore = 60 } = {}) {
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
  return { safe, reasons: reasons.length ? reasons : ["cleared — SAFE"] };
}

/**
 * Fetch the token report. `payFetch` must be an x402-wrapped fetch (handles the
 * 402 + USDC payment); a plain fetch works only against the free preview.
 * @returns {Promise<object>} parsed token-report JSON
 */
export async function fetchTokenReport(payFetch, { token, base = GATE_BASE } = {}) {
  const url = buildReportUrl({ token, base });
  const res = await payFetch(url);
  if (!res.ok && res.status !== 200) {
    throw new Error(`token-report request failed: HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Run the token report and fold in a safe/unsafe decision, returning one
 * enriched object a tool can hand straight back to the model: the full report
 * plus `safe` (boolean), `guard_reasons` and a one-line `summary`.
 *
 * Fails CLOSED by design: any error — unreachable route, unpaid 402, malformed
 * token — yields `{ verdict: "AVOID", safe: false }`, never a silent SAFE.
 * @returns {Promise<object>}
 */
export async function runTokenReport(payFetch, args = {}, { maxRiskScore = 60 } = {}) {
  try {
    const out = await fetchTokenReport(payFetch, args);
    const ev = evaluateReport(out, { maxRiskScore });
    return {
      ...out,
      safe: ev.safe,
      guard_reasons: ev.reasons,
      summary: summarizeReport(out),
    };
  } catch (err) {
    const reason = `token-report unavailable: ${err?.message || err}; fail closed`;
    return {
      verdict: "AVOID",
      risk_score: 100,
      safe: false,
      reason,
      guard_reasons: ["token-report unreachable — fail closed"],
      summary: "AVOID: token-report unreachable — fail closed",
    };
  }
}
