// SLICE-254-5: resume — reconcile persisted intents against on-chain
// truth (receipt / allowance / vault state). Never resends while a
// txHash outcome is unknown (D-254-12/19).
//
// Audit hardening (254-7, rounds 1+2):
//  - orphan intents (no txHash, legacy format) are reconciled by nonce —
//    if the chain pending nonce moved past intent.nonce we fail closed (C1);
//  - a journaled hash with no receipt and no tx is DEAD, not unknown:
//    if raw bytes were journaled they are rebroadcast verbatim (idempotent
//    by hash); otherwise the step rolls back one stage and re-runs (N-M8);
//  - a reverted receipt rolls the stage back one step — the financial
//    action provably consumed nothing, retry is legitimate (N-M8);
//  - adopted outcomes are consumed whatever the stage: a mined swap at
//    QUOTED advances to SWAP_SUBMITTED and is verified, never replayed
//    (N-H1 — the round-2 regression fix);
//  - swap/deposit verification uses JOURNALED intent params (amountOutMin,
//    balances, vaultBalBefore) or archive reads at the receipt block —
//    never reconstructed-tautology deltas; unmeasurable checks are marked
//    `skipped` (H3, M5);
//  - receipt binding: from==sender AND to==intent.params.to (M5, N-L3).
import type { TransactionReceipt } from "viem";
import type { ChainConfig } from "./config.mts";
import { ERC20_ABI, FACTORY_ABI, publicClientFor } from "./chain.mts";
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
  SUBMIT_ROLLBACK,
  type PendingTx,
  type SpikeState,
  type Stage,
  type TxIntent,
  type TxStep,
} from "./state.mts";
import { consumingBlock, isNotFound, reconcileHashedPending, reconcileOrphanIntent } from "./tx.mts";
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

/** Linear stage each step's *SUBMITTED stage rolls back to on a dead tx. */
const ROLLBACK = SUBMIT_ROLLBACK;

const STAGE_ORDER: Stage[] = [
  "INIT",
  "PROVISIONED",
  "QUOTED",
  "SWAP_SUBMITTED",
  "SWAP_VERIFIED",
  "APPROVE_SUBMITTED",
  "APPROVED",
  "DEPOSIT_SUBMITTED",
  "DEPOSITED",
];

const stageRank = (s: Stage): number => {
  const i = STAGE_ORDER.indexOf(s);
  return i === -1 ? 99 : i; // side stages sort past DEPOSITED
};

function bindReceipt(
  step: TxStep,
  txHash: `0x${string}`,
  rcpt: TransactionReceipt,
  intent: TxIntent,
): void {
  if (rcpt.from.toLowerCase() !== intent.sender.toLowerCase()) {
    throw new Error(`${step} tx ${txHash} from ${rcpt.from} != intent sender ${intent.sender}`);
  }
  // audit N-L3: the journaled target must match the receipt's
  const wantTo = typeof intent.params.to === "string" ? intent.params.to.toLowerCase() : "";
  if (wantTo && (rcpt.to ?? "").toLowerCase() !== wantTo) {
    throw new Error(`${step} tx ${txHash} to ${rcpt.to ?? "null"} != journaled ${wantTo}`);
  }
}

/**
 * Reconcile one journaled hash (pending or archived intent). Adopts a mined
 * receipt, throws on in-flight, and clears+rolls back on a provably dead tx
 * (reverted or never-landed). Returns the outcome for mined txs.
 */
async function reconcileHash(
  ctx: E2eCtx,
  state: SpikeState,
  step: TxStep,
  pend: PendingTx,
): Promise<{ state: SpikeState; outcome?: PendingOutcome; rolledBack?: boolean }> {
  const r = await reconcileHashedPending(ctx.client, step, pend);
  if (r.status === "in-flight" || r.status === "unknown") {
    throw new Error(
      `${step} tx ${pend.txHash} ${r.status === "in-flight" ? "exists but no receipt — in flight" : `outcome unproven (${r.reason})`} — resend forbidden (D-254-12); retry later`,
    );
  }
  if (r.status === "reverted" || r.status === "never-sent") {
    // provably dead: consumed nothing — mark the intent dead (audit N2-M1),
    // clear and roll the FSM back so the step can be re-planned legitimately.
    pend.intent.params.dead = r.status;
    if (step in (state.pending as Record<TxStep, unknown>)) {
      state = clearPending(state, step);
    }
    const rb = ROLLBACK[step];
    if (rb && state.stage === rb.submitted) {
      state = advance(state, rb.back, `${step} tx ${r.status}`);
    }
    saveState(state);
    return { state, rolledBack: true };
  }
  const rcpt = r.receipt!;
  bindReceipt(step, pend.txHash!, rcpt, pend.intent);
  if (step in (state.pending as Record<TxStep, unknown>)) {
    state = clearPending(state, step);
    saveState(state);
  }
  return { state, outcome: { step, txHash: pend.txHash!, receipt: rcpt, intent: pend.intent } };
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
    const r = await reconcileHash(ctx, state, step, pend);
    state = r.state;
    if (r.outcome) outcomes.push(r.outcome);
  }
  return { state, outcomes };
}

/**
 * Audit H1: a crash between pending-clear and post-verify advance leaves a
 * stage like SWAP_SUBMITTED whose proof lives in `intents[]`, not `pending`.
 * Audit N-H1/N-M4: distinguish mined / in-flight / provably dead — an RPC
 * error is never read as "reverted".
 */
async function adoptJournaled(
  ctx: E2eCtx,
  state: SpikeState,
  step: TxStep,
): Promise<{ outcome?: PendingOutcome; state: SpikeState; rolledBack?: boolean }> {
  const done = [...state.intents]
    .reverse()
    .find((i) => i.step === step && i.txHash !== undefined && !i.params.dead);
  if (!done?.txHash) {
    // audit N5-M1: a dead flag may be stale — "abandoned" is a weaker proof
    // than "never-sent" (block-body). If the nonce slot moved, re-check the
    // newest dead-flagged intent via the block-body proof: a hash that IS
    // the consuming tx is adopted, not skipped.
    const flagged = [...state.intents]
      .reverse()
      .find(
        (i) =>
          i.step === step &&
          i.txHash !== undefined &&
          typeof i.params.dead === "string" &&
          i.nonce >= 0,
      );
    if (flagged?.txHash) {
      const n = await ctx.client
        .getTransactionCount({ address: flagged.sender, blockTag: "latest" })
        .catch(() => -1);
      if (n === -1) {
        throw new Error(
          `nonce read failed for dead-flagged ${step} ${flagged.txHash} — fail closed`,
        );
      }
      if (n > flagged.nonce) {
        const cross = await consumingBlock(ctx.client, flagged.sender, flagged.nonce, flagged.txHash);
        if (cross === "ours") {
          // the "dead" tx actually landed — clear the stale flag and adopt it
          delete flagged.params.dead;
          const pend: PendingTx = { intent: flagged, txHash: flagged.txHash };
          return reconcileHash(ctx, state, step, pend);
        }
      }
    }
    return { state };
  }
  const pend: PendingTx = { intent: done, txHash: done.txHash };
  // audit N2-M2: callers MUST take the returned state — reconcileHash may
  // have saved a rolled-back version, and a stale copy would CAS-conflict.
  return reconcileHash(ctx, state, step, pend);
}

/**
 * Audit N-H1 fix (round 2): whatever stage the FSM is in, adopted outcomes
 * advance it to each step's SUBMITTED stage so the flow verifies — never
 * replays — already-broadcast work.
 */
function consumeOutcomes(state: SpikeState, outcomes: PendingOutcome[]): SpikeState {
  const SUBMIT_STAGE: Partial<Record<TxStep, Stage>> = {
    swap: "SWAP_SUBMITTED",
    approve: "APPROVE_SUBMITTED",
    deposit: "DEPOSIT_SUBMITTED",
  };
  let changed = false;
  // side-stage normalize: adopted money outcomes must not be bypassed by a
  // re-quote detour — REQUOTE_REQUIRED returns to the linear rail first.
  // (ABORTED stays put: its guard + operator decide.)
  if (state.stage === "REQUOTE_REQUIRED" && outcomes.length > 0) {
    state = advance(state, "QUOTED", "adopted outcomes pending verification");
    changed = true;
  }
  for (const o of outcomes) {
    const target = SUBMIT_STAGE[o.step];
    if (!target) continue;
    // audit N2-M4: step through each legal linear transition, one at a time
    while (stageRank(state.stage) < stageRank(target)) {
      const next = STAGE_ORDER[stageRank(state.stage) + 1];
      state = advance(state, next, `adopted ${o.txHash}`);
      changed = true;
    }
  }
  if (changed) saveState(state);
  return state;
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

  // 1b) a mined provision adopts the vault into the journal
  const provOut = rec.outcomes.find((o) => o.step === "provision");
  if (provOut && state.stage === "INIT") {
    const v = (await ctx.client.readContract({
      address: cfg.factory,
      abi: FACTORY_ABI,
      functionName: "vaultOf",
      args: [ctx.signer],
    }).catch(() => undefined));
    if (v && v !== "0x0000000000000000000000000000000000000000") {
      state = { ...state, vault: v };
      state = advance(state, "PROVISIONED", `adopted vault ${v}`);
      saveState(state);
    }
  }

  // 2) audit N6-M1/L3: dead flags may be stale — "abandoned" is a weaker
  //    proof than block-body "never-sent". Before dispatch, re-check EVERY
  //    dead-flagged swap/deposit intent whose nonce slot moved: a hash that
  //    IS the consuming tx is resurrected (flag cleared+persisted, adopted,
  //    stage advanced) instead of wedging the run.
  for (const i of state.intents) {
    if ((i.step !== "swap" && i.step !== "deposit") || i.txHash === undefined) continue;
    if (typeof i.params.dead !== "string" || i.nonce < 0) continue;
    const n = await ctx.client
      .getTransactionCount({ address: i.sender, blockTag: "latest" })
      .catch(() => -1);
    if (n === -1) {
      throw new Error(
        `nonce read failed for dead-flagged ${i.step} ${i.txHash} — flag unverified, fail closed`,
      );
    }
    if (n <= i.nonce) continue;
    const cross = await consumingBlock(ctx.client, i.sender, i.nonce, i.txHash);
    if (cross === "ours") {
      delete i.params.dead;
      saveState(state); // audit N6-L4: flag clear must reach disk
      const r = await reconcileHash(ctx, state, i.step, { intent: i, txHash: i.txHash });
      state = r.state;
      if (r.outcome) rec.outcomes.push(r.outcome);
    } else if (cross === undefined) {
      throw new Error(
        `${i.step} ${i.txHash} flagged dead but consuming block unproven — fail closed`,
      );
    }
  }

  // 3) audit N-H1: consumed outcomes advance the stage to the step's
  //    SUBMITTED stage so dispatch below verifies — never replays — them.
  state = consumeOutcomes(state, rec.outcomes);

  const t = transcriptFor(state, ctx);

  // 3) dispatch by stage — continue the flow, never re-do done work
  switch (state.stage) {
    case "DEPOSITED": {
      t.result = "DEPOSITED (already complete)";
      writeTranscript(t, RESUME_TRANSCRIPT);
      return t;
    }
    case "INIT": {
      throw new Error("stage INIT — run 'provision' first");
    }
    case "PROVISIONED":
    case "QUOTED":
    case "ABORTED": {
      // safe to take the fresh path — all pendings reconciled above
      // (ABORTED runs through the journal guard inside runE2E)
      return runE2E(cfg);
    }
    case "REQUOTE_REQUIRED": {
      state = advance(state, "QUOTED", "re-quote after REQUOTE_REQUIRED");
      saveState(state);
      return runE2E(cfg);
    }
    case "SWAP_SUBMITTED": {
      const adj = await adoptJournaled(ctx, state, "swap");
      if (adj.rolledBack) {
        // journaled swap was provably dead — stage rolled back to QUOTED;
        // re-dispatch from the clean stage (audit N2-M2).
        return runResume(cfg);
      }
      state = adj.state;
      const swapOut =
        rec.outcomes.find((o) => o.step === "swap") ?? adj.outcome;
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
      // audit N-H1: a mined deposit adopted at APPROVED was consumed by
      // consumeOutcomes → stage DEPOSIT_SUBMITTED. Reaching here means no
      // deposit is in flight — finish the leg.
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
      const adj = await adoptJournaled(ctx, state, "deposit");
      state = adj.state;
      const dep =
        rec.outcomes.find((o) => o.step === "deposit") ?? adj.outcome;
      if (!dep) {
        // audit N3-L2: retry the leg ONLY when the journaled deposit was
        // proven dead (rolledBack) — otherwise the outcome is unproven and
        // signing another deposit could double-spend.
        if (!adj.rolledBack) {
          throw new Error(
            "stage DEPOSIT_SUBMITTED but no live/dead deposit proof — inspect the journal manually",
          );
        }
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
        blockNumber: dep.receipt.blockNumber,
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

/**
 * Operator exit for a wedged pending (audit N3-M2): marks a hashed pending
 * dead — only when the chain itself proves the tx never landed AND the nonce
 * slot is still free (latest == intent.nonce OR pending == intent.nonce, so
 * no OTHER tx could have consumed it either). Roll back the stage so the
 * step can be re-planned. Any live trace refuses the abandon.
 */
export async function abandonStep(cfg: ChainConfig, step: TxStep): Promise<void> {
  // deliberately not buildCtx: abandon must work even without a vault
  const client = publicClientFor(cfg);
  let state = loadState();
  const pend = state.pending[step];
  if (!pend?.txHash) {
    throw new Error(`no hashed pending for step ${step} — nothing to abandon`);
  }
  const { sender, nonce } = pend.intent;

  // audit N4-H1: absence is proven ONLY by named not-found errors — a
  // transport error refuses the abandon (fail closed), it never counts as
  // "tx absent". Two probes ≥1 block apart must BOTH come back absent, and
  // the nonce reads must show latest === pending === intent nonce (AND
  // semantics — a live mempool tx shows up in the pending count).
  const hash = pend.txHash;
  const absentProbe = async (): Promise<boolean> => {
    try {
      await client.getTransactionReceipt({ hash });
      return false; // has a receipt — live
    } catch (e) {
      if (!isNotFound(e)) {
        throw new Error(`receipt probe failed — refusing to abandon ${step}`);
      }
    }
    try {
      await client.getTransaction({ hash });
      return false; // in mempool — live
    } catch (e) {
      if (!isNotFound(e)) {
        throw new Error(`tx probe failed — refusing to abandon ${step}`);
      }
    }
    return true;
  };

  if (!(await absentProbe())) {
    throw new Error(`${step} tx ${pend.txHash} exists on-chain — refusing to abandon`);
  }
  const [latest, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: sender }),
    client.getTransactionCount({ address: sender, blockTag: "pending" }),
  ]);
  if (nonce < 0 || latest !== nonce || pendingNonce !== nonce) {
    throw new Error(
      `nonce slot not provably free (latest=${latest}, pending=${pendingNonce}, intent=${nonce}) — refusing abandon`,
    );
  }
  // second probe ≥1 block later (audit N4-H1): a tx in propagation between
  // the probes is caught here instead of being marked dead.
  const b0 = await client.getBlockNumber().catch(() => 0n);
  const deadline = Date.now() + 10_000;
  let moved = false;
  while (Date.now() < deadline && !moved) {
    const b = await client.getBlockNumber().catch(() => 0n);
    if (b0 !== 0n && b > b0) moved = true;
    else await new Promise((r) => setTimeout(r, 800));
  }
  if (!moved) {
    throw new Error("no new block within window — abandon proof incomplete, refusing");
  }
  if (!(await absentProbe())) {
    throw new Error(`${step} tx ${pend.txHash} appeared on-chain — refusing to abandon`);
  }
  // audit N5-L1: re-read BOTH nonce views after probe 2 — a tx entering the
  // pool between the probes shows up in the pending count.
  const [latest2, pending2] = await Promise.all([
    client.getTransactionCount({ address: sender }).catch(() => -1),
    client.getTransactionCount({ address: sender, blockTag: "pending" }).catch(() => -1),
  ]);
  if (latest2 !== nonce || pending2 !== nonce) {
    throw new Error(
      `nonce moved between probes (latest=${latest2}, pending=${pending2}, intent=${nonce}) — refusing abandon`,
    );
  }
  pend.intent.params.dead = "abandoned";
  // audit N5-M1(a): pin the nonce — the next same-step sign reuses this
  // slot, so two txs can never both land even if the abandoned one was
  // live somewhere this RPC could not see.
  pend.intent.params.reuseNonce = nonce;
  state = clearPending(state, step);
  const rb = SUBMIT_ROLLBACK[step];
  if (rb && state.stage === rb.submitted) {
    state = advance(state, rb.back, `${step} abandoned by operator`);
  }
  saveState(state);
  console.log(`abandoned ${step} tx ${pend.txHash} — pending cleared, stage ${state.stage}`);
}
