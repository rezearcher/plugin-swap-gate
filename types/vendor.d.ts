// Minimal ambient declarations for offline typechecking only.
// At real build time the installed @elizaos/core, @x402/* and viem packages
// provide the authoritative types; this file is excluded from the npm build
// (it is referenced solely by tsconfig.check.json).

declare module "@elizaos/core" {
  export interface Content {
    text?: string;
    actions?: string[];
    [k: string]: unknown;
  }
  export interface Memory {
    content?: Content;
    [k: string]: unknown;
  }
  export interface State {
    [k: string]: unknown;
  }
  export interface IAgentRuntime {
    getSetting(key: string): string | undefined;
    [k: string]: unknown;
  }
  export type HandlerCallback = (content: Content) => Promise<unknown> | unknown;
  export interface ActionResult {
    success: boolean;
    text?: string;
    values?: Record<string, unknown>;
    data?: Record<string, unknown>;
    error?: Error;
  }
  export interface ActionExample {
    name: string;
    content: Content;
  }
  export interface Action {
    name: string;
    similes?: string[];
    description: string;
    validate: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<boolean>;
    handler: (
      runtime: IAgentRuntime,
      message: Memory,
      state?: State,
      options?: Record<string, unknown>,
      callback?: HandlerCallback
    ) => Promise<ActionResult>;
    examples?: ActionExample[][];
  }
  export interface Plugin {
    name: string;
    description: string;
    actions?: Action[];
    providers?: unknown[];
    services?: unknown[];
    init?: (config: Record<string, unknown>, runtime: IAgentRuntime) => Promise<void> | void;
  }
}

declare module "@x402/fetch" {
  export function wrapFetchWithPayment(f: typeof fetch, client: unknown): typeof fetch;
}
declare module "@x402/core/client" {
  export class x402Client {}
}
declare module "@x402/evm/exact/client" {
  export function registerExactEvmScheme(client: unknown, opts: { signer: unknown }): void;
}
declare module "viem/accounts" {
  export function privateKeyToAccount(key: `0x${string}`): unknown;
}
