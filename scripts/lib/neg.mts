// SLICE-254-5: negative-case runners — each produces an evidence artifact
// for a pre-sign gate evaluated directly (D-254-8/19).
//
// Audit note (254-7, M8): these artifacts demonstrate the CHECK firing on
// real inputs — they do not claim a full runE2E execution or a count of
// observed signatures. Fields are named to say exactly that.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EVIDENCE_DIR, loadSpikeConfig, type ChainConfig } from "./config.mts";
import { publicClientFor } from "./chain.mts";
import { apiClientFor } from "./peach/client.mts";
import { evaluateSwapSafety } from "./peach/safety.mts";
import { readBalances } from "./peach/verification.mts";

const NEG_DIR = join(EVIDENCE_DIR, "negative");
const AMOUNT = 5_000_000n;

function writeNeg(name: string, rec: Record<string, unknown>): string {
  mkdirSync(NEG_DIR, { recursive: true });
  const p = join(NEG_DIR, `${name}.json`);
  writeFileSync(p, `${JSON.stringify(rec, (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  return p;
}

/** Case 1: expired quote → deadline check fails → would abort pre-sign. */
export async function negExpiredQuote(cfg: ChainConfig, waitSecs = 0): Promise<string> {
  const api = apiClientFor(cfg);
  const eurc = cfg.tokens.find((t) => t.symbol === "EURC")!;
  const usdc = cfg.tokens.find(
    (t) => t.address.toLowerCase() === cfg.vaultDepositToken.toLowerCase(),
  )!;
  // signer address is public and required by the API to shape the response;
  // no key is used — nothing is signed or sent.
  const signer = "0x9264365408D363E7f142828f063077d7ab7C41d9" as const;
  const route = await api.findRoutes({ from: eurc.address, target: usdc.address, amount: AMOUNT });
  const swap = (await api.swap({
    from: eurc.address,
    target: usdc.address,
    amount: AMOUNT,
    executor: signer,
    payer: signer,
    recipient: signer,
    slippageBps: 50,
    deadlineSecs: 120,
  })) as import("@masterpeach/arc-aggregator-sdk").ApiSwapData;
  if (waitSecs > 0) await new Promise((r) => setTimeout(r, waitSecs * 1000));
  const nowSecs = Math.floor(Date.now() / 1000);
  const client = publicClientFor(cfg);
  const rpcChainId = await client.getChainId();
  const checks = evaluateSwapSafety({
    swap,
    paths: route.paths,
    route,
    cfg,
    rpcChainId,
    signer,
    tokenIn: eurc,
    tokenOut: usdc,
    amountIn: AMOUNT,
    slippageBps: 50,
    nowSecs,
    simulatedOk: null,
  });
  const deadline = checks.find((c) => c.name === "deadline/freshness" || c.name === "deadline")!;
  const quoteTsSecs = swap.quote_ts > 1e12 ? Math.floor(swap.quote_ts / 1000) : swap.quote_ts;
  return writeNeg("expired-quote", {
    case: "expired-quote",
    at: new Date().toISOString(),
    demonstrates: "deadline/freshness check rejects a stale quote (REQUOTE_REQUIRED semantics)",
    method: "evaluateSwapSafety on a real API quote aged past the deadline; no signing attempted",
    quoteTs: swap.quote_ts,
    evaluatedAt: nowSecs,
    quoteAgeSecs: nowSecs - quoteTsSecs,
    deadlineCheck: deadline,
    outcome: deadline.ok ? "UNEXPECTED PASS" : "check failed closed as designed",
    allChecks: checks,
  });
}

/** Case 2: insufficient EURC balance → the e2e balance gate would abort. */
export async function negInsufficientEurc(cfg: ChainConfig): Promise<string> {
  const client = publicClientFor(cfg);
  const eurc = cfg.tokens.find((t) => t.symbol === "EURC")!;
  const usdc = cfg.tokens.find(
    (t) => t.address.toLowerCase() === cfg.vaultDepositToken.toLowerCase(),
  )!;
  const empty = privateKeyToAccount(generatePrivateKey()); // address only; key discarded
  const bal = await readBalances(client, {
    owner: empty.address,
    tokenIn: eurc.address,
    tokenOut: usdc.address,
  });
  const wouldAbort = bal.in < AMOUNT;
  return writeNeg("insufficient-eurc", {
    case: "insufficient-eurc",
    at: new Date().toISOString(),
    demonstrates: "EURC balance gate is the first check in runE2E, before any quote/approve/swap",
    method: "balance read for a fresh zero-balance address; runE2E itself not executed (it would need a funded PRIVATE_KEY)",
    signer: empty.address,
    eurcBalance: bal.in.toString(),
    required: AMOUNT.toString(),
    outcome: wouldAbort
      ? "balance check fails closed as designed"
      : "UNEXPECTED: balance sufficient",
  });
}

/** Case 3: wrong chainId — client on mainnet RPC, cfg expects testnet. */
export async function negWrongChain(cfg: ChainConfig): Promise<string> {
  const all = loadSpikeConfig();
  const wrongClient = createPublicClient({
    transport: http(all.chains.mainnet.rpcUrl),
  });
  const rpcChainId = await wrongClient.getChainId();
  return writeNeg("wrong-chain", {
    case: "wrong-chain",
    at: new Date().toISOString(),
    demonstrates: "chainId pre-check compares the connected RPC to cfg.chainId before any tx",
    method: "chainId read on the mainnet endpoint vs testnet config; no tx attempted",
    rpcChainId,
    expectedChainId: cfg.chainId,
    outcome:
      rpcChainId !== cfg.chainId
        ? "chainId check fails closed as designed"
        : "UNEXPECTED PASS",
  });
}
