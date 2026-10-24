import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractToken,
  buildGateUrl,
  buildPreviewUrl,
  fetchGateOrPreview,
  summarizeGate,
  summarizeSizing,
  sizingValues,
  evaluateTrade,
  fetchGate,
  GATE_BASE,
} from "../src/gate.mjs";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

test("extractToken pulls the first 0x address from free text", () => {
  assert.equal(extractToken(`buy ${USDC} now`), USDC);
  assert.equal(extractToken("no address here"), null);
  assert.equal(extractToken(null), null);
});

test("buildGateUrl builds a valid paid URL and rejects bad input", () => {
  const url = buildGateUrl({ token: USDC, side: "buy", notionalUsd: 500 });
  assert.ok(url.startsWith(`${GATE_BASE}/gate/swap?`));
  assert.ok(url.includes(`token=${USDC}`));
  assert.ok(url.includes("side=buy"));
  assert.ok(url.includes("notional_usd=500"));
  assert.throws(() => buildGateUrl({ token: "0xdead" }), /invalid Base token/);
  assert.throws(() => buildGateUrl({ token: USDC, notionalUsd: 0 }), /invalid notional/);
  // side is normalised to buy|sell only
  assert.ok(buildGateUrl({ token: USDC, side: "weird" }).includes("side=buy"));
});

test("summarizeGate renders a human one-liner", () => {
  const s = summarizeGate({ decision: "go", reason: "passes checks", risk_score: 25, liquidity_usd: 158115578 });
  assert.match(s, /^GO:/);
  assert.match(s, /risk 25\/100/);
  assert.match(s, /liquidity \$158,115,578/);
});

const SIZING = {
  max_safe_notional_usd: 12400,
  this_trade: { notional_usd: 1000, price_impact_pct: 0.6 },
  entry_sim: { this_trade: { roundtrip_breakeven_pct: 1.2 } },
  exit_sim: { this_trade: { slippage_pct: 0.6, net_recovered_usd: 994 } },
};

test("summarizeSizing renders the paid sizing moat line; empty without a pool", () => {
  const s = summarizeSizing({ decision: "go", sizing: SIZING });
  assert.match(s, /breakeven 1\.2%/);
  assert.match(s, /max safe size \$12,400/);
  assert.match(s, /exit slip 0\.6% \(recover \$994 of \$1,000\)/);
  assert.equal(summarizeSizing({ decision: "go" }), "");
  assert.equal(summarizeSizing({ decision: "block" }), "");
});

test("summarizeGate folds the sizing line into a GO summary", () => {
  const s = summarizeGate({ decision: "go", risk_score: 25, liquidity_usd: 620000, sizing: SIZING });
  assert.match(s, /^GO:/);
  assert.match(s, /max safe size \$12,400/);
});

test("sizingValues extracts the structured moat numbers; null without a pool", () => {
  const v = sizingValues({ sizing: SIZING });
  assert.equal(v.roundtrip_breakeven_pct, 1.2);
  assert.equal(v.max_safe_notional_usd, 12400);
  assert.equal(v.exit_slippage_pct, 0.6);
  assert.equal(v.exit_net_recovered_usd, 994);
  assert.equal(sizingValues({ decision: "go" }), null);
});

test("evaluateTrade blocks on a non-go decision", () => {
  const r = evaluateTrade({ decision: "block", reason: "honeypot" });
  assert.equal(r.go, false);
  assert.match(r.reasons[0], /BLOCK/);
});

test("evaluateTrade clears a clean go with benign sizing", () => {
  const r = evaluateTrade({
    decision: "go",
    sizing: { entry_sim: { this_trade: { roundtrip_breakeven_pct: 2 } }, exit_sim: { this_trade: { slippage_pct: 1 } } },
  });
  assert.equal(r.go, true);
});

test("evaluateTrade skips a go whose round-trip friction is too high", () => {
  const r = evaluateTrade(
    { decision: "go", sizing: { entry_sim: { this_trade: { roundtrip_breakeven_pct: 40 } } } },
    { maxBreakevenPct: 15 }
  );
  assert.equal(r.go, false);
  assert.match(r.reasons[0], /breakeven 40%/);
});

test("evaluateTrade skips a go whose exit slippage is too high", () => {
  const r = evaluateTrade(
    { decision: "go", sizing: { exit_sim: { this_trade: { slippage_pct: 25, net_recovered_usd: 70 } } } },
    { maxExitSlippagePct: 10 }
  );
  assert.equal(r.go, false);
  assert.match(r.reasons[0], /exit slippage 25%/);
});

test("fetchGate surfaces a non-200 as an error (unpaid 402 path)", async () => {
  const fakeFetch = async () => ({ ok: false, status: 402, json: async () => ({}) });
  await assert.rejects(() => fetchGate(fakeFetch, { token: USDC }), /HTTP 402/);
});

test("fetchGate parses a 200 gate response", async () => {
  const body = { decision: "go", reason: "ok", risk_score: 25 };
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => body });
  const out = await fetchGate(fakeFetch, { token: USDC });
  assert.equal(out.decision, "go");
});

test("buildPreviewUrl targets the free /gate/swap/preview route", () => {
  const url = buildPreviewUrl({ token: USDC, side: "buy", notionalUsd: 100 });
  assert.ok(url.startsWith(`${GATE_BASE}/gate/swap/preview?`));
  assert.ok(url.includes(`token=${USDC}`));
  assert.throws(() => buildPreviewUrl({ token: "0xdead" }), /invalid Base token/);
});

test("fetchGateOrPreview: no key reads the preview directly + attaches activation", async () => {
  const previewBody = { decision: "go", reason: "passes checks", risk_score: 20 };
  const previewFetch = async () => ({ ok: true, status: 200, json: async () => previewBody });
  // payFetch must NOT run without a key — prove it by throwing.
  const payFetch = async () => {
    throw new Error("payFetch must not run without a configured key");
  };
  const out = await fetchGateOrPreview(payFetch, { token: USDC }, { hasKey: false, previewFetch });
  assert.equal(out.decision, "go");
  assert.equal(out.paid, false);
  assert.ok(out.activation && out.activation.needed);
  assert.match(out.activation.hint, /FREE preview mode/);
  assert.match(out.activation.reason, /no SWAP_GATE_PRIVATE_KEY/);
});

test("fetchGateOrPreview: funded wallet (paid 200) returns the paid body, no activation", async () => {
  const body = { decision: "go", reason: "ok", risk_score: 25, sizing: { max_safe_notional_usd: 12400 } };
  const payFetch = async () => ({ ok: true, status: 200, json: async () => body });
  const out = await fetchGateOrPreview(payFetch, { token: USDC }, { hasKey: true });
  assert.equal(out.paid, true);
  assert.equal(out.activation, undefined);
  assert.equal(out.sizing.max_safe_notional_usd, 12400);
});

test("fetchGateOrPreview: unfunded 402 falls back to the preview + activation (unlock hint)", async () => {
  const previewBody = { decision: "block", reason: "honeypot" };
  const previewFetch = async () => ({ ok: true, status: 200, json: async () => previewBody });
  const payFetch = async () => ({ ok: false, status: 402, json: async () => ({}) });
  const out = await fetchGateOrPreview(payFetch, { token: USDC }, { hasKey: true, previewFetch });
  assert.equal(out.decision, "block"); // preview still catches the honeypot
  assert.equal(out.paid, false);
  assert.ok(out.activation.needed);
  assert.match(out.activation.reason, /wallet not funded/);
});

test("fetchGateOrPreview: THROWS when both paid (402) and preview are down (fail-closed signal)", async () => {
  const previewFetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const payFetch = async () => ({ ok: false, status: 402, json: async () => ({}) });
  await assert.rejects(
    () => fetchGateOrPreview(payFetch, { token: USDC }, { hasKey: true, previewFetch }),
    /gate preview failed: HTTP 503/
  );
});

// Live check against the real deployed Worker. The free path returns an x402
// 402 with real resource metadata, which proves the route + our URL builder are
// in sync with production. Skipped automatically when offline (GATE_LIVE unset
// disables it in CI that has no egress). Set GATE_LIVE=1 to require it.
test("live /gate/swap route is reachable and x402-gated", async (t) => {
  const url = buildGateUrl({ token: "0x4200000000000000000000000000000000000006", side: "buy", notionalUsd: 100 });
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    if (process.env.GATE_LIVE === "1") throw e;
    t.skip(`no egress: ${e.message}`);
    return;
  }
  assert.equal(res.status, 402, "paid route must challenge with HTTP 402 when unpaid");
  const j = await res.json();
  assert.equal(j.x402Version, 2);
  assert.ok(Array.isArray(j.accepts) && j.accepts.length > 0, "must advertise an x402 payment option");
  assert.equal(j.accepts[0].network, "eip155:8453", "payment must be on Base");
});
