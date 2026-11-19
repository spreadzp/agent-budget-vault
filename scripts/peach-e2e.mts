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
import { loadSpikeConfig } from "./lib/config.mts";
import { loadState, requireStage } from "./lib/state.mts";
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

  // gates (D-254-7): e2e needs a provisioned vault; sweep is read-only;
  // resume intentionally ungated — it reconciles broken/partial states
  const state = loadState();
  if (cmd === "e2e") requireStage(state, "PROVISIONED");

  console.error(`'${cmd}' not implemented yet — see docs/EPICS/254-peach-dex-integration/slices`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
