import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // Keep peer/runtime deps external so the agent host resolves its own copies.
  external: ["@elizaos/core", "@x402/core", "@x402/evm", "@x402/fetch", "viem"],
});
