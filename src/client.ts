// x402-wrapped fetch: pays $0.008 USDC per /gate/swap call on Base.
// The private key is the agent's own trading wallet; it signs the x402 payment.
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

export type PayFetch = (url: string) => Promise<Response>;

let cached: PayFetch | null = null;

/**
 * Build (once) an x402-paying fetch from a hex private key.
 * Returns a plain `fetch` fallback if no key is configured — callers should
 * only hit the free `/gate/swap/preview` path in that case.
 */
export function makePayFetch(privateKey?: string): PayFetch {
  if (!privateKey) return fetch as unknown as PayFetch;
  if (cached) return cached;
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: privateKeyToAccount(privateKey as `0x${string}`),
  });
  cached = wrapFetchWithPayment(fetch, client) as unknown as PayFetch;
  return cached;
}
