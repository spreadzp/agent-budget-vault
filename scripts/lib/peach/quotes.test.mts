import { describe, expect, test } from "bun:test";
import {
  buildSweepArtifact,
  minAmountOut,
  summarizeRuns,
  toTokenUnits,
} from "./quotes.mts";

describe("toTokenUnits", () => {
  test("decimal strings to bigint units, no float", () => {
    expect(toTokenUnits("5", 6)).toBe(5000000n);
    expect(toTokenUnits("0.0001", 8)).toBe(10000n);
    expect(toTokenUnits("25.5", 6)).toBe(25500000n);
  });
});

describe("minAmountOut", () => {
  test("slippage bps applied as bigint math", () => {
    expect(minAmountOut(1_000_000n, 50)).toBe(995_000n);
    expect(minAmountOut(999n, 50)).toBe(994n);
  });
});

describe("summarizeRuns", () => {
  const run = (out: bigint) => ({
    expectAmountOut: out,
    amountOutMin: out - 1n,
    latencyMs: 10,
    gasUnits: 1n,
  });
  test("median/range over expectAmountOut", () => {
    const s = summarizeRuns([run(100n), run(102n), run(98n)]);
    expect(s.medianAmountOut).toBe(100n);
    expect(s.minAmountOut).toBe(98n);
    expect(s.maxAmountOut).toBe(102n);
    expect(s.count).toBe(3);
  });
  test("empty → nulls", () => {
    const s = summarizeRuns([]);
    expect(s.medianAmountOut).toBeNull();
    expect(s.count).toBe(0);
  });
});

describe("buildSweepArtifact", () => {
  test("required fields + bigint serialized as strings + priceImpact null-reason", () => {
    const art = buildSweepArtifact({
      scope: "e2e",
      chainId: 5042,
      tokenIn: { symbol: "EURC", address: "0xbef5", decimals: 6 },
      tokenOut: { symbol: "USDC", address: "0x3600", decimals: 6 },
      sizes: ["5"],
      runs: [
        {
          size: "5",
          amountIn: 5000000n,
          expectAmountOut: 4990000n,
          amountOutMin: 4965050n,
          slippageBps: 50,
          latencyMs: 42,
          gasUnits: 21000n,
          gasPriceWei: 5n,
          blockNumber: 123n,
          requestId: "r1",
          quoteTs: 1,
          deviationRatio: "0.001",
          paths: [],
          providers: ["LAUNCHPAD"],
          statusSnapshot: { providers: 20 },
          raw: { amount_out: "4990000" },
        },
      ],
      sdkVersion: "1.2.1",
      gitCommit: "abc",
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const json = JSON.parse(JSON.stringify(art)) as Record<string, unknown>;
    expect(json.chainId).toBe(5042);
    expect(json.sdkVersion).toBe("1.2.1");
    const r0 = (json.runs as Record<string, unknown>[])[0]!;
    expect(r0.amountIn).toBe("5000000");
    expect(r0.expectAmountOut).toBe("4990000");
    expect(r0.priceImpact).toBeNull();
    expect(String(r0.priceImpactReason)).toMatch(/priceImpact/i);
    expect(r0.blockNumber).toBe("123");
    expect(json.summary).toBeDefined();
  });
});
