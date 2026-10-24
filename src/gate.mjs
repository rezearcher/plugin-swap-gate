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
