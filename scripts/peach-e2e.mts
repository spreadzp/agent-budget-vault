#!/usr/bin/env bun
/**
 * peach-e2e.mts — EPIC-254 Peach DEX integration spike CLI.
 *
 * Commands:
 *   provision  create a fresh testnet BudgetVault via factory (SLICE-254-2)
 *   sweep      read-only quote size-sweep (SLICE-254-3)
 *   e2e        guided funding: quote+confirm → swap → verify → approve → deposit (SLICE-254-4)
 *   resume     reconcile/resume a partially completed run (SLICE-254-5)
 *   status     environment gate: RPC/chainId/factory/token metadata/SDK/signer (SLICE-254-1)
 *
 * Runner (env convention, see swap-rescue.mts):
 *   bun --env-file .env [--env-file ../contracts/.env --env-file ../hackathon/server/.env] \
 *     scripts/peach-e2e.mts <cmd>
 *
 * Signer key: PRIVATE_KEY in env — only the derived address is ever logged.
 */
import { parseCommand } from "./lib/cli.mts";
import { loadSpikeConfig } from "./lib/config.mts";
import { runStatus, writeEvidence } from "./lib/status.mts";

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

async function main(): Promise<void> {
  const { cmd } = parseCommand(process.argv.slice(2));

  if (cmd === "status") {
    const cfg = loadSpikeConfig();
    const res = await runStatus(cfg);
    for (const c of res.checks) log(`${c.ok ? "OK  " : "FAIL"} [${c.chain}] ${c.name}: ${c.detail}`);
    const { metadataPath, gatePath } = writeEvidence(res);
    log(`evidence -> ${gatePath}`);
    log(`metadata -> ${metadataPath}`);
    log(res.ok ? "ENV GATE: OK" : "ENV GATE: FAIL");
    process.exit(res.ok ? 0 : 1);
  }

  console.error(`'${cmd}' not implemented yet — see docs/EPICS/254-peach-dex-integration/slices`);
  process.exit(2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
