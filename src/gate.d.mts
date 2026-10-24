// Types for the dependency-free core (gate.mjs).

export declare const GATE_BASE: string;

export interface GateArgs {
  token: string;
  side?: "buy" | "sell";
  notionalUsd?: number;
  base?: string;
}

export interface GateResponse {
  token?: string;
  side?: "buy" | "sell";
  notional_usd?: number;
  decision?: "go" | "hold" | "block" | string;
  reason?: string;
  verdict?: string;
  risk_score?: number;
  liquidity_usd?: number;
  impact_pct_of_pool?: number;
  flags?: string[];
  token_meta?: { symbol?: string; name?: string; decimals?: number };
  analyzed_at?: string;
  disclaimer?: string;
  sizing?: {
    max_safe_notional_usd?: number;
    this_trade?: { price_impact_pct?: number };
    entry_sim?: { this_trade?: { roundtrip_breakeven_pct?: number } };
    exit_sim?: { this_trade?: { slippage_pct?: number; net_recovered_usd?: number } };
  };
  [k: string]: unknown;
}

export interface TradeDecision {
  go: boolean;
  reasons: string[];
}

export declare function extractToken(text: string | null | undefined): string | null;
export declare function buildGateUrl(args?: GateArgs): string;
export declare function summarizeGate(out: GateResponse | null | undefined): string;
export declare function evaluateTrade(
  out: GateResponse | null | undefined,
  opts?: { maxBreakevenPct?: number; maxExitSlippagePct?: number }
): TradeDecision;
export declare function fetchGate(
  payFetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<GateResponse> }>,
  args?: GateArgs
): Promise<GateResponse>;
