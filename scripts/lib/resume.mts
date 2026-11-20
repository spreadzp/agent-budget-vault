// SLICE-254-5: resume — reconcile persisted intents against on-chain
// truth (receipt / allowance / vault state). Never resends while a
// txHash outcome is unknown (D-254-12/19).
//
// Audit hardening (254-7):
//  - orphan intents (no txHash, legacy format) are reconciled by nonce —
//    if the chain pending nonce moved past intent.nonce we fail closed (C1);
//  - swap/deposit verification uses JOURNALED intent params (amountOutMin,
//    balances, vaultBalBefore) or archive reads at the receipt block —
//    never reconstructed-tautology deltas; unmeasurable checks are marked
//    `skipped`, not `ok` (H3, M5);
//  - reverted approve/deposit no longer wedge the FSM — resume retries the
//    leg with a fresh intent (M3); missing usdcReceived refuses (M6).
import type { TransactionReceipt } from "viem";
import type { ChainConfig } from "./config.mts";
import { ERC20_ABI } from "./chain.mts";
import {
  buildCtx,
  finishDepositPhase,
  requiredReceived,
  runE2E,
  verifyAndRecord,
  writeTranscript,
  type E2eCtx,
  type Transcript,
} from "./e2e.mts";
import { readBalancesAt } from "./peach/verification.mts";
import {
  advance,
  clearPending,
  loadState,
  saveState,
  type SpikeState,
  type TxIntent,
  type TxStep,
} from "./state.mts";
import { reconcileOrphanIntent } from "./tx.mts";
import { verifyDeposit } from "./vault/deposit.mts";
import { join } from "node:path";
import { EVIDENCE_DIR } from "./config.mts";

const RESUME_TRANSCRIPT = join(EVIDENCE_DIR, "e2e", "resume-transcript.json");

interface PendingOutcome {
  step: TxStep;
  txHash: `0x${string}`;
  receipt: TransactionReceipt;
  intent: TxIntent;
}

async function reconcilePending(
  ctx: E2eCtx,
  state: SpikeState,
): Promise<{ state: SpikeState; outcomes: PendingOutcome[] }> {
  const outcomes: PendingOutcome[] = [];
  for (const [step, pend] of Object.entries(state.pending) as [TxStep, (typeof state.pending)[TxStep]][]) {
    if (!pend) continue;
    if (!pend.txHash) {
      await reconcileOrphanIntent(ctx.client, pend.intent.sender, step, pend);
      state = clearPending(state, step);
      saveState(state);
      continue;
    }
    const rcpt = await ctx.client
      .getTransactionReceipt({ hash: pend.txHash })
      .catch(() => undefined);
    if (!rcpt) {
      const tx = await ctx.client
        .getTransaction({ hash: pend.txHash })
        .catch(() => undefined);
      if (tx) {
        throw new Error(
          `TX_OUTCOME_UNKNOWN-ish: ${step} tx ${pend.txHash} exists but no receipt — in flight, resend forbidden (D-254-12); retry later`,
        );
      }
      throw new Error(
        `TX_OUTCOME_UNKNOWN: ${step} tx ${pend.txHash} not found on-chain — check nonce/chain manually before any resend`,
      );
    }
    // bind the adopted receipt to its intent (audit M5)
    if (rcpt.from.toLowerCase() !== pend.intent.sender.toLowerCase()) {
      throw new Error(
        `${step} tx ${pend.txHash} from ${rcpt.from} != intent sender ${pend.intent.sender}`,
      );
    }
    if (rcpt.status !== "success") {
      state = clearPending(state, step);
      saveState(state);
      throw new Error(`${step} tx ${pend.txHash} reverted — pending cleared, re-run allowed`);
    }
    state = clearPending(state, step);
    saveState(state);
    outcomes.push({ step, txHash: pend.txHash, receipt: rcpt, intent: pend.intent });
  }
  return { state, outcomes };
}

/**
 * Audit H1: a crash between receipt-persist (pending cleared → intent lands in
 * `intents` WITH txHash) and the post-verification advance leaves a stage like
 * SWAP_SUBMITTED with no pending entry. Re-derive the outcome from the
 * journaled hash instead of declaring the journal stuck.
 */
async function adoptJournaled(
  ctx: E2eCtx,
  state: SpikeState,
  step: TxStep,
): Promise<PendingOutcome | undefined> {
  const done = [...state.intents].reverse().find((i) => i.step === step && i.txHash !== undefined);
  if (!done?.txHash) return undefined;
  const rcpt = await ctx.client
    .getTransactionReceipt({ hash: done.txHash })
    .catch(() => undefined);
  if (!rcpt || rcpt.status !== "success") return undefined;
  if (rcpt.from.toLowerCase() !== done.sender.toLowerCase()) {
    throw new Error(`${step} journaled tx ${done.txHash} from ${rcpt.from} != intent sender`);
  }
  return { step, txHash: done.txHash, receipt: rcpt, intent: done };
}

function transcriptFor(state: SpikeState, ctx: E2eCtx): Transcript {
  return {
    at: new Date().toISOString(),
    vault: ctx.vault,
    signer: ctx.signer,
    amountIn: "5000000",
    safetyChecks: [],
    approveTxs: [],
    verifyChecks: {},
    notes: ["resume run — txHashes adopted from persisted intents"],
  };
}

export async function runResume(cfg: ChainConfig): Promise<Transcript> {
  let state = loadState();
  const ctx = await buildCtx(cfg);

  // 1) reconcile every persisted pending tx against chain truth
  const rec = await reconcilePending(ctx, state);
  state = rec.state;
  const t = transcriptFor(state, ctx);

  // 2) dispatch by stage — continue the flow, never re-do done work
  switch (state.stage) {
    case "DEPOSITED": {
      t.result = "DEPOSITED (already complete)";
      writeTranscript(t, RESUME_TRANSCRIPT);
      return t;
    }
    case "INIT":
    case "PROVISIONED":
    case "QUOTED":
    case "ABORTED": {
      // safe to take the fresh path — nothing financial pending
      // (ABORTED runs through the journal guard inside runE2E)
      return runE2E(cfg);
    }
    case "REQUOTE_REQUIRED": {
      state = advance(state, "QUOTED", "re-quote after REQUOTE_REQUIRED");
      saveState(state);
      return runE2E(cfg);
    }
    case "SWAP_SUBMITTED": {
      const swapOut =
        rec.outcomes.find((o) => o.step === "swap") ??
        (await adoptJournaled(ctx, state, "swap"));
      if (!swapOut) {
        throw new Error("stage SWAP_SUBMITTED but no pending/journaled swap receipt — check state file");
      }
      t.swapTx = swapOut.txHash;
      // journaled verification (H3): intent params carry amountOutMin and the
      // pre-tx balances; "after" is read at the receipt block (archive RPC).
      // If archive state is unavailable the delta checks are `skipped`, not
      // tautologically `ok`.
      const p = swapOut.intent.params as Record<string, string | undefined>;
      const amountOutMin = p.amountOutMin ? BigInt(p.amountOutMin) : 0n;
      if (amountOutMin <= 0n) {
        throw new Error("swap intent journal lacks amountOutMin — cannot verify slippage floor");
      }
      const balBefore =
        p.balInBefore && p.balOutBefore
          ? { in: BigInt(p.balInBefore), out: BigInt(p.balOutBefore) }
          : null;
      const balAfter = await readBalancesAt(
        ctx.client,
        { owner: ctx.signer, tokenIn: ctx.eurc.address, tokenOut: ctx.usdc.address },
        swapOut.receipt.blockNumber,
      );
      if (balBefore === null || balAfter === null) {
        t.notes?.push(
          `delta checks skipped: ${balBefore === null ? "no journaled balances" : "archive read failed"} — events+receipt remain authoritative`,
        );
      }
      const v = verifyAndRecord(
        ctx,
        state,
        t,
        swapOut.receipt,
        balBefore,
        amountOutMin,
        balAfter,
      );
      state = v.state;
      await finishDepositPhase(ctx, state, t, v.received);
      writeTranscript(t, RESUME_TRANSCRIPT);
      return t;
    }
    case "SWAP_VERIFIED": {
      const received = requiredReceived(state);
      await finishDepositPhase(ctx, state, t, received);
      writeTranscript(t, RESUME_TRANSCRIPT);
      return t;
    }
    case "APPROVE_SUBMITTED":
    case "APPROVED": {
      const received = requiredReceived(state);
      const adoptedApprove = rec.outcomes.find((o) => o.step === "approve");
      if (adoptedApprove) {
        t.approveTxs.push({ step: "approve_usdc(adopted)", txHash: adoptedApprove.txHash });
      }
      // finishDepositPhase is stage-aware: it re-checks on-chain allowance
      // and re-sends the approve when it never landed (M3 un-wedge).
      await finishDepositPhase(ctx, state, t, received);
      writeTranscript(t, RESUME_TRANSCRIPT);
      return t;
    }
    case "DEPOSIT_SUBMITTED": {
      const dep =
        rec.outcomes.find((o) => o.step === "deposit") ??
        (await adoptJournaled(ctx, state, "deposit"));
      if (!dep) {
        // prior deposit reverted (pending cleared, nothing mined) — retry the leg (M3)
        const received = requiredReceived(state);
        await finishDepositPhase(ctx, state, t, received);
        writeTranscript(t, RESUME_TRANSCRIPT);
        return t;
      }
      const received = requiredReceived(state);
      // journaled vaultBalBefore → strict delta; archive read as fallback;
      // else the check is honestly skipped (H3).
      const p = dep.intent.params as Record<string, string | undefined>;
      let balBefore: bigint | null = p.vaultBalBefore ? BigInt(p.vaultBalBefore) : null;
      if (balBefore === null && dep.receipt.blockNumber > 0n) {
        balBefore = await ctx.client
          .readContract({
            address: ctx.usdc.address,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [ctx.vault],
            blockNumber: dep.receipt.blockNumber - 1n,
          })
          .catch(() => null);
      }
      if (balBefore === null) {
        t.notes?.push("deposit delta check skipped — no journaled/archive before-balance");
      }
      const dv = await verifyDeposit({
        client: ctx.client,
        receipt: dep.receipt,
        vault: ctx.vault,
        token: ctx.usdc.address,
        amount: received,
        vaultBalanceBefore: balBefore,
        signer: ctx.signer,
      });
      t.depositTx = dep.txHash;
      t.verifyChecks["deposit"] = dv.checks;
      if (!dv.ok) throw new Error("adopted deposit failed verification");
      state = advance(state, "DEPOSITED", `${received} USDC (adopted)`);
      saveState(state);
      t.result = "DEPOSITED";
      writeTranscript(t, RESUME_TRANSCRIPT);
      return t;
    }
    case "TX_OUTCOME_UNKNOWN": {
      throw new Error("TX_OUTCOME_UNKNOWN persisted — resolve txHash manually before resume");
    }
    default:
      throw new Error(`resume: unhandled stage ${String(state.stage)}`);
  }
}
