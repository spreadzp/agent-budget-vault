// SLICE-254-4/5: guided happy-path — 5 EURC → swap → verify → approve → deposit.
// FSM: QUOTED → SWAP_SUBMITTED → SWAP_VERIFIED → APPROVE_* → DEPOSIT_* → DEPOSITED.
// Any failed check aborts before the next signature.
// --drill (SLICE-254-5): break after swap submit to prove resume adoption.
//
// Audit hardening (254-7):
//  - buildCtx re-validates the vault policy + token decimals ON-CHAIN before
//    any approve/deposit (H5, M7);
//  - intents journal amountOutMin and pre-tx balances so resume verification
//    is not a tautology (H3);
//  - finishDepositPhase is stage-aware — never double-advances the FSM (H4);
//  - ABORTED runs with recorded swap/deposit txHash refuse a fresh e2e (H1/H2);
//  - quote freshness re-checked right before signing (M1); EURC allowance is
//    revoked on simulation-abort (M2); --drill requires PEACH_DRILL=1 (M9).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import type { ApiSwapData } from "@masterpeach/arc-aggregator-sdk";
import type { SigningWallet } from "./tx.mts";
import {
  chainOf,
  ERC20_ABI,
  FACTORY_ABI,
  publicClientFor,
  readTokenMeta,
  VAULT_ABI,
  VAULT_POLICY_ABI,
  type VaultPolicy,
} from "./chain.mts";
import { EVIDENCE_DIR, type ChainConfig, type TokenConfig } from "./config.mts";
import { accountFromEnv } from "./env.mts";
import { apiClientFor } from "./peach/client.mts";
import { evaluateSwapSafety, simulateSwap, type SafetyCheck } from "./peach/safety.mts";
import { readBalances, verifySwap, type VerifyCheck } from "./peach/verification.mts";
import { advance, loadState, requireStage, saveState, type SpikeState } from "./state.mts";
import { liveMoneyIntentReason, submitGuarded } from "./tx.mts";
import { buildProvisionParams, evaluateVaultPolicy } from "./vault/provisioning.mts";
import { verifyDeposit } from "./vault/deposit.mts";

const E2E_DIR = join(EVIDENCE_DIR, "e2e");
const TRANSCRIPT_PATH = join(E2E_DIR, "transcript.json");
export const E2E_AMOUNT_IN = 5_000_000n; // 5 EURC, 6 dec (D-254-17)
const SLIPPAGE_BPS = 50;
const DEADLINE_SECS = 120;
const QUOTE_MAX_AGE_SECS = 110;

export interface Transcript {
  at: string;
  vault: `0x${string}`;
  signer: `0x${string}`;
  amountIn: string;
  safetyChecks: SafetyCheck[];
  swapTx?: `0x${string}`;
  approveTxs: { step: string; txHash: `0x${string}` }[];
  depositTx?: `0x${string}`;
  verifyChecks: Record<string, VerifyCheck[]>;
  result?: string;
  notes?: string[];
}

export function writeTranscript(t: Transcript, path = TRANSCRIPT_PATH): string {
  mkdirSync(E2E_DIR, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(t, (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`,
  );
  return path;
}

export const abortRun = (t: Transcript, state: SpikeState, msg: string): never => {
  t.result = `ABORTED: ${msg}`;
  writeTranscript(t);
  if (state.stage !== "ABORTED" && state.stage !== "DEPOSITED") {
    try {
      saveState(advance(state, "ABORTED", msg));
    } catch {
      // audit N-M2: on CAS conflict reload the journal and abort that copy
      try {
        saveState(advance(loadState(), "ABORTED", msg));
      } catch {
        /* even the reload failed — transcript is written; fail closed anyway */
      }
    }
  }
  throw new Error(msg);
};

export interface E2eCtx {
  cfg: ChainConfig;
  client: PublicClient;
  api: ReturnType<typeof apiClientFor>;
  wallet: SigningWallet;
  signer: `0x${string}`;
  vault: `0x${string}`;
  eurc: TokenConfig;
  usdc: TokenConfig;
}

/**
 * Build the run context. The vault address comes from the local journal, but
 * is trusted only after a FULL on-chain policy re-check (audit H5) and a
 * decimals cross-check (audit M7) — before any USDC approve is ever signed.
 */
export async function buildCtx(cfg: ChainConfig): Promise<E2eCtx> {
  const client = publicClientFor(cfg);
  const account = accountFromEnv();
  const state = loadState();
  if (!state.vault) throw new Error("no vault in state — run provision first");
  const eurc = cfg.tokens.find((t) => t.symbol === "EURC" && t.scope === "e2e");
  const usdc = cfg.tokens.find(
    (t) => t.address.toLowerCase() === cfg.vaultDepositToken.toLowerCase(),
  );
  if (!eurc || !usdc) throw new Error("config missing EURC(e2e)/vault USDC token");

  // H5: re-verify the vault is the contract provision() configured — full tuple
  const policy = (await client.readContract({
    address: state.vault,
    abi: VAULT_POLICY_ABI,
    functionName: "policy",
  })) as VaultPolicy;
  const expected = buildProvisionParams(account.address);
  const chk = evaluateVaultPolicy(policy, {
    ...expected,
    token: cfg.vaultDepositToken,
  });
  if (!chk.ok) throw new Error(`vault policy re-check failed: ${chk.failures.join("; ")}`);

  // audit N-M7: state.vault must be the factory's vault for this signer
  const vaultOfSigner = await client.readContract({
    address: cfg.factory,
    abi: FACTORY_ABI,
    functionName: "vaultOf",
    args: [account.address],
  });
  if (String(vaultOfSigner).toLowerCase() !== state.vault.toLowerCase()) {
    throw new Error(`vault ${state.vault} != factory.vaultOf(${account.address}) = ${String(vaultOfSigner)}`);
  }

  // M7: token decimals must match on-chain metadata (money-path invariant C)
  const [mIn, mOut] = await Promise.all([
    readTokenMeta(client, eurc.address),
    readTokenMeta(client, usdc.address),
  ]);
  if (mIn.decimals !== eurc.decimals) {
    throw new Error(`EURC decimals: chain ${mIn.decimals} != config ${eurc.decimals}`);
  }
  if (mOut.decimals !== usdc.decimals) {
    throw new Error(`USDC decimals: chain ${mOut.decimals} != config ${usdc.decimals}`);
  }

  return {
    cfg,
    client,
    api: apiClientFor(cfg),
    wallet: createWalletClient({ account, chain: chainOf(cfg), transport: http(cfg.rpcUrl) }),
    signer: account.address,
    vault: state.vault,
    eurc,
    usdc,
  };
}

export function requiredReceived(state: SpikeState): bigint {
  if (!state.usdcReceived || BigInt(state.usdcReceived) <= 0n) {
    throw new Error("usdcReceived missing/zero — cannot size approve+deposit safely");
  }
  return BigInt(state.usdcReceived);
}

/** Verify a mined swap receipt and advance to SWAP_VERIFIED. */
export function verifyAndRecord(
  ctx: E2eCtx,
  state: SpikeState,
  t: Transcript,
  receipt: TransactionReceipt,
  swapBalBefore: { in: bigint; out: bigint } | null,
  amountOutMin: bigint,
  balanceAfter: { in: bigint; out: bigint } | null,
): { state: SpikeState; received: bigint } {
  const v = verifySwap({
    receipt,
    signer: ctx.signer,
    expectedTo: ctx.cfg.router,
    tokenIn: ctx.eurc.address,
    tokenOut: ctx.usdc.address,
    amountIn: E2E_AMOUNT_IN,
    amountOutMin,
    balanceBefore: swapBalBefore,
    gasCostNative: receipt.gasUsed * receipt.effectiveGasPrice,
    balanceAfter,
  });
  t.verifyChecks["swap"] = v.checks;
  if (!v.ok) abortRun(t, state, "swap provenance checks failed");
  let s = advance(state, "SWAP_VERIFIED", `${v.inReceived} USDC`);
  s = { ...s, usdcReceived: v.inReceived.toString() };
  saveState(s);
  return { state: s, received: v.inReceived };
}

/**
 * Approve USDC→vault (exact, skip if sufficient) + deposit + verify.
 * Stage-aware (audit H4): works from SWAP_VERIFIED, APPROVE_SUBMITTED,
 * APPROVED and DEPOSIT_SUBMITTED — transitions are taken only when legal,
 * never re-advancing a stage the FSM already passed.
 */
export async function finishDepositPhase(
  ctx: E2eCtx,
  state: SpikeState,
  t: Transcript,
  received: bigint,
): Promise<SpikeState> {
  const { client, wallet, signer, usdc, vault } = ctx;
  if (received <= 0n) throw new Error("received <= 0 — refusing approve/deposit");

  // --- approve leg: only when the FSM hasn't passed APPROVED yet ---
  if (state.stage === "SWAP_VERIFIED" || state.stage === "APPROVE_SUBMITTED") {
    const usdcAllowance = await client.readContract({
      address: usdc.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [signer, vault],
    });
    if (usdcAllowance < received) {
      const r = await submitGuarded({
        client,
        wallet,
        state,
        step: "approve",
        sender: signer,
        params: { token: usdc.address, spender: vault, amount: received.toString() },
        request: {
          to: usdc.address,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [vault, received],
          }),
        },
        expectedTo: usdc.address,
        onSubmitted: (s) =>
          s.stage === "APPROVE_SUBMITTED" ? s : advance(s, "APPROVE_SUBMITTED", "pending"),
      });
      state = r.state;
      t.approveTxs.push({ step: "approve_usdc", txHash: r.txHash });
    }
    if (state.stage !== "APPROVE_SUBMITTED") {
      state = advance(state, "APPROVE_SUBMITTED", "skip: allowance sufficient");
      saveState(state);
    }
    state = advance(state, "APPROVED", `allowance ${received}`);
    saveState(state);
  }

  // --- deposit leg ---
  const vaultBalBefore = await client.readContract({
    address: usdc.address,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [vault],
  });
  const d = await submitGuarded({
    client,
    wallet,
    state,
    step: "deposit",
    sender: signer,
    params: {
      vault,
      amount: received.toString(),
      mode: "EXTEND",
      vaultBalBefore: vaultBalBefore.toString(),
    },
    request: {
      to: vault,
      data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [received, 0] }),
    },
    expectedTo: vault,
    onSubmitted: (s) =>
      s.stage === "DEPOSIT_SUBMITTED" ? s : advance(s, "DEPOSIT_SUBMITTED", "pending"),
  });
  state = d.state;
  t.depositTx = d.txHash;

  // on adoption the fresh `vaultBalBefore` read is post-deposit — the
  // journaled before-balance is authoritative instead (audit N-M3 path).
  let depBefore: bigint | null = vaultBalBefore;
  if (d.resumed) {
    const journaled = [...state.intents].reverse().find((i) => i.step === "deposit");
    const raw = journaled?.params.vaultBalBefore;
    depBefore = typeof raw === "string" ? BigInt(raw) : null;
  }
  const dv = await verifyDeposit({
    client,
    receipt: d.receipt,
    vault,
    token: usdc.address,
    amount: received,
    vaultBalanceBefore: depBefore,
    signer,
    blockNumber: d.receipt.blockNumber,
  });
  t.verifyChecks["deposit"] = dv.checks;
  if (!dv.ok) abortRun(t, state, "deposit verification failed");
  state = advance(state, "DEPOSITED", `${received} USDC`);
  saveState(state);
  t.result = "DEPOSITED";
  writeTranscript(t);
  return state;
}

/** Freshness gate (M1): quote_ts must still be inside the deadline window. */
export function quoteStillFresh(swap: ApiSwapData, nowSecs: number): boolean {
  const quoteTsSecs = swap.quote_ts > 1e12 ? Math.floor(swap.quote_ts / 1000) : swap.quote_ts;
  const age = nowSecs - quoteTsSecs;
  return age <= QUOTE_MAX_AGE_SECS && age >= -30;
}

export async function runE2E(cfg: ChainConfig, opts: { drill?: boolean } = {}): Promise<Transcript> {
  if (opts.drill && process.env.PEACH_DRILL !== "1") {
    throw new Error("--drill requires PEACH_DRILL=1 in env (deliberate crash-test opt-in)");
  }
  let state = loadState();
  // audit N-M3: anything pending means a prior run left an intent in flight —
  // only resume may consume it; a fresh e2e must not sign ahead of adoption.
  if (Object.values(state.pending).some(Boolean)) {
    throw new Error("journal has pending intents — run 'resume' to reconcile before a new e2e");
  }
  const ctx = await buildCtx(cfg);

  // audit N-H1/N-M8/N2-H1+N2-M1: a journaled swap/deposit hash blocks a fresh
  // run unless marked dead or proven reverted — unproven/unknown outcomes
  // fail closed. Only intents since the last completed run count.
  const doneMoneyReason = await liveMoneyIntentReason(ctx.client, state);
  const doneMoney = doneMoneyReason !== undefined;

  // mined hashes from a COMPLETED (DEPOSITED) run are consumed work, not a
  // replay risk — the drill deliberately re-runs against the same vault.
  const journalFromCompletedRun = state.stage === "DEPOSITED";
  if (journalFromCompletedRun && opts.drill) {
    // drill-only reset: reuse the same provisioned vault for a second deposit
    state = { ...state, stage: "PROVISIONED", usdcReceived: undefined };
    saveState(state);
  }
  if (state.stage === "ABORTED") {
    if (doneMoney) {
      throw new Error(
        `ABORTED run has a live journaled money action (${doneMoneyReason}) — refusing fresh e2e; inspect the journal and reconcile manually`,
      );
    }
    state = advance(state, "PROVISIONED", "retry after abort");
    saveState(state);
  }
  // N-H1 residual: a mined journaled swap/deposit must never be replayed by
  // a fresh quote — only 'resume' consumes journaled outcomes.
  if (doneMoney && !journalFromCompletedRun &&
      (state.stage === "PROVISIONED" || state.stage === "QUOTED")) {
    throw new Error(
      `journal records a live money action (${doneMoneyReason}) — run 'resume'; a fresh e2e would replay money`,
    );
  }
  requireStage(state, "PROVISIONED");
  if (state.stage !== "PROVISIONED" && state.stage !== "QUOTED") {
    throw new Error(`stage ${state.stage} already past quote — use 'resume' to reconcile`);
  }
  const { client, api, signer, eurc, usdc, vault } = ctx;

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
    abortRun(t, state, `EURC balance ${before.in} < required ${E2E_AMOUNT_IN}`);

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
  const safetyArgs = {
    swap,
    paths: route.paths,
    route,
    cfg,
    rpcChainId,
    signer,
    tokenIn: eurc,
    tokenOut: usdc,
    amountIn: E2E_AMOUNT_IN,
    slippageBps: SLIPPAGE_BPS,
    simulatedOk: null as boolean | null,
  };
  t.safetyChecks = evaluateSwapSafety({ ...safetyArgs, nowSecs: Math.floor(Date.now() / 1000) });
  for (const c of t.safetyChecks) {
    if (!c.ok) abortRun(t, state, `pre-sign check failed: ${c.name} — ${c.detail}`);
  }

  const spender = swap.contracts.execution_router;

  // ---- EURC approve → execution router (exact amount, skip if sufficient) ----
  const allowance = await client.readContract({
    address: eurc.address,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [signer, spender],
  });
  const grantedEurc = allowance < E2E_AMOUNT_IN;
  if (grantedEurc) {
    const r = await submitGuarded({
      client,
      wallet: ctx.wallet,
      state,
      step: "eurc_approve",
      sender: signer,
      params: { token: eurc.address, spender, amount: E2E_AMOUNT_IN.toString() },
      request: {
        to: eurc.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [spender, E2E_AMOUNT_IN],
        }),
      },
      expectedTo: eurc.address,
    });
    state = r.state;
    t.approveTxs.push({ step: "eurc_approve", txHash: r.txHash });
  }

  // ---- post-approve simulation gate ----
  const sim = await simulateSwap(client, swap, signer);
  if (!sim.ok) {
    if (grantedEurc) {
      // M2: don't leave a standing EURC allowance to the router on abort
      try {
        const rr = await submitGuarded({
          client,
          wallet: ctx.wallet,
          state,
          step: "eurc_approve",
          sender: signer,
          params: { token: eurc.address, spender, amount: "0", revoke: true },
          request: {
            to: eurc.address,
            data: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "approve",
              args: [spender, 0n],
            }),
          },
          expectedTo: eurc.address,
        });
        state = rr.state; // audit N-M2: keep journal version in sync
        t.notes = [...(t.notes ?? []), "EURC allowance revoked after simulation abort"];
      } catch (e) {
        t.notes = [
          ...(t.notes ?? []),
          `revoke attempt failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
        ];
      }
    }
    abortRun(t, state, `swap simulation failed: ${sim.error}`);
  }
  t.verifyChecks["simulation"] = [
    { name: "publicClient.call", ok: true, detail: "simulated ok (post-approve)" },
  ];

  // ---- M1: freshness re-check right before signing the swap ----
  if (!quoteStillFresh(swap, Math.floor(Date.now() / 1000))) {
    abortRun(t, state, "quote went stale between pre-sign checks and swap signing — re-quote");
  }

  // ---- swap ----
  const swapBalBefore = await readBalances(client, {
    owner: signer,
    tokenIn: eurc.address,
    tokenOut: usdc.address,
  });
  const amountOutMin = BigInt(swap.tx.amount_out_min);
  const s = await submitGuarded({
    client,
    wallet: ctx.wallet,
    state,
    step: "swap",
    sender: signer,
    params: {
      to: swap.tx.to,
      quoteId: swap.quote_id,
      amountIn: E2E_AMOUNT_IN.toString(),
      amountOutMin: amountOutMin.toString(),
      expectOut: swap.expect_amount_out,
      balInBefore: swapBalBefore.in.toString(),
      balOutBefore: swapBalBefore.out.toString(),
    },
    request: {
      to: swap.tx.to,
      data: swap.tx.data,
      value: 0n, // checked == "0" by the safety gate
    },
    expectedTo: cfg.router,
    // audit N-H1: stage advance lands in the SAME saveState as hash+raw,
    // before broadcast — no saveState here, submitGuarded persists atomically.
    onSubmitted: (st) => advance(st, "SWAP_SUBMITTED", "pending"),
    onBroadcasted: (st) => {
      if (opts.drill) {
        saveState(st);
        writeTranscript(t);
        console.log("[drill] swap broadcast, exiting before receipt (SWAP_SUBMITTED)");
        process.exit(3);
      }
    },
  });
  state = s.state;
  t.swapTx = s.txHash;

  const v = verifyAndRecord(
    ctx,
    state,
    t,
    s.receipt,
    swapBalBefore,
    amountOutMin,
    await readBalances(client, { owner: signer, tokenIn: eurc.address, tokenOut: usdc.address }),
  );
  state = v.state;

  await finishDepositPhase(ctx, state, t, v.received);
  return t;
}
