// SLICE-254-4: pre-sign checklist (D-254-8) — every divergence aborts
// BEFORE any signature. Pure evaluation + optional on-chain simulation.
// Audit hardening (254-7, C3): tx.value must be 0 (Arc native is USDC — a
// non-zero value spends gas-token without a Transfer event), tx.data must
// be non-empty, and the swap payload is cross-checked against the
// independent findRoutes quote (amount_in / expect_amount_out / deviation).
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

/** |a-b|*1e6 / max(a,b) — relative deviation in ppm, bigint-only. */
function ppm(a: bigint, b: bigint): bigint {
  const hi = a > b ? a : b;
  if (hi === 0n) return 0n;
  const d = a > b ? a - b : b - a;
  return (d * 1_000_000n) / hi;
}

/** Max allowed |deviation_ratio| from the quote — beyond this, treat as garbage. */
const DEVIATION_BOUND = 0.5;
/** Max allowed relative drift between swap.expect_amount_out and route.amount_out. */
const EXPECT_DRIFT_PPM = 50_000n; // 5%

export function evaluateSwapSafety(args: {
  swap: ApiSwapData;
  /** Route-preview paths from findRoutes — tokenIn/Out checks (V1 swap omits paths). */
  paths: ApiRoutePath[];
  /** The independent findRoutes response — cross-checks vs swap claims (C3). */
  route: { amount_in: string; amount_out: string; deviation_ratio?: string };
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
  const { swap, cfg, signer, route } = args;
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
  // Arc native balance IS the USDC pool — a non-zero msg.value spends it
  // silently, outside any Transfer-event trail.
  checks.push(
    swap.tx.value === "0" || swap.tx.value === "0x0"
      ? yes("tx.value==0", swap.tx.value)
      : no("tx.value!=0", `calldata carries msg.value ${swap.tx.value} — would spend native USDC`),
  );
  checks.push(
    typeof swap.tx.data === "string" && swap.tx.data.length > 10
      ? yes("tx.data non-empty", `${swap.tx.data.slice(0, 10)}…`)
      : no("tx.data", "empty/short calldata"),
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
  // cross-response consistency: the executable swap claims must match the
  // independently fetched route quote (different API call, same session).
  checks.push(
    route.amount_in === swap.amount_in
      ? yes("route.amount_in==swap.amount_in", route.amount_in)
      : no("route.amount_in", `${route.amount_in} != ${swap.amount_in}`),
  );
  const drift = ppm(BigInt(swap.expect_amount_out), BigInt(route.amount_out));
  checks.push(
    drift <= EXPECT_DRIFT_PPM
      ? yes("expect≈route.amount_out", `${swap.expect_amount_out} vs ${route.amount_out} (drift ${drift}ppm)`)
      : no("expect≈route.amount_out", `drift ${drift}ppm > ${EXPECT_DRIFT_PPM}ppm`),
  );
  // audit N-M5 + N2-L4: a non-numeric deviation_ratio fails (Number("") is 0,
  // so a strict regex is required). The testnet API never reports this field
  // for EURC→USDC (verified across every live run) — absence is annotated,
  // not fatal, because route.amount_in equality and the expect-vs-route
  // drift bound below enforce the same quote-integrity purpose.
  // audit N3-L3: a NON-STRING (numeric/other JSON type) deviation_ratio is
  // treated as malformed, not "not reported" — only a string or true
  // absence gets the annotation.
  // audit N4-L3: JSON null counts as absent (some API paths emit it) —
  // only OTHER non-string types are malformed.
  if (
    route.deviation_ratio !== undefined &&
    route.deviation_ratio !== null &&
    typeof route.deviation_ratio !== "string"
  ) {
    checks.push(no("deviation_ratio", `non-string type ${typeof route.deviation_ratio} — malformed`));
  } else {
    const devRaw = typeof route.deviation_ratio === "string" ? route.deviation_ratio.trim() : "";
    if (devRaw === "") {
      checks.push(yes("deviation_ratio", "not reported by API — drift bound still enforced"));
    } else {
      const devOk =
        /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(devRaw) && Math.abs(Number(devRaw)) <= DEVIATION_BOUND;
      checks.push(
        devOk
          ? yes("deviation_ratio bounded", String(route.deviation_ratio))
          : no("deviation_ratio", `${route.deviation_ratio} malformed or |dev| > ${DEVIATION_BOUND}`),
      );
    }
  }
  checks.push(
    BigInt(swap.tx.amount_out_min) >= expectedMin && BigInt(swap.tx.amount_out_min) > 0n
      ? yes("amountOutMin>=expect*(1-slip)", `${swap.tx.amount_out_min} >= ${expectedMin}`)
      : no("amountOutMin", `${swap.tx.amount_out_min} < ${expectedMin}`),
  );
  // API returns quote_ts in epoch ms — normalize; accept ±30s clock skew,
  // reject age > 110s (deadline_secs is 120).
  const quoteTsSecs = swap.quote_ts > 1e12 ? Math.floor(swap.quote_ts / 1000) : swap.quote_ts;
  const age = args.nowSecs - quoteTsSecs;
  const fresh = age <= 110 && age >= -30;
  checks.push(
    fresh
      ? yes("deadline/freshness", `quote_ts ${swap.quote_ts} (${quoteTsSecs}s), age ${age}s`)
      : no("deadline", `stale/future quote_ts ${swap.quote_ts}, age ${age}s`),
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
