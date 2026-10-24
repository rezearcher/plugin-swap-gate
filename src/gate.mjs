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

/**
 * One-line summary of the PAID sizing block, or "" when the response carries no
 * usable sizing (free preview, no verifiable pool, or a fail-closed stub). This
 * is the differentiator no verdict-only rival returns: the agent is told not just
 * "safe" but the round-trip breakeven, the largest size that stays under 2% price
 * impact, and what it would actually recover on exit. Feature-detected so a plain
 * verdict response is unaffected.
 */
export function summarizeSizing(out) {
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
    const rec =
      typeof ex.net_recovered_usd === "number" && typeof notional === "number"
        ? ` (recover $${Math.round(ex.net_recovered_usd).toLocaleString("en-US")} of $${Math.round(notional).toLocaleString("en-US")})`
        : "";
    bits.push(`exit slip ${ex.slippage_pct}%${rec}`);
  }
  return bits.join(" · ");
}

/**
 * Structured view of the paid sizing numbers for an app that branches on values
 * rather than the summary string. Returns null when no usable sizing is present.
 * @returns {{ roundtrip_breakeven_pct: number|null, max_safe_notional_usd: number|null, exit_slippage_pct: number|null, exit_net_recovered_usd: number|null }|null}
 */
export function sizingValues(out) {
  const s = out && typeof out === "object" ? out.sizing : null;
  if (!s || typeof s !== "object" || s.max_safe_notional_usd == null) return null;
  const en = s.entry_sim?.this_trade || {};
  const ex = s.exit_sim?.this_trade || {};
  return {
    roundtrip_breakeven_pct: typeof en.roundtrip_breakeven_pct === "number" ? en.roundtrip_breakeven_pct : null,
    max_safe_notional_usd: typeof s.max_safe_notional_usd === "number" ? s.max_safe_notional_usd : null,
    exit_slippage_pct: typeof ex.slippage_pct === "number" ? ex.slippage_pct : null,
    exit_net_recovered_usd: typeof ex.net_recovered_usd === "number" ? ex.net_recovered_usd : null,
  };
}

/** One-line human summary of a gate response, including the paid sizing when present. */
export function summarizeGate(out) {
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
