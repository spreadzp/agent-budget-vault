#!/usr/bin/env bun
/**
 * peach-e2e.mts — EPIC-254 Peach DEX integration spike CLI.
 *
 * Commands:
 *   provision  create/adopt one testnet BudgetVault via factory (SLICE-254-2)
 *   sweep      read-only quote size-sweep (SLICE-254-3)
 *   e2e        guided funding: quote+confirm → swap → verify → approve → deposit (SLICE-254-4)
 *   resume     reconcile/resume a partially completed run (SLICE-254-5)
 *   status     environment gate: RPC/chainId/factory/token metadata/SDK/signer (SLICE-254-1)
 *
 * Signer key: PRIVATE_KEY in env — only the derived address is ever logged.
 */
import { parseCommand } from "./lib/cli.mts";
import { loadSpikeConfig, type TokenConfig } from "./lib/config.mts";
import { runE2E } from "./lib/e2e.mts";
import { cirbtcUsdSizes, runSweep, writeSweepArtifact } from "./lib/peach/sweep.mts";

import { runStatus, writeEvidence } from "./lib/status.mts";
import { provision } from "./lib/vault/provisioning.mts";

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

async function main(): Promise<void> {
  const { cmd } = parseCommand(process.argv.slice(2));
  const cfg = loadSpikeConfig();

  if (cmd === "status") {
    const res = await runStatus(cfg);
    for (const c of res.checks) log(`${c.ok ? "OK  " : "FAIL"} [${c.chain}] ${c.name}: ${c.detail}`);
    const { metadataPath, gatePath } = writeEvidence(res);
    log(`evidence -> ${gatePath}`);
    log(`metadata -> ${metadataPath}`);
    log(res.ok ? "ENV GATE: OK" : "ENV GATE: FAIL");
    process.exit(res.ok ? 0 : 1);
  }

  if (cmd === "provision") {
    const r = await provision(cfg.chains.testnet);
    log(`${r.reused ? "reused" : "created"} vault ${r.vault}${r.txHash ? ` tx=${r.txHash}` : ""}`);
    log("state -> PROVISIONED; evidence -> spike-evidence/provision.json");
    return;
  }

  if (cmd === "sweep") {
    const cfgm = cfg.chains.mainnet;
    const tok = (sym: string): TokenConfig => {
      const t = cfgm.tokens.find((x) => x.symbol === sym);
      if (!t) throw new Error(`token ${sym} not in mainnet config`);
      return t;
    };
    const usdc = tok("USDC");

    const eurcArt = await runSweep({
      cfg: cfgm,
      tokenIn: tok("EURC"),
      tokenOut: usdc,
      sizes: ["5", "25", "100", "500"],
      repeats: 3,
      scope: "e2e",
    });
    const eurcPath = writeSweepArtifact("eurc", eurcArt);
    log(`EURC sweep -> ${eurcPath} (runs=${eurcArt.summary.count})`);
    for (const s of eurcArt.sizes) {
      const outs = (eurcArt.runs as { size: string; expectAmountOut: string }[])
        .filter((r) => r.size === s)
        .map((r) => BigInt(r.expectAmountOut));
      if (outs.length)
        log(`  EURC ${s}: min=${outs.reduce((a, b) => (a < b ? a : b))} max=${outs.reduce((a, b) => (a > b ? a : b))} USDC-units`);
    }

    const cir = tok("cirBTC");
    try {
      const { sizes, impliedUsdPerUnit } = await cirbtcUsdSizes({
        cfg: cfgm,
        tokenIn: cir,
        tokenOut: usdc,
        usdTargets: [5, 25, 100],
      });
      const cirArt = await runSweep({
        cfg: cfgm,
        tokenIn: cir,
        tokenOut: usdc,
        sizes,
        repeats: 1,
        scope: "probe",
        note: `indicative only: sizes ≈ 5/25/100 USD at implied ~${impliedUsdPerUnit} USD/cirBTC from probe quote; USD-equivalents approximate`,
      });
      const cirPath = writeSweepArtifact("cirbtc", cirArt);
      log(`cirBTC sweep -> ${cirPath} (runs=${cirArt.summary.count}, implied ~${impliedUsdPerUnit} USD/cirBTC)`);
    } catch (e) {
      const cirPath = writeSweepArtifact("cirbtc", {
        slice: "254-3",
        scope: "probe",
        note: `cirBTC probe failed: ${e instanceof Error ? e.message : String(e)}`,
        chainId: cfgm.chainId,
        tokenIn: { symbol: cir.symbol, address: cir.address, decimals: cir.decimals },
        tokenOut: { symbol: usdc.symbol, address: usdc.address, decimals: usdc.decimals },
        slippageBps: 50,
        sizes: [],
        sdkVersion: "",
        gitCommit: "",
        generatedAt: new Date().toISOString(),
        runs: [],
        summary: { count: 0, medianAmountOut: null, minAmountOut: null, maxAmountOut: null, medianLatencyMs: null },
      });
      log(`cirBTC probe failed (artifact ${cirPath}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  // gates (D-254-7): e2e gate lives inside runE2E (requireStage+ABORTED
  // retry); sweep is read-only; resume reconciles broken/partial states
  if (cmd === "e2e") {
    const t = await runE2E(cfg.chains.testnet);
    log(`result=${t.result} swapTx=${t.swapTx ?? "-"} depositTx=${t.depositTx ?? "-"}`);
    log(`transcript -> spike-evidence/e2e/transcript.json`);
    return;
  }

  console.error(`'${cmd}' not implemented yet — see docs/EPICS/254-peach-dex-integration/slices`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
