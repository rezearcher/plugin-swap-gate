import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportUrl,
  summarizeReport,
  evaluateReport,
  fetchTokenReport,
  runTokenReport,
  GATE_BASE,
} from "../src/gate.mjs";

const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed";

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  return async () => ({ ok, status, json: async () => body });
}

test("buildReportUrl builds a valid paid URL and rejects bad input", () => {
  const url = buildReportUrl({ token: DEGEN });
  assert.ok(url.startsWith(`${GATE_BASE}/chain/token-report?`));
  assert.ok(url.includes(`token=${DEGEN}`));
  assert.throws(() => buildReportUrl({ token: "0xdead" }), /invalid Base token/);
  assert.throws(() => buildReportUrl({}), /invalid Base token/);
});

test("summarizeReport renders a human one-liner", () => {
  const s = summarizeReport({
    verdict: "SAFE",
    risk_score: 20,
    liquidity: { wethPoolUsd: 251940 },
    reasons: ["transfers can be paused"],
  });
  assert.match(s, /^SAFE:/);
  assert.match(s, /risk 20\/100/);
  assert.match(s, /liquidity \$251,940/);
  assert.match(s, /transfers can be paused/);
});

test("evaluateReport clears a clean SAFE verdict", () => {
  const r = evaluateReport({ verdict: "SAFE", risk_score: 20, security: { isHoneypot: false, sellable: true } });
  assert.equal(r.safe, true);
});

test("evaluateReport fails a honeypot regardless of verdict text", () => {
  const r = evaluateReport({ verdict: "SAFE", risk_score: 10, security: { isHoneypot: true } });
  assert.equal(r.safe, false);
  assert.match(r.reasons.join(" "), /honeypot/);
});

test("evaluateReport fails a non-sellable token", () => {
  const r = evaluateReport({ verdict: "CAUTION", risk_score: 30, security: { sellable: false } });
  assert.equal(r.safe, false);
  assert.match(r.reasons.join(" "), /not sellable/);
});

test("evaluateReport fails an AVOID verdict", () => {
  const r = evaluateReport({ verdict: "AVOID", risk_score: 85, reasons: ["mint enabled"] });
  assert.equal(r.safe, false);
  assert.match(r.reasons.join(" "), /AVOID/);
});

test("evaluateReport fails a risk_score over the threshold", () => {
  const r = evaluateReport({ verdict: "CAUTION", risk_score: 75 }, { maxRiskScore: 60 });
  assert.equal(r.safe, false);
  assert.match(r.reasons.join(" "), /risk_score 75 > 60/);
});

test("evaluateReport surfaces CAUTION without a hard flag", () => {
  const r = evaluateReport({ verdict: "CAUTION", risk_score: 30 });
  assert.equal(r.safe, false);
  assert.match(r.reasons.join(" "), /CAUTION/);
});

test("fetchTokenReport surfaces a non-200 as an error (unpaid 402 path)", async () => {
  await assert.rejects(() => fetchTokenReport(fakeFetch({}, { ok: false, status: 402 }), { token: DEGEN }), /HTTP 402/);
});

test("runTokenReport enriches a SAFE report with safe:true + summary", async () => {
  const body = { verdict: "SAFE", risk_score: 20, liquidity: { wethPoolUsd: 250000 }, security: { isHoneypot: false, sellable: true } };
  const r = await runTokenReport(fakeFetch(body), { token: DEGEN });
  assert.equal(r.safe, true);
  assert.equal(r.verdict, "SAFE");
  assert.match(r.summary, /^SAFE:/);
  assert.ok(Array.isArray(r.guard_reasons));
  assert.equal(r.liquidity.wethPoolUsd, 250000);
});

test("runTokenReport FAILS CLOSED when the route returns an unpaid 402", async () => {
  const r = await runTokenReport(fakeFetch({}, { ok: false, status: 402 }), { token: DEGEN });
  assert.equal(r.safe, false);
  assert.equal(r.verdict, "AVOID");
  assert.equal(r.risk_score, 100);
  assert.match(r.reason, /fail closed/);
});

test("runTokenReport FAILS CLOSED when payFetch throws (network/outage)", async () => {
  const throwingFetch = async () => {
    throw new Error("ECONNRESET");
  };
  const r = await runTokenReport(throwingFetch, { token: DEGEN });
  assert.equal(r.safe, false);
  assert.equal(r.verdict, "AVOID");
  assert.match(r.guard_reasons[0], /unreachable/);
});

// Live, FREE check against the real deployed Worker: the /chain/token-report
// FREE preview returns the same full report shape as the paid route with no
// payment, so this proves our evaluator is in sync with production end to end.
// Skipped automatically when offline (GATE_LIVE unset). Set GATE_LIVE=1 to require it.
test("live /chain/token-report free preview returns a real report our evaluator reads", async (t) => {
  let res;
  try {
    res = await fetch(`${GATE_BASE}/chain/token-report/preview?token=degen`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    if (process.env.GATE_LIVE === "1") throw e;
    t.skip(`no egress: ${e.message}`);
    return;
  }
  assert.equal(res.status, 200, "free preview must return 200");
  const j = await res.json();
  assert.ok(["SAFE", "CAUTION", "AVOID"].includes(String(j.verdict)), "verdict must be SAFE|CAUTION|AVOID");
  assert.equal(typeof j.risk_score, "number", "risk_score must be a number");
  const ev = evaluateReport(j);
  assert.equal(typeof ev.safe, "boolean", "evaluator must yield a boolean on the real shape");
  assert.ok(summarizeReport(j).length > 0, "summary must render on the real shape");
});

// Live, FREE check that the PAID route is x402-gated on Base (proves our URL
// builder targets the real paid resource).
test("live /chain/token-report paid route is x402-gated on Base", async (t) => {
  const url = buildReportUrl({ token: "0x4200000000000000000000000000000000000006" });
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
