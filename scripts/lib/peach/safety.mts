// SLICE-254-4: pre-sign checklist (D-254-8) — every divergence aborts
// BEFORE any signature. Pure evaluation + optional on-chain simulation.
import type { ApiRoutePath, ApiSwapData } from "@masterpeach/arc-aggregator-sdk";
import type { PublicClient } from "viem";
import type { ChainConfig, TokenConfig } from "../config.mts";
import { minAmountOut } from "./quotes.mts";

export interface SafetyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const yes = (name: string, detail: string): SafetyCheck => ({ name, ok: true, detail });
const no = (name: string, detail: string): SafetyCheck => ({ name, ok: false, detail });

export function evaluateSwapSafety(args: {
  swap: ApiSwapData;
  /** Route-preview paths from findRoutes — tokenIn/Out checks (V1 swap omits paths). */
  paths: ApiRoutePath[];
  cfg: ChainConfig;
  rpcChainId: number;
  signer: `0x${string}`;
  tokenIn: TokenConfig;
  tokenOut: TokenConfig;
  amountIn: bigint;
  slippageBps: number;
  nowSecs: number;
  simulatedOk: boolean | null;
}): SafetyCheck[] {
  const { swap, cfg, signer } = args;
  const checks: SafetyCheck[] = [];
  const router = swap.contracts.execution_router;
  const firstPath = args.paths[0];
  const lastPath = args.paths[args.paths.length - 1];
  const expectedMin = minAmountOut(BigInt(swap.expect_amount_out), args.slippageBps);

  checks.push(
    args.rpcChainId === cfg.chainId
      ? yes("chainId", `RPC ${args.rpcChainId}`)
      : no("chainId", `RPC ${args.rpcChainId} != ${cfg.chainId}`),
  );
  checks.push(
    eq(swap.tx.to, router)
      ? yes("tx.to==execution_router", swap.tx.to)
      : no("tx.to!=execution_router", `${swap.tx.to} vs ${router}`),
  );
  checks.push(
    eq(router, cfg.router)
      ? yes("router==config", router)
      : no("router!=config", `${router} vs ${cfg.router}`),
  );
  checks.push(
    eq(swap.payer, signer) && eq(swap.executor, signer)
      ? yes("payer/executor==signer", signer)
      : no("payer/executor", `${swap.payer}/${swap.executor} != ${signer}`),
  );
  checks.push(
    eq(swap.recipient, signer)
      ? yes("recipient==signer", swap.recipient)
      : no("recipient!=signer", `${swap.recipient} != ${signer}`),
  );
  checks.push(
    firstPath && eq(firstPath.token_in, args.tokenIn.address)
      ? yes("tokenIn allowlist", args.tokenIn.symbol)
      : no("tokenIn", `${firstPath?.token_in} != ${args.tokenIn.address}`),
  );
  checks.push(
    lastPath && eq(lastPath.token_out, args.tokenOut.address) && eq(args.tokenOut.address, cfg.vaultDepositToken)
      ? yes("tokenOut==vault USDC", args.tokenOut.symbol)
      : no("tokenOut", `${lastPath?.token_out} != ${args.tokenOut.address}`),
  );
  checks.push(
    BigInt(swap.amount_in) === args.amountIn
      ? yes("amountIn", args.amountIn.toString())
      : no("amountIn", `${swap.amount_in} != ${args.amountIn}`),
  );
  checks.push(
    BigInt(swap.tx.amount_out_min) >= expectedMin && BigInt(swap.tx.amount_out_min) > 0n
      ? yes("amountOutMin>=expect*(1-slip)", `${swap.tx.amount_out_min} >= ${expectedMin}`)
      : no("amountOutMin", `${swap.tx.amount_out_min} < ${expectedMin}`),
  );
  const fresh = args.nowSecs - swap.quote_ts <= 110;
  checks.push(
    fresh
      ? yes("deadline/freshness", `quote_ts ${swap.quote_ts}, age ${args.nowSecs - swap.quote_ts}s`)
      : no("deadline", `stale quote_ts ${swap.quote_ts}`),
  );
  checks.push(
    swap.custom_fee_bps === 0 && swap.custom_fee_amount === "0"
      ? yes("custom fee==0", "no integrator fee")
      : no("custom fee", `bps=${swap.custom_fee_bps}`),
  );
  checks.push(
    swap.execution_status === "TRANSACTION_READY" && swap.execution_mode === "DIRECT_ALLOWANCE"
      ? yes("execution", "DIRECT_ALLOWANCE ready")
      : no("execution", `${swap.execution_mode}/${swap.execution_status}`),
  );
  if (args.simulatedOk !== null) {
    checks.push(
      args.simulatedOk
        ? yes("simulation", "publicClient.call ok")
        : no("simulation", "publicClient.call reverted"),
    );
  }
  return checks;
}

export async function simulateSwap(
  client: PublicClient,
  swap: ApiSwapData,
  from: `0x${string}`,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.call({
      account: from,
      to: swap.tx.to,
      data: swap.tx.data,
      value: BigInt(swap.tx.value),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
