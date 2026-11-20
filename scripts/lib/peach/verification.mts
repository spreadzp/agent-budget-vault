// SLICE-254-4: independent post-swap provenance (D-254-9) —
// receipt.status + Transfer events + balance delta. SDK output is
// never the sole proof. Audit hardening (254-7): receipt is bound to
// signer+router, and balance checks may be marked `skipped` (not ok)
// when journaled/archive balances are unavailable on resume.
import type { PublicClient, TransactionReceipt } from "viem";
import { ERC20_ABI } from "../chain.mts";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddr = (t: string) => `0x${t.slice(26).toLowerCase()}`;

export interface VerifyCheck {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail: string;
}

export interface SwapVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  inReceived: bigint; // tokenOut units received by signer (event-derived)
  outSpent: bigint; // tokenIn units sent by signer
}

export function verifySwap(args: {
  receipt: TransactionReceipt;
  signer: `0x${string}`;
  /** receipt.to must equal this (router) — audit M5 */
  expectedTo: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  amountOutMin: bigint;
  /**
   * Balances before/after the swap. Set either to null when not measurable
   * (resume without journal/archive read) — the delta checks are then marked
   * `skipped` rather than tautologically "ok" (audit H3).
   */
  balanceBefore: { in: bigint; out: bigint } | null;
  balanceAfter: { in: bigint; out: bigint } | null;
  /**
   * gasCost in native wei (receipt.gasUsed * effectiveGasPrice) — required
   * when tokenOut is the gas-paying native token (Arc USDC): gas is deducted
   * from the ERC20-mirrored balance with no Transfer event.
   */
  gasCostNative?: bigint;
}): SwapVerifyResult {
  const checks: VerifyCheck[] = [];
  const sig = args.signer.toLowerCase();
  const { receipt } = args;

  checks.push({
    name: "receipt.status",
    ok: receipt.status === "success",
    detail: receipt.status,
  });
  checks.push({
    name: "receipt.from==signer",
    ok: (receipt.from ?? "").toLowerCase() === sig,
    detail: `${receipt.from}`,
  });
  checks.push({
    name: "receipt.to==router",
    ok: (receipt.to ?? "").toLowerCase() === args.expectedTo.toLowerCase(),
    detail: `${receipt.to} vs ${args.expectedTo}`,
  });

  let outSpent = 0n;
  let inReceived = 0n;
  for (const log of receipt.logs) {
    // audit H1: ERC-721-shaped Transfer logs (4 topics, data "0x") must not
    // crash verification — filter token+shape BEFORE parsing the value.
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
    const token = log.address.toLowerCase();
    if (token !== args.tokenIn.toLowerCase() && token !== args.tokenOut.toLowerCase()) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    const from = topicAddr(log.topics[1]!);
    const to = topicAddr(log.topics[2]!);
    const value = BigInt(log.data);
    if (token === args.tokenIn.toLowerCase() && from === sig) outSpent += value;
    if (token === args.tokenOut.toLowerCase() && to === sig) inReceived += value;
  }

  checks.push({
    name: "Transfer(tokenIn) signer out",
    ok: outSpent > 0n && outSpent <= args.amountIn,
    detail: `${outSpent} (amount_in ${args.amountIn})`,
  });
  checks.push({
    name: "Transfer(tokenOut) signer in >= amountOutMin",
    ok: inReceived >= args.amountOutMin,
    detail: `${inReceived} >= ${args.amountOutMin}`,
  });

  if (args.balanceBefore === null || args.balanceAfter === null) {
    // audit N-M6: ok:false + skipped:true — a naive `.ok` filter cannot
    // mistake a skipped check for a passed one; the aggregator below
    // treats skipped as non-blocking.
    checks.push(
      {
        name: "delta tokenIn == events",
        ok: false,
        skipped: true,
        detail: "skipped — balances not measurable post-hoc (no journal/archive)",
      },
      {
        name: "delta tokenOut == events - gas",
        ok: false,
        skipped: true,
        detail: "skipped — balances not measurable post-hoc (no journal/archive)",
      },
    );
  } else {
    const deltaIn = args.balanceBefore.in - args.balanceAfter.in;
    const deltaOut = args.balanceAfter.out - args.balanceBefore.out;
    checks.push({
      name: "delta tokenIn == events",
      ok: deltaIn === outSpent,
      detail: `delta ${deltaIn} vs events ${outSpent}`,
    });
    // Arc USDC is the gas token: delta = events - gasCost(wei)/1e12 (±4 units
    // 6-dec rounding). tokenIn is never the gas token — strict equality.
    const gasErc20 = args.gasCostNative === undefined ? 0n : args.gasCostNative / 1_000_000_000_000n;
    const expectedDeltaOut = inReceived - gasErc20;
    const gasTol = 4n;
    const deltaDiff = deltaOut > expectedDeltaOut ? deltaOut - expectedDeltaOut : expectedDeltaOut - deltaOut;
    checks.push({
      name: "delta tokenOut == events - gas",
      ok: deltaDiff <= gasTol,
      detail: `delta ${deltaOut} vs events ${inReceived} - gas ${gasErc20} (±${gasTol})`,
    });
  }

  return {
    ok: checks.every((c) => c.skipped === true || c.ok),
    checks,
    inReceived,
    outSpent,
  };
}

export async function readBalances(
  client: PublicClient,
  args: { owner: `0x${string}`; tokenIn: `0x${string}`; tokenOut: `0x${string}` },
): Promise<{ in: bigint; out: bigint }> {
  const [inB, outB] = await Promise.all([
    client.readContract({
      address: args.tokenIn,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [args.owner],
    }),
    client.readContract({
      address: args.tokenOut,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [args.owner],
    }),
  ]);
  return { in: inB, out: outB };
}

/** Balances at a historical block — null when the RPC has no archive state. */
export async function readBalancesAt(
  client: PublicClient,
  args: { owner: `0x${string}`; tokenIn: `0x${string}`; tokenOut: `0x${string}` },
  blockNumber: bigint,
): Promise<{ in: bigint; out: bigint } | null> {
  try {
    const [inB, outB] = await Promise.all([
      client.readContract({
        address: args.tokenIn,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [args.owner],
        blockNumber,
      }),
      client.readContract({
        address: args.tokenOut,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [args.owner],
        blockNumber,
      }),
    ]);
    return { in: inB, out: outB };
  } catch {
    return null;
  }
}
