import { describe, expect, test } from "bun:test";
import { loadSpikeConfig, validateSpikeConfig } from "./config.mts";

describe("peach-spike config", () => {
  const cfg = loadSpikeConfig();

  test("has testnet 5042002 and mainnet 5042", () => {
    expect(cfg.chains.testnet.chainId).toBe(5042002);
    expect(cfg.chains.mainnet.chainId).toBe(5042);
  });

  test("every token: 0x address + e2e|probe scope + int decimals", () => {
    for (const ch of Object.values(cfg.chains)) {
      for (const t of ch.tokens) {
        expect(t.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(["e2e", "probe"]).toContain(t.scope);
        expect(Number.isInteger(t.decimals)).toBe(true);
      }
    }
  });

  test("vaultDepositToken is among the chain's tokens", () => {
    for (const ch of Object.values(cfg.chains)) {
      const hit = ch.tokens.some(
        (t) => t.address.toLowerCase() === ch.vaultDepositToken.toLowerCase(),
      );
      expect(hit).toBe(true);
    }
  });

  test("validateSpikeConfig rejects malformed input", () => {
    expect(() => validateSpikeConfig({ chains: {} })).toThrow(/testnet|mainnet/);
    expect(() => validateSpikeConfig(null)).toThrow();
  });
});
