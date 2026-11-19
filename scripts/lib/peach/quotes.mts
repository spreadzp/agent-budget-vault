// SLICE-254-3: sweep helpers — pure bigint math + artifact shaping.
// Money values are bigint everywhere; JSON boundary serializes as strings.
import type { ApiFindRouteData } from "@masterpeach/arc-aggregator-sdk";

export function toTokenUnits(decimal: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new Error(`bad decimal amount: ${decimal}`);
  const frac = (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac === "" ? 0 : frac);
}

export function minAmountOut(expectOut: bigint, slippageBps: number): bigint {
  return (expectOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface SweepRun {
  size: string;
  amountIn: bigint;
  expectAmountOut: bigint;
  amountOutMin: bigint;
  slippageBps: number;
  latencyMs: number;
  gasUnits: bigint | null;
  gasPriceWei: bigint;
  blockNumber: bigint;
  requestId: string;
  quoteTs: number;
  deviationRatio: string;
  paths: ApiFindRouteData["paths"];
  providers: string[];
  statusSnapshot: { providers: number; executionRouter: string };
  raw: ApiFindRouteData;
}

export interface SweepSummary {
  count: number;
  medianAmountOut: bigint | null;
  minAmountOut: bigint | null;
  maxAmountOut: bigint | null;
  medianLatencyMs: number | null;
}

function medianBigInt(xs: bigint[]): bigint | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2n;
}
function medianNum(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.floor((s[mid - 1] + s[mid]) / 2);
}

export function summarizeRuns(
  runs: Pick<SweepRun, "expectAmountOut" | "latencyMs">[],
): SweepSummary {
  const outs = runs.map((r) => r.expectAmountOut);
  return {
    count: runs.length,
    medianAmountOut: medianBigInt(outs),
    minAmountOut: outs.length ? outs.reduce((a, b) => (a < b ? a : b)) : null,
    maxAmountOut: outs.length ? outs.reduce((a, b) => (a > b ? a : b)) : null,
    medianLatencyMs: medianNum(runs.map((r) => r.latencyMs)),
  };
}

export interface SweepArtifact {
  slice: string;
  scope: "e2e" | "probe";
  note?: string;
  chainId: number;
  tokenIn: { symbol: string; address: string; decimals: number };
  tokenOut: { symbol: string; address: string; decimals: number };
  slippageBps: number;
  sizes: string[];
  sdkVersion: string;
  gitCommit: string;
  generatedAt: string;
  runs: unknown[];
  summary: {
    count: number;
    medianAmountOut: string | null;
    minAmountOut: string | null;
    maxAmountOut: string | null;
    medianLatencyMs: number | null;
  };
}

export function buildSweepArtifact(args: {
  scope: "e2e" | "probe";
  note?: string;
  chainId: number;
  tokenIn: { symbol: string; address: string; decimals: number };
  tokenOut: { symbol: string; address: string; decimals: number };
  sizes: string[];
  runs: SweepRun[];
  sdkVersion: string;
  gitCommit: string;
  generatedAt: string;
}): SweepArtifact {
  const runs = args.runs.map((r) => ({
    size: r.size,
    amountIn: r.amountIn.toString(),
    tokenInDecimals: args.tokenIn.decimals,
    expectAmountOut: r.expectAmountOut.toString(),
    amountOutMin: r.amountOutMin.toString(),
    slippageBps: r.slippageBps,
    tokenOutDecimals: args.tokenOut.decimals,
    latencyMs: r.latencyMs,
    gasUnits: r.gasUnits === null ? null : r.gasUnits.toString(),
    gasPriceWei: r.gasPriceWei.toString(),
    blockNumber: r.blockNumber.toString(),
    requestId: r.requestId,
    quoteTs: r.quoteTs,
    deviationRatio: r.deviationRatio,
    providers: r.providers,
    paths: r.paths,
    priceImpact: null,
    priceImpactReason: "SDK 1.2.1 findRoutes response has no priceImpact field",
    statusSnapshot: r.statusSnapshot,
    raw: r.raw,
  }));
  const raw = summarizeRuns(runs.map((r) => ({ expectAmountOut: BigInt(r.expectAmountOut), latencyMs: r.latencyMs })));
  const summary = {
    count: raw.count,
    medianAmountOut: raw.medianAmountOut === null ? null : raw.medianAmountOut.toString(),
    minAmountOut: raw.minAmountOut === null ? null : raw.minAmountOut.toString(),
    maxAmountOut: raw.maxAmountOut === null ? null : raw.maxAmountOut.toString(),
    medianLatencyMs: raw.medianLatencyMs,
  };
  return {
    slice: "254-3",
    scope: args.scope,
    ...(args.note ? { note: args.note } : {}),
    chainId: args.chainId,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    slippageBps: 50,
    sizes: args.sizes,
    sdkVersion: args.sdkVersion,
    gitCommit: args.gitCommit,
    generatedAt: args.generatedAt,
    runs,
    summary,
  };
}

const bigintReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
export function artifactToJson(art: SweepArtifact): string {
  return `${JSON.stringify(art, bigintReplacer, 2)}\n`;
}
