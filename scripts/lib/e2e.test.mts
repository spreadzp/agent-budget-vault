import { describe, expect, test } from "bun:test";
import type { ApiSwapData } from "@masterpeach/arc-aggregator-sdk";
import type { TransactionReceipt } from "viem";
import { evaluateSwapSafety } from "./peach/safety.mts";
import { verifySwap } from "./peach/verification.mts";
import type { ChainConfig, TokenConfig } from "./config.mts";

const SIGNER = "0x9264365408D363E7f142828f063077d7ab7C41d9" as `0x${string}`;
const ROUTER = "0x5FF56925140D6f5912C8Ca6593f2C3BC28190607" as `0x${string}`;
const EURC = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a" as `0x${string}`;
const USDC = "0x3600000000000000000000000000000000000000" as `0x${string}`;
const NOW = Math.floor(Date.now() / 1000);

const cfg = {
  chainId: 5042002,
  router: ROUTER,
  vaultDepositToken: USDC,
} as unknown as ChainConfig;
const tokIn = { symbol: "EURC", address: EURC, decimals: 6, scope: "e2e" } as TokenConfig;
const tokOut = { symbol: "USDC", address: USDC, decimals: 6, scope: "e2e" } as TokenConfig;

function swap(over: Partial<ApiSwapData> = {}): ApiSwapData {
  return {
    request_id: "r1",
    quote_id: "0x01",
    quote_ts: (NOW - 30) * 1000,
    amount_in: "5000000",
    amount_out: "5490000",
    expect_amount_out: "5490000",
    custom_fee_bps: 0,
    custom_fee_amount: "0",
    integrator_fee_amount: "0",
    protocol_fee_amount: "0",
    protocol_cut_bps: 0,
    custom_fee_receiver: "0x0000000000000000000000000000000000000000",
    deviation_ratio: "0",
    paths: [
      {
        provider: "LAUNCHPAD",
        pool: "0x00000000000000000000000000000000000000aa",
        adapter: "0x00000000000000000000000000000000000000bb",
        token_in: EURC,
        token_out: USDC,
        direction: true,
        fee_rate: "0",
        amount_in: "5000000",
        amount_out: "5490000",
      },
    ],
    contracts: { execution_router: ROUTER },
    gas: 200000,
    execution_mode: "DIRECT_ALLOWANCE",
    execution_status: "TRANSACTION_READY",
    plan_hash: "0x02",
    aggregator_signature: "0x03",
    aggregator_signer: "0x00000000000000000000000000000000000000cc",
    payer: SIGNER,
    executor: SIGNER,
    recipient: SIGNER,
    tx: {
      to: ROUTER,
      data: "0xa9059cbb0000000000000000000000009264365408d363e7f142828f063077d7ab7c41d9",
      value: "0",
      entrypoint: "executePlan",
      amount_out_min: "5462550",
    },
    ...over,
  };
}

const routeFixture = {
  amount_in: "5000000",
  amount_out: "5490000",
  deviation_ratio: "-0.00036348",
};

const base = (s: ApiSwapData) => ({
  swap: s,
  paths: s.paths,
  route: routeFixture,
  cfg,
  rpcChainId: 5042002,
  signer: SIGNER,
  tokenIn: tokIn,
  tokenOut: tokOut,
  amountIn: 5000000n,
  slippageBps: 50,
  nowSecs: NOW,
  simulatedOk: null,
});

const names = (cs: { name: string; ok: boolean }[]) =>
  cs.filter((c) => !c.ok).map((c) => c.name);

describe("evaluateSwapSafety", () => {
  test("happy: all checks pass", () => {
    const cs = evaluateSwapSafety(base(swap()));
    expect(names(cs)).toEqual([]);
  });
  test("wrong router fails", () => {
    const s = swap({ contracts: { execution_router: "0x0000000000000000000000000000000000000099" } });
    expect(names(evaluateSwapSafety(base(s)))).toContain("router!=config");
    expect(names(evaluateSwapSafety(base(s)))).toContain("tx.to!=execution_router");
  });
  test("recipient != signer fails", () => {
    const s = swap({ recipient: "0x00000000000000000000000000000000000000dd" });
    expect(names(evaluateSwapSafety(base(s)))).toContain("recipient!=signer");
  });
  test("amountOutMin below slippage-bound fails", () => {
    const s = swap({ tx: { ...swap().tx, amount_out_min: "1000" } });
    expect(names(evaluateSwapSafety(base(s)))).toContain("amountOutMin");
  });
  test("stale quote fails deadline", () => {
    const s = swap({ quote_ts: (NOW - 500) * 1000 });
    expect(names(evaluateSwapSafety(base(s)))).toContain("deadline");
  });
  test("tokenIn not allowlisted fails", () => {
    const s = swap({
      paths: [{ ...swap().paths[0], token_in: "0x00000000000000000000000000000000000000ee" }],
    });
    expect(names(evaluateSwapSafety(base(s)))).toContain("tokenIn");
  });
  // audit C3: signed-payload checks
  test("non-zero tx.value fails (native USDC spend)", () => {
    const s = swap({ tx: { ...swap().tx, value: "1000000" } });
    expect(names(evaluateSwapSafety(base(s)))).toContain("tx.value!=0");
  });
  test("empty calldata fails", () => {
    const s = swap({ tx: { ...swap().tx, data: "0x" } });
    expect(names(evaluateSwapSafety(base(s)))).toContain("tx.data");
  });
  test("route amount_in mismatch fails (cross-response)", () => {
    const a = { ...base(swap()), route: { ...routeFixture, amount_in: "4999999" } };
    expect(names(evaluateSwapSafety(a))).toContain("route.amount_in");
  });
  test("expect_amount_out drift > 5% vs route fails", () => {
    const s = swap({ expect_amount_out: "6000000" });
    expect(names(evaluateSwapSafety(base(s)))).toContain("expect≈route.amount_out");
  });
  test("malformed/huge deviation_ratio fails", () => {
    const a = { ...base(swap()), route: { ...routeFixture, deviation_ratio: "1.7" } };
    expect(names(evaluateSwapSafety(a))).toContain("deviation_ratio");
  });
});

// ---- verifySwap on fabricated receipt ----
const T = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}`;
const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
function transferLog(token: string, from: string, to: string, v: bigint) {
  return {
    address: token,
    topics: [T, pad(from), pad(to)] as [`0x${string}`, ...`0x${string}`[]],
    data: hex(v),
  } as unknown as TransactionReceipt["logs"][number];
}
const receipt = (logs: TransactionReceipt["logs"], status = "success") =>
  ({ status, logs, from: SIGNER, to: ROUTER }) as unknown as TransactionReceipt;

describe("verifySwap", () => {
  const good = verifySwap({
    receipt: receipt([
      transferLog(EURC, SIGNER, ROUTER, 5000000n),
      transferLog(USDC, ROUTER, SIGNER, 5490000n),
    ]),
    signer: SIGNER,
    expectedTo: ROUTER,
    tokenIn: EURC,
    tokenOut: USDC,
    amountIn: 5000000n,
    amountOutMin: 5462550n,
    balanceBefore: { in: 20_000_000n, out: 1_000_000n },
    balanceAfter: { in: 15_000_000n, out: 6_490_000n },
  });
  test("happy: ok, in/out computed", () => {
    expect(good.ok).toBe(true);
    expect(good.inReceived).toBe(5490000n);
    expect(good.outSpent).toBe(5000000n);
  });
  test("reverted receipt fails", () => {
    const r = verifySwap({
      receipt: receipt([], "reverted"),
      signer: SIGNER,
      expectedTo: ROUTER,
      tokenIn: EURC,
      tokenOut: USDC,
      amountIn: 5000000n,
      amountOutMin: 1n,
      balanceBefore: { in: 0n, out: 0n },
      balanceAfter: { in: 0n, out: 0n },
    });
    expect(r.ok).toBe(false);
  });
  test("gas cost accounted: delta = events - gas within tolerance", () => {
    // Arc: 18,038,666 event vs 18,024,486 delta; gas 14,179,275,000,000,000 wei
    const r = verifySwap({
      receipt: receipt([
        transferLog(EURC, SIGNER, ROUTER, 5000000n),
        transferLog(USDC, ROUTER, SIGNER, 18038666n),
      ]),
      signer: SIGNER,
      expectedTo: ROUTER,
      tokenIn: EURC,
      tokenOut: USDC,
      amountIn: 5000000n,
      amountOutMin: 17948472n,
      balanceBefore: { in: 20_000_000n, out: 19_000_000n },
      balanceAfter: { in: 15_000_000n, out: 37_024_486n },
      gasCostNative: 14179275000000000n,
    });
    expect(r.ok).toBe(true);
  });
  // audit H3: unmeasurable deltas are skipped, not tautologically ok
  test("null balances → delta checks skipped (not ok-faked)", () => {
    const r = verifySwap({
      receipt: receipt([
        transferLog(EURC, SIGNER, ROUTER, 5000000n),
        transferLog(USDC, ROUTER, SIGNER, 5490000n),
      ]),
      signer: SIGNER,
      expectedTo: ROUTER,
      tokenIn: EURC,
      tokenOut: USDC,
      amountIn: 5000000n,
      amountOutMin: 5462550n,
      balanceBefore: null,
      balanceAfter: null,
    });
    expect(r.ok).toBe(true); // events+receipt still prove the swap
    const delta = r.checks.filter((c) => c.name.startsWith("delta"));
    expect(delta.length).toBe(2);
    expect(delta.every((c) => c.skipped === true)).toBe(true);
  });
  test("receipt.from != signer fails (M5 binding)", () => {
    const r = verifySwap({
      receipt: {
        ...receipt([transferLog(USDC, ROUTER, SIGNER, 5490000n)]),
        from: "0x00000000000000000000000000000000000000ff",
      } as TransactionReceipt,
      signer: SIGNER,
      expectedTo: ROUTER,
      tokenIn: EURC,
      tokenOut: USDC,
      amountIn: 5000000n,
      amountOutMin: 1n,
      balanceBefore: null,
      balanceAfter: null,
    });
    expect(r.checks.find((c) => c.name === "receipt.from==signer")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });
  // audit H1: ERC-721-shaped Transfer (4 topics, data "0x") must not crash
  test("ERC-721-shaped log does not crash verifySwap", () => {
    const nftLog = {
      address: "0x00000000000000000000000000000000000000aa",
      topics: [T, pad(SIGNER), pad(ROUTER), pad("0x0000000000000000000000000000000000000001")] as [
        `0x${string}`,
        ...`0x${string}`[],
      ],
      data: "0x",
    } as unknown as TransactionReceipt["logs"][number];
    const r = verifySwap({
      receipt: receipt([
        nftLog,
        transferLog(EURC, SIGNER, ROUTER, 5000000n),
        transferLog(USDC, ROUTER, SIGNER, 5490000n),
      ]),
      signer: SIGNER,
      expectedTo: ROUTER,
      tokenIn: EURC,
      tokenOut: USDC,
      amountIn: 5000000n,
      amountOutMin: 5462550n,
      balanceBefore: null,
      balanceAfter: null,
    });
    expect(r.ok).toBe(true);
    expect(r.inReceived).toBe(5490000n);
  });
  test("event-delta mismatch fails (fraud-proof)", () => {
    const r = verifySwap({
      receipt: receipt([transferLog(USDC, ROUTER, SIGNER, 5490000n)]),
      signer: SIGNER,
      expectedTo: ROUTER,
      tokenIn: EURC,
      tokenOut: USDC,
      amountIn: 5000000n,
      amountOutMin: 1n,
      balanceBefore: { in: 20_000_000n, out: 1_000_000n },
      balanceAfter: { in: 15_000_000n, out: 7_000_000n }, // delta 6M != event 5.49M
    });
    expect(r.ok).toBe(false);
  });
});
