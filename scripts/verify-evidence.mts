#!/usr/bin/env bun
/**
 * verify-evidence.mts — SLICE-254-8 independent verification helper.
 * Read-only: checks journaled txHashes against on-chain receipts on Arc
 * Testnet and prints a machine-checkable verdict per claim. No signing.
 */
import { createPublicClient, http } from "viem";
import { loadSpikeConfig } from "./lib/config.mts";

const cfg = loadSpikeConfig().chains.testnet;
const client = createPublicClient({ transport: http(cfg.rpcUrl) });

const CLAIMS = [
  ["hardened-drill swap", "0x4e2669ae26291a4d6bfc37f8f3e7fdaec5440eec7f858180f1398ec5f2339006"],
  ["hardened-drill deposit", "0xa91b386fc8a2d2736302a90c63bae47fe93089314b4a715f9c2292538dbc7b51"],
  ["earlier drill swap", "0x758710f6d45427d7c3c9ed89e113bf3670bc76b6ddb2f493ba6eb82c27f36b60"],
  ["earlier drill deposit", "0xf29c17ccedc07aa12c4eeaa4398cb721b926b99528568614742519f7a3c76651"],
] as const;

const signer = process.env.SPIKE_SIGNER ?? "0x9264365408D363E7f142828f063077d7ab7C41d9";

let ok = true;
for (const [name, hash] of CLAIMS) {
  try {
    const r = await client.getTransactionReceipt({ hash });
    const fromOk = r.from.toLowerCase() === signer.toLowerCase();
    const line = `${name}: status=${r.status} from=${r.from.slice(0, 12)}… fromOK=${fromOk} block=${r.blockNumber} to=${(r.to ?? "null").slice(0, 14)}`;
    const good = r.status === "success" && fromOk;
    if (!good) ok = false;
    console.log(`${good ? "OK  " : "FAIL"} ${line}`);
  } catch (e) {
    ok = false;
    console.log(`FAIL ${name}: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
  }
}
console.log(ok ? "VERIFY: all claims check out" : "VERIFY: some claims FAILED");
process.exit(ok ? 0 : 1);
