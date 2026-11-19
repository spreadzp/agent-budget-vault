// SLICE-254-3: read-only quote sweep via findRoutes (never sends tx).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiFindRouteData } from "@masterpeach/arc-aggregator-sdk";
import { publicClientFor } from "../chain.mts";
import { EVIDENCE_DIR, type ChainConfig, type TokenConfig } from "../config.mts";
import { apiClientFor, SDK_VERSION } from "./client.mts";
import {
  artifactToJson,
  buildSweepArtifact,
  minAmountOut,
  toTokenUnits,
  type SweepArtifact,
  type SweepRun,
} from "./quotes.mts";

const SLIPPAGE_BPS = 50;
const SWEEP_DIR = join(EVIDENCE_DIR, "sweep");

function gitCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function runSweep(args: {
  cfg: ChainConfig;
  tokenIn: TokenConfig;
  tokenOut: TokenConfig;
  sizes: string[]; // decimal strings in tokenIn units
  repeats: number;
  scope: "e2e" | "probe";
  note?: string;
}): Promise<SweepArtifact> {
  const { cfg, tokenIn, tokenOut } = args;
  const api = apiClientFor(cfg);
  const client = publicClientFor(cfg);
  const runs: SweepRun[] = [];

  for (const size of args.sizes) {
    for (let rep = 0; rep < args.repeats; rep++) {
      const amountIn = toTokenUnits(size, tokenIn.decimals);
      const t0 = Date.now();
      const [data, gasPriceWei, blockNumber, status] = await Promise.all([
        api.findRoutes({ from: tokenIn.address, target: tokenOut.address, amount: amountIn }),
        client.getGasPrice(),
        client.getBlockNumber(),
        api.getStatus().catch(() => null),
      ]);
      const latencyMs = Date.now() - t0;
      const expectOut = BigInt(data.amount_out);
      runs.push({
        size,
        amountIn,
        expectAmountOut: expectOut,
        amountOutMin: minAmountOut(expectOut, SLIPPAGE_BPS),
        slippageBps: SLIPPAGE_BPS,
        latencyMs,
        gasUnits: typeof data.gas === "number" ? BigInt(data.gas) : null,
        gasPriceWei,
        blockNumber,
        requestId: data.request_id,
        quoteTs: data.quote_ts,
        deviationRatio: data.deviation_ratio,
        paths: data.paths,
        providers: [...new Set(data.paths.map((p) => p.provider))],
        statusSnapshot: status
          ? { providers: status.providers.length, executionRouter: status.arc_router.execution_router_address }
          : { providers: -1, executionRouter: "getStatus failed" },
        raw: data,
      });
    }
  }

  return buildSweepArtifact({
    scope: args.scope,
    ...(args.note ? { note: args.note } : {}),
    chainId: cfg.chainId,
    tokenIn: { symbol: tokenIn.symbol, address: tokenIn.address, decimals: tokenIn.decimals },
    tokenOut: { symbol: tokenOut.symbol, address: tokenOut.address, decimals: tokenOut.decimals },
    sizes: args.sizes,
    runs,
    sdkVersion: SDK_VERSION,
    gitCommit: gitCommit(),
    generatedAt: new Date().toISOString(),
  });
}

export function writeSweepArtifact(name: string, art: SweepArtifact): string {
  mkdirSync(SWEEP_DIR, { recursive: true });
  const path = join(SWEEP_DIR, `${name}.json`);
  writeFileSync(path, artifactToJson(art));
  return path;
}

/** Derive cirBTC sizes for USD targets from one indicative probe quote. */
export async function cirbtcUsdSizes(args: {
  cfg: ChainConfig;
  tokenIn: TokenConfig; // cirBTC 8dec
  tokenOut: TokenConfig; // USDC 6dec
  usdTargets: number[];
}): Promise<{ sizes: string[]; impliedUsdPerUnit: string }> {
  const { cfg, tokenIn, tokenOut, usdTargets } = args;
  const api = apiClientFor(cfg);
  const probeIn = 100_000n; // 0.001 cirBTC
  const data: ApiFindRouteData = await api.findRoutes({
    from: tokenIn.address,
    target: tokenOut.address,
    amount: probeIn,
  });
  const outUnits = BigInt(data.amount_out); // USDC 6dec
  // usdPerCirbtcUnit(1e-8) = out/probe scaled to USD; sizes = usd*1e8/usdPerUnit
  const sizes = usdTargets.map((usd) => {
    const units = (BigInt(Math.round(usd * 1e6)) * probeIn) / outUnits;
    const whole = units / 100_000_000n;
    const frac = (units % 100_000_000n).toString().padStart(8, "0");
    return `${whole}.${frac}`;
  });
  // USD per whole cirBTC = (outUnits/probeIn) * 1e8 sats * 1e-6 USD/unit
  const usdPerUnit = ((outUnits * 100n) / probeIn).toString();
  return { sizes, impliedUsdPerUnit: usdPerUnit };
}
