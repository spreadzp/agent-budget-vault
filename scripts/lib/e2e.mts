// SLICE-254-4: guided happy-path — 5 EURC → swap → verify → approve → deposit.
// FSM: QUOTED → SWAP_SUBMITTED → SWAP_VERIFIED → APPROVE_* → DEPOSIT_* → DEPOSITED.
// Any failed check aborts before the next signature.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ApiSwapData } from "@masterpeach/arc-aggregator-sdk";
import { chainOf, ERC20_ABI, publicClientFor, VAULT_ABI } from "./chain.mts";
import { EVIDENCE_DIR, type ChainConfig } from "./config.mts";
import { requiredEnv } from "./env.mts";
import { apiClientFor } from "./peach/client.mts";
import { evaluateSwapSafety, simulateSwap, type SafetyCheck } from "./peach/safety.mts";
import { readBalances, verifySwap } from "./peach/verification.mts";
import { advance, loadState, requireStage, saveState, type SpikeState } from "./state.mts";
import { submitGuarded } from "./tx.mts";
import { verifyDeposit } from "./vault/deposit.mts";

const E2E_DIR = join(EVIDENCE_DIR, "e2e");
const TRANSCRIPT_PATH = join(E2E_DIR, "transcript.json");
const E2E_AMOUNT_IN = 5_000_000n; // 5 EURC, 6 dec (D-254-17)
const SLIPPAGE_BPS = 50;
const DEADLINE_SECS = 120;

interface Transcript {
  at: string;
  vault: `0x${string}`;
  signer: `0x${string}`;
  amountIn: string;
  safetyChecks: SafetyCheck[];
  swapTx?: `0x${string}`;
  approveTxs: { step: string; txHash: `0x${string}` }[];
  depositTx?: `0x${string}`;
  verifyChecks: Record<string, { name: string; ok: boolean; detail: string }[]>;
  result?: string;
}

function writeTranscript(t: Transcript): string {
  mkdirSync(E2E_DIR, { recursive: true });
  writeFileSync(
    TRANSCRIPT_PATH,
    `${JSON.stringify(t, (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
  );
  return TRANSCRIPT_PATH;
}

const fail = (t: Transcript, state: SpikeState, msg: string): never => {
  t.result = `ABORTED: ${msg}`;
  writeTranscript(t);
  if (state.stage !== "ABORTED" && state.stage !== "DEPOSITED") {
    try {
      saveState(advance(state, "ABORTED", msg));
    } catch {
      saveState(state);
    }
  }
  throw new Error(msg);
};

export async function runE2E(cfg: ChainConfig): Promise<Transcript> {
  let state = loadState();
  if (state.stage === "ABORTED") {
    state = advance(state, "PROVISIONED", "retry after abort");
    saveState(state);
  }
  requireStage(state, "PROVISIONED");
  if (state.stage !== "PROVISIONED" && state.stage !== "QUOTED") {
    throw new Error(`stage ${state.stage} already past quote — use 'resume' to reconcile`);
  }
  const vault = state.vault!;
  const client = publicClientFor(cfg);
  const api = apiClientFor(cfg);
  const account = privateKeyToAccount(
    (requiredEnv("PRIVATE_KEY").startsWith("0x")
      ? requiredEnv("PRIVATE_KEY")
      : `0x${requiredEnv("PRIVATE_KEY")}`) as `0x${string}`,
  );
  const signer = account.address;
  const wallet = createWalletClient({ account, chain: chainOf(cfg), transport: http(cfg.rpcUrl) });

  const eurc = cfg.tokens.find((t) => t.symbol === "EURC" && t.scope === "e2e");
  const usdc = cfg.tokens.find(
    (t) => t.address.toLowerCase() === cfg.vaultDepositToken.toLowerCase(),
  );
  if (!eurc || !usdc) throw new Error("config missing EURC(e2e)/vault USDC token");

  const t: Transcript = {
    at: new Date().toISOString(),
    vault,
    signer,
    amountIn: E2E_AMOUNT_IN.toString(),
    safetyChecks: [],
    approveTxs: [],
    verifyChecks: {},
  };

  // ---- balances + quote ----
  const before = await readBalances(client, {
    owner: signer,
    tokenIn: eurc.address,
    tokenOut: usdc.address,
  });
  if (before.in < E2E_AMOUNT_IN)
    fail(t, state, `EURC balance ${before.in} < required ${E2E_AMOUNT_IN}`);

  const route = await api.findRoutes({
    from: eurc.address,
    target: usdc.address,
    amount: E2E_AMOUNT_IN,
  });
  if (state.stage === "PROVISIONED") {
    state = advance(state, "QUOTED", `request ${route.request_id}`);
    saveState(state);
  }

  // V1 legacy swap: uses the router advertised by getStatus (config.router).
  // V2 swapAllowance returns a DIFFERENT unadvertised router — pre-sign
  // checklist correctly aborts on it (finding for Randy, see current.md).
  const swap: ApiSwapData = (await api.swap({
    from: eurc.address,
    target: usdc.address,
    amount: E2E_AMOUNT_IN,
    executor: signer,
    payer: signer,
    recipient: signer,
    slippageBps: SLIPPAGE_BPS,
    deadlineSecs: DEADLINE_SECS,
  })) as ApiSwapData;

  // ---- pre-sign checklist (simulation runs post-approve: needs allowance) ----
  const rpcChainId = await client.getChainId();
  t.safetyChecks = evaluateSwapSafety({
    swap,
    paths: route.paths,
    cfg,
    rpcChainId,
    signer,
    tokenIn: eurc,
    tokenOut: usdc,
    amountIn: E2E_AMOUNT_IN,
    slippageBps: SLIPPAGE_BPS,
    nowSecs: Math.floor(Date.now() / 1000),
    simulatedOk: null,
  });
  for (const c of t.safetyChecks) {
    if (!c.ok) fail(t, state, `pre-sign check failed: ${c.name} — ${c.detail}`);
  }

  const spender = swap.contracts.execution_router;

  // ---- EURC approve → execution router (exact amount, skip if sufficient) ----
  const allowance = await client.readContract({
    address: eurc.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [signer, spender],
  });
  if (allowance < E2E_AMOUNT_IN) {
    const r = await submitGuarded({
      client,
      state,
      step: "eurc_approve",
      sender: signer,
      params: { token: eurc.address, spender, amount: E2E_AMOUNT_IN.toString() },
      send: () =>
        wallet.writeContract({
          address: eurc.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [spender, E2E_AMOUNT_IN],
          chain: chainOf(cfg),
        }),
    });
    state = r.state;
    t.approveTxs.push({ step: "eurc_approve", txHash: r.txHash });
  }

  // ---- post-approve simulation gate ----
  const sim = await simulateSwap(client, swap, signer);
  if (!sim.ok) fail(t, state, `swap simulation failed: ${sim.error}`);
  t.verifyChecks["simulation"] = [
    { name: "publicClient.call", ok: true, detail: "simulated ok (post-approve)" },
  ];

  // ---- swap ----
  const swapBalBefore = await readBalances(client, {
    owner: signer,
    tokenIn: eurc.address,
    tokenOut: usdc.address,
  });
  const s = await submitGuarded({
    client,
    state,
    step: "swap",
    sender: signer,
    params: { to: swap.tx.to, quoteId: swap.quote_id, amountIn: E2E_AMOUNT_IN.toString() },
    send: () =>
      wallet.sendTransaction({
        to: swap.tx.to,
        data: swap.tx.data,
        value: BigInt(swap.tx.value),
        chain: chainOf(cfg),
      }),
    onSubmitted: (s) => advance(s, "SWAP_SUBMITTED", `pending`),
  });
  state = s.state;
  t.swapTx = s.txHash;

  const v = verifySwap({
    receipt: s.receipt,
    signer,
    tokenIn: eurc.address,
    tokenOut: usdc.address,
    amountIn: E2E_AMOUNT_IN,
    amountOutMin: BigInt(swap.tx.amount_out_min),
    balanceBefore: swapBalBefore,
    gasCostNative: s.receipt.gasUsed * s.receipt.effectiveGasPrice,
    balanceAfter: await readBalances(client, {
      owner: signer,
      tokenIn: eurc.address,
      tokenOut: usdc.address,
    }),
  });
  t.verifyChecks["swap"] = v.checks;
  if (!v.ok) fail(t, state, "swap provenance checks failed");
  state = advance(state, "SWAP_VERIFIED", `${v.inReceived} USDC`);
  state = { ...state, usdcReceived: v.inReceived.toString() };
  saveState(state);

  // ---- USDC approve → vault (exact received amount, skip if sufficient) ----
  const usdcAllowance = await client.readContract({
    address: usdc.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [signer, vault],
  });
  if (usdcAllowance < v.inReceived) {
    const r = await submitGuarded({
      client,
      state,
      step: "approve",
      sender: signer,
      params: { token: usdc.address, spender: vault, amount: v.inReceived.toString() },
      send: () =>
        wallet.writeContract({
          address: usdc.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [vault, v.inReceived],
          chain: chainOf(cfg),
        }),
      onSubmitted: (s) => advance(s, "APPROVE_SUBMITTED", "pending"),
    });
    state = r.state;
    state = advance(state, "APPROVED", `allowance ${v.inReceived}`);
    saveState(state);
    t.approveTxs.push({ step: "approve_usdc", txHash: r.txHash });
  } else {
    state = advance(state, "APPROVE_SUBMITTED", "skip: allowance sufficient");
    state = advance(state, "APPROVED", "skip: allowance sufficient");
    saveState(state);
  }

  // ---- deposit ----
  const vaultBalBefore = (await client.readContract({
    address: usdc.address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [vault],
  }));
  const d = await submitGuarded({
    client,
    state,
    step: "deposit",
    sender: signer,
    params: { vault, amount: v.inReceived.toString(), mode: "EXTEND" },
    send: () =>
      wallet.writeContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "deposit",
        args: [v.inReceived, 0],
        chain: chainOf(cfg),
      }),
    onSubmitted: (s) => advance(s, "DEPOSIT_SUBMITTED", "pending"),
  });
  state = d.state;
  t.depositTx = d.txHash;

  const dv = await verifyDeposit({
    client,
    receipt: d.receipt,
    vault,
    token: usdc.address,
    amount: v.inReceived,
    vaultBalanceBefore: vaultBalBefore,
  });
  t.verifyChecks["deposit"] = dv.checks;
  if (!dv.ok) fail(t, state, "deposit verification failed");
  state = advance(state, "DEPOSITED", `${v.inReceived} USDC`);
  saveState(state);

  t.result = "DEPOSITED";
  writeTranscript(t);
  return t;
}
