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
  /** true when the paid x402 gate settled; false/absent on the free-preview path. */
  paid?: boolean;
  /** present only on the free-preview degrade-open path — how to unlock paid. */
  activation?: GateActivation;
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

export interface SizingValues {
  roundtrip_breakeven_pct: number | null;
  max_safe_notional_usd: number | null;
  exit_slippage_pct: number | null;
  exit_net_recovered_usd: number | null;
}
export declare function summarizeSizing(out: GateResponse | null | undefined): string;
export declare function sizingValues(out: GateResponse | null | undefined): SizingValues | null;
export declare function evaluateTrade(
  out: GateResponse | null | undefined,
  opts?: { maxBreakevenPct?: number; maxExitSlippagePct?: number }
): TradeDecision;
export declare function fetchGate(
  payFetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<GateResponse> }>,
  args?: GateArgs
): Promise<GateResponse>;

export interface GateActivation {
  needed: boolean;
  mode: string;
  reason: string;
  hint: string;
  paid_url?: string;
  price_usdc?: string;
}

type PreviewFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<GateResponse> }>;

export declare function buildPreviewUrl(args?: GateArgs): string;
export declare function fundOnrampHint(): string;
export declare function fetchGatePreview(
  args?: GateArgs,
  opts?: { previewFetch?: PreviewFetch }
): Promise<GateResponse>;
/**
 * Fetch a gate verdict, degrading OPEN to the free preview when the paid call
 * cannot be paid (no key / unfunded wallet -> 402). Throws only when both the
 * paid route and the preview are unreachable.
 */
export declare function fetchGateOrPreview(
  payFetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<GateResponse> }>,
  args?: GateArgs,
  opts?: { hasKey?: boolean; previewFetch?: PreviewFetch }
): Promise<GateResponse>;

export interface TokenReportResponse {
  token?: string;
  chain?: string;
  token_meta?: { symbol?: string; name?: string; decimals?: number };
  security?: {
    isHoneypot?: boolean;
    sellable?: boolean;
    transferTaxBps?: number | null;
    taxMutable?: boolean;
    ownerRenounced?: boolean;
    upgradeableProxy?: boolean;
    canMint?: boolean;
    canPause?: boolean;
    hasBlacklist?: boolean;
    simStatus?: string;
    [k: string]: unknown;
  };
  liquidity?: { wethPoolUsd?: number; dex?: string; [k: string]: unknown };
  verdict?: "SAFE" | "CAUTION" | "AVOID" | string;
  risk_score?: number;
  reasons?: string[];
  analyzed_at?: string;
  disclaimer?: string;
  [k: string]: unknown;
}

export interface ReportDecision {
  safe: boolean;
  reasons: string[];
}

export interface TokenReportResult extends TokenReportResponse {
  safe: boolean;
  guard_reasons: string[];
  summary: string;
}

export declare function buildReportUrl(args?: { token: string; base?: string }): string;
export declare function summarizeReport(out: TokenReportResponse | null | undefined): string;
export declare function evaluateReport(
  out: TokenReportResponse | null | undefined,
  opts?: { maxRiskScore?: number }
): ReportDecision;
export declare function fetchTokenReport(
  payFetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<TokenReportResponse> }>,
  args?: { token: string; base?: string }
): Promise<TokenReportResponse>;
export declare function runTokenReport(
  payFetch: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<TokenReportResponse> }>,
  args?: { token: string; base?: string },
  opts?: { maxRiskScore?: number }
): Promise<TokenReportResult>;
