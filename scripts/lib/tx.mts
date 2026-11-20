// Guarded broadcast per D-254-12, hardened after the 254-7 audit (C1, round-2 N-H1):
// the tx is signed LOCALLY, and txHash + stage advance + the raw signed bytes
// are persisted in ONE saveState BEFORE any network send. Consequences:
//  - a crash anywhere after that save leaves stage + hash + raw consistent;
//  - the raw bytes make "hash journaled, never broadcast" self-healing:
//    resending identical bytes is idempotent by hash (audit N-M8);
//  - no window exists where the stage lags a live broadcast (audit N-H1).
//
// Legacy orphans (pending intent with no txHash, pre-hardening format) are
// reconciled by nonce: if the chain pending nonce is past intent.nonce, a tx
// consumed that nonce — we cannot prove ours never broadcast → fail closed.
import {
  keccak256,
  type Account,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import {
  advance,
  clearPending,
  markSubmitted,
  recordIntent,
  saveState,
  SUBMIT_ROLLBACK,
  type PendingTx,
  type SpikeState,
  type TxStep,
} from "./state.mts";

export interface GuardedTx {
  state: SpikeState;
  txHash: `0x${string}`;
  receipt: TransactionReceipt;
  resumed: boolean; // true when adopted/rebroadcast from a prior pending entry
}

export interface TxRequest {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
}

/** Wallet client concrete enough for prepare+sign (local account). */
export type SigningWallet = WalletClient<Transport, Chain, Account>;

/**
 * Decide what to do with a persisted intent that carries no txHash.
 * Returns "drop" only when the chain proves nothing left the wallet;
 * otherwise throws (fail closed — the intent may have been broadcast).
 */
export async function reconcileOrphanIntent(
  client: PublicClient,
  sender: `0x${string}`,
  step: TxStep,
  pend: PendingTx,
): Promise<"drop"> {
  // audit N-L1: the orphan must belong to this sender for the nonce proof
  if (pend.intent.sender.toLowerCase() !== sender.toLowerCase()) {
    throw new Error(
      `orphan ${step} intent sender ${pend.intent.sender} != signer ${sender} — refusing to decide`,
    );
  }
  const pendingNonce = await client.getTransactionCount({
    address: sender,
    blockTag: "pending",
  });
  if (pendingNonce > pend.intent.nonce) {
    throw new Error(
      `orphan ${step} intent has no txHash but chain pending nonce ${pendingNonce} > intent nonce ${pend.intent.nonce} — ` +
        `a tx at/after that nonce left the wallet; possible broadcast. Refusing resend (D-254-12); inspect manually`,
    );
  }
  return "drop";
}

export type ReconcileStatus = "mined" | "reverted" | "in-flight" | "never-sent" | "unknown";
export interface ReconcileResult {
  status: ReconcileStatus;
  receipt?: TransactionReceipt;
  reason?: string;
}

/** Rebroadcasting a journaled tx older than this is refused (audit N2-M3 +
 *  N3-M2): the embedded quote deadline is ~120s, so older signed bytes are
 *  stale — fail closed and let `abandon` clear them manually. */
export const REBROADCAST_MAX_AGE_MS = 120_000;

/** Distinguish "not found" from transport errors (audit N3-H1 + N4-M1):
 *  ONLY the exact viem error classes count as absence — a 404 body,
 *  "method not found" or "header not found" is a transport/lookup failure,
 *  never evidence. Walks the viem BaseError cause chain. */
export const isNotFound = (e: unknown): boolean => {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur !== undefined && cur !== null; depth++) {
    const name = (cur as { name?: string }).name;
    if (name === "TransactionReceiptNotFoundError" || name === "TransactionNotFoundError") {
      return true;
    }
    const cause = (cur as { cause?: unknown }).cause;
    if (cause === undefined || cause === cur || typeof cause !== "object") break;
    cur = cause;
  }
  return false;
};

const toOutcome = (p: TransactionReceipt | "in-pool" | "absent"): ReconcileResult | undefined =>
  typeof p === "object"
    ? { receipt: p, status: p.status === "success" ? "mined" : "reverted" }
    : p === "in-pool"
      ? { status: "in-flight" }
      : undefined;

/**
 * Reconcile a persisted txHash. `never-sent` is declared ONLY on airtight
 * proof (audit N3-H1): the signer's latest mined nonce moved past the
 * journaled nonce AND a SECOND independent probe at least one block later
 * still finds no receipt and no tx. A single lagging/erroring probe is
 * `unknown` — it is never a death certificate.
 */
export async function reconcileHashedPending(
  client: PublicClient,
  step: TxStep,
  pend: PendingTx,
): Promise<ReconcileResult> {
  const hash = pend.txHash!;
  const { sender, nonce } = pend.intent;

  // one pass: receipt → mempool → absent; transport errors THROW (unknown)
  const probeOnce = async (): Promise<TransactionReceipt | "in-pool" | "absent"> => {
    try {
      return await client.getTransactionReceipt({ hash });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    try {
      await client.getTransaction({ hash });
      return "in-pool";
    } catch (e) {
      if (!isNotFound(e)) throw e;
      return "absent";
    }
  };
  const probe = (): Promise<ReconcileResult | undefined> =>
    probeOnce()
      .then(toOutcome)
      .catch((e): ReconcileResult => ({
        status: "unknown",
        reason: `probe failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`,
      }));

  const readLatestNonce = (): Promise<number> =>
    client
      .getTransactionCount({ address: sender, blockTag: "latest" })
      .catch(() => -1);

  const waitNextBlock = async (): Promise<boolean> => {
    const b0 = await client.getBlockNumber().catch(() => 0n);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const b = await client.getBlockNumber().catch(() => 0n);
      if (b0 === 0n || b > b0) return b0 !== 0n;
      await new Promise((r) => setTimeout(r, 800));
    }
    return false;
  };

  /**
   * Airtight dead proof (audit N4-M2): binary-search archive reads for the
   * first block where the sender's mined nonce passed `nonce`, then check
   * whether OUR hash is in that block's body. The block body is
   * authoritative over any receipt index — lagging indexes can't fake it.
   * Returns "ours" | "other" | undefined (inconclusive ⇒ unknown).
   */
  const consumingBlock = async (): Promise<bigint | "ours" | "other" | undefined> => {
    const hi = await client.getBlockNumber().catch(() => undefined);
    if (hi === undefined) return undefined;
    const cHi = await client
      .getTransactionCount({ address: sender, blockNumber: hi })
      .catch(() => undefined);
    if (cHi === undefined || cHi <= nonce) return undefined;
    let lo = 0n;
    let h = hi;
    while (h - lo > 1n) {
      const mid = (lo + h) >> 1n;
      const c = await client
        .getTransactionCount({ address: sender, blockNumber: mid })
        .catch(() => undefined);
      if (c === undefined) return undefined;
      if (c > nonce) h = mid;
      else lo = mid;
    }
    const body = await client
      .getBlock({ blockNumber: h, includeTransactions: true })
      .catch(() => undefined);
    if (!body) return undefined;
    const hit = (body.transactions as readonly (string | { hash: string })[]).some(
      (t) => (typeof t === "string" ? t : t.hash).toLowerCase() === hash.toLowerCase(),
    );
    return hit ? "ours" : "other";
  };

  const p1 = await probe();
  if (p1) return p1;

  // p1 was "absent" — check whether the nonce slot is already consumed
  let latest = await readLatestNonce();
  if (latest === -1) return { status: "unknown", reason: "nonce read failed" };
  let nonceTaken = nonce >= 0 && latest > nonce;

  if (!nonceTaken) {
    // nonce free: rebroadcast the journaled raw bytes if we hold them
    const raw =
      typeof pend.intent.params.raw === "string"
        ? (pend.intent.params.raw as `0x${string}`)
        : undefined;
    if (raw === undefined) {
      return {
        status: "unknown",
        reason: `no receipt/tx for ${hash} and no journaled raw — outcome unproven`,
      };
    }
    if (keccak256(raw) !== hash) {
      return { status: "unknown", reason: "keccak256(raw) != journaled txHash — journal corruption" };
    }
    const ageMs = Date.now() - Date.parse(pend.intent.createdAt);
    if (!Number.isFinite(ageMs) || ageMs > REBROADCAST_MAX_AGE_MS) {
      return {
        status: "unknown",
        reason: `intent ${Number.isFinite(ageMs) ? `stale (${Math.round(ageMs / 1000)}s > ${REBROADCAST_MAX_AGE_MS / 1000}s deadline)` : "has malformed createdAt"} — run 'abandon ${step}' to mark it dead`,
      };
    }
    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      // resend rejected — maybe "already known" (node holds it) or the nonce
      // was taken meanwhile; re-probe before deciding anything.
      const p2 = await probe();
      if (p2) return p2;
      latest = await readLatestNonce();
      if (latest === -1 || !(nonce >= 0 && latest > nonce)) {
        return {
          status: "unknown",
          reason: `rebroadcast rejected (${String((e as Error)?.message ?? e).slice(0, 80)}) — outcome unproven`,
        };
      }
      nonceTaken = true;
    }
    if (!nonceTaken) {
      const rc = await client
        .waitForTransactionReceipt({ hash, timeout: 60_000 })
        .catch(() => undefined);
      if (rc) return { receipt: rc, status: rc.status === "success" ? "mined" : "reverted" };
      return { status: "in-flight", reason: "rebroadcast accepted — awaiting receipt" };
    }
  }

  // nonceTaken: still require a SECOND absent probe ≥1 block later, then the
  // airtight block-body check — find the nonce-crossing block and prove our
  // hash is not in it (audit N3-H1 + N4-M2).
  const moved = await waitNextBlock();
  const p2 = await probe();
  if (p2) return p2;
  if (!moved) {
    return { status: "unknown", reason: "no new block within window — dead proof incomplete" };
  }
  const cross = await consumingBlock();
  if (cross === "ours") {
    // our own tx consumed the slot — it IS mined; the receipt index is just
    // lagging. Fetch it; if the index still misses, the tx is provably on
    // chain so reporting in-flight keeps it safe (no resend ever).
    const rcpt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
    if (rcpt) return { receipt: rcpt, status: rcpt.status === "success" ? "mined" : "reverted" };
    return { status: "in-flight", reason: `hash present in block body; receipt index lagging` };
  }
  if (cross === "other") {
    return {
      status: "never-sent",
      reason: `nonce ${nonce} consumed by a different tx (block-body proof) — hash absent`,
    };
  }
  return {
    status: "unknown",
    reason: `nonce ${nonce} consumed but crossing block unprovable (archive read failed) — dead unproven`,
  };
}

/**
 * Signing guard (audit N2-H1/#4): refuse to sign a fresh `step` tx when the
 * journal holds a live (mined / in-flight / rebroadcastable / unproven)
 * same-step hash journaled since the last completed DEPOSITED. Exempt:
 * proven-reverted hashes and dead-marked intents — but a dead flag is only
 * trusted AFTER a receipt re-probe also comes back empty (audit N3-H1 #5),
 * so a misclassified flag cannot hide a live tx.
 */
export async function liveMoneyIntentReason(
  client: PublicClient,
  state: SpikeState,
  step?: TxStep,
): Promise<string | undefined> {
  const doneTimes = state.history
    .filter((h) => h.stage === "DEPOSITED")
    .map((h) => h.at)
    .sort();
  const lastDone = doneTimes.length ? doneTimes[doneTimes.length - 1] : undefined;
  for (const i of state.intents) {
    if (i.step !== "swap" && i.step !== "deposit") continue;
    if (step && i.step !== step) continue;
    if (i.txHash === undefined) continue;
    if (lastDone !== undefined && i.createdAt <= lastDone) continue;
    // audit N4-L1: a transport error on the receipt probe is NOT absence —
    // block rather than trusting any flag or inference on flaky RPC.
    let rcpt: TransactionReceipt | undefined;
    try {
      rcpt = await client.getTransactionReceipt({ hash: i.txHash });
    } catch (e) {
      if (!isNotFound(e)) return `${i.step} ${i.txHash} receipt probe failed — outcome unproven`;
    }
    if (rcpt) {
      if (rcpt.status === "success") return `${i.step} ${i.txHash} is mined`;
      continue; // reverted consumed nothing
    }
    let inFlight = false;
    try {
      await client.getTransaction({ hash: i.txHash });
      inFlight = true;
    } catch (e) {
      if (!isNotFound(e)) return `${i.step} ${i.txHash} tx probe failed — outcome unproven`;
    }
    if (inFlight) return `${i.step} ${i.txHash} is in-flight`;
    // audit N4-H1: a dead flag is trusted only AFTER live probes come back
    // empty — an "abandoned" hash that is still in the pool stays blocking.
    if (typeof i.params.dead === "string") continue;
    if (typeof i.params.raw === "string") {
      return `${i.step} ${i.txHash} has journaled raw bytes (rebroadcastable)`;
    }
    // no receipt, no tx, no raw, not dead-marked: death unproven → block
    return `${i.step} ${i.txHash} outcome unproven`;
  }
  return undefined;
}

async function adoptPending(args: {
  client: PublicClient;
  step: TxStep;
  pend: PendingTx;
  sender: `0x${string}`;
  expectedTo?: `0x${string}`;
}): Promise<{ receipt: TransactionReceipt } | { dead: "reverted" | "never-sent" }> {
  const { client, step, pend } = args;
  const r = await reconcileHashedPending(client, step, pend);
  if (r.status === "in-flight") {
    throw new Error(
      `${step} tx ${pend.txHash} exists but no receipt — in flight, resend forbidden (D-254-12); retry later`,
    );
  }
  if (r.status === "unknown") {
    throw new Error(
      `${step} tx ${pend.txHash} outcome unproven (${r.reason}) — fail closed, resend forbidden`,
    );
  }
  if (r.status === "never-sent" || r.status === "reverted") {
    return { dead: r.status };
  }
  const rcpt = r.receipt!;
  // bind the receipt to this intent (audit M5): right sender, right target
  if (rcpt.from.toLowerCase() !== args.sender.toLowerCase()) {
    throw new Error(`${step} tx ${pend.txHash} from ${rcpt.from} != signer ${args.sender}`);
  }
  const wantTo = (args.expectedTo ?? (pend.intent.params.to as string | undefined) ?? "").toLowerCase();
  if (wantTo && (rcpt.to ?? "").toLowerCase() !== wantTo) {
    throw new Error(`${step} tx ${pend.txHash} to ${rcpt.to ?? "null"} != expected ${wantTo}`);
  }
  return { receipt: rcpt };
}

/**
 * Replay-protected send. `request` is signed; hash + stage + raw bytes are
 * journaled atomically before broadcast; adopted pendings are bound to the
 * intent's sender/target.
 */
export async function submitGuarded(args: {
  client: PublicClient;
  wallet: SigningWallet;
  state: SpikeState;
  step: TxStep;
  sender: `0x${string}`;
  params: Record<string, unknown>;
  request: TxRequest;
  /** receipt.to must equal this (defaults to request.to) — audit M5 */
  expectedTo?: `0x${string}`;
  /**
   * FSM advance applied to the SAME save as the txHash — runs BEFORE
   * broadcast (audit N-H1). Must be idempotent on re-entry stages.
   */
  onSubmitted?: (state: SpikeState) => SpikeState;
  /** fired after the broadcast attempt (drill/crash simulation hook). */
  onBroadcasted?: (state: SpikeState) => void;
  /** journal path override — tests only; production uses STATE_PATH */
  statePath?: string;
}): Promise<GuardedTx> {
  const { client, wallet, step, request, statePath } = args;
  let state = args.state;
  const pend = state.pending[step];

  if (pend?.txHash) {
    const out = await adoptPending({
      client,
      step,
      pend,
      sender: args.sender,
      expectedTo: args.expectedTo ?? request.to,
    });
    if ("dead" in out) {
      // Provably dead: reverted on-chain, or nonce consumed by another tx —
      // this hash can never land. Mark the intent dead so guards skip it,
      // then clear and roll the stage back so resume can re-plan (N3-L1).
      pend.intent.params.dead = out.dead;
      state = clearPending(state, step);
      const rb = SUBMIT_ROLLBACK[step];
      if (rb && state.stage === rb.submitted) {
        state = advance(state, rb.back, `${step} tx ${out.dead}`);
      }
      saveState(state, statePath);
      throw new Error(
        `${step} tx ${pend.txHash} ${out.dead === "reverted" ? "reverted" : "never reached the chain"} — ` +
          `pending cleared (intent marked dead); run 'resume' to retry`,
      );
    }
    state = clearPending(state, step);
    saveState(state, statePath);
    return { state, txHash: pend.txHash, receipt: out.receipt, resumed: true };
  }
  if (pend) {
    await reconcileOrphanIntent(client, args.sender, step, pend);
    state = clearPending(state, step);
    saveState(state, statePath);
  }

  // audit N2-H1: never sign a second same-step money tx while a live
  // journaled hash exists for this run — resume reconciles those first.
  if (step === "swap" || step === "deposit") {
    const live = await liveMoneyIntentReason(client, state, step);
    if (live) {
      throw new Error(`${live} — refusing to sign another ${step}; run 'resume' to reconcile`);
    }
  }

  // 1) prepare + sign locally — txHash known before broadcast
  const prepared = await wallet.prepareTransactionRequest({
    account: wallet.account,
    to: request.to,
    data: request.data,
    value: request.value ?? 0n,
  });
  const raw = await wallet.signTransaction(prepared);
  const txHash = keccak256(raw);

  // 2) ONE atomic save: intent + txHash + raw bytes + stage advance — all
  // persisted before any network send (audit N-H1). raw is signed payload,
  // not key material; it is needed for idempotent rebroadcast (N-M8).
  state = recordIntent(state, {
    step,
    sender: args.sender,
    nonce: prepared.nonce ?? -1, // -1 = unknown; nonce-based dead proof skipped
    params: { ...args.params, raw, to: request.to },
    createdAt: new Date().toISOString(),
  });
  state = markSubmitted(state, step, txHash);
  if (args.onSubmitted) state = args.onSubmitted(state);
  saveState(state, statePath);

  // 3) broadcast the identical signed bytes
  let broadcastErr: unknown;
  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    // response lost — node may still have it; the hash is on disk either way
    broadcastErr = e;
  }
  if (args.onBroadcasted) args.onBroadcasted(state);
  if (broadcastErr !== undefined) {
    const rcpt = await client.getTransactionReceipt({ hash: txHash }).catch(() => undefined);
    if (!rcpt) {
      const why =
        broadcastErr instanceof Error
          ? broadcastErr.message.slice(0, 120)
          : typeof broadcastErr === "string"
            ? broadcastErr.slice(0, 120)
            : "unknown broadcast error";
      throw new Error(
        `${step} broadcast failed (${why}) — ` +
          `tx ${txHash} persisted (hash+raw); resume will rebroadcast identical bytes or reconcile`,
      );
    }
  }

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.from.toLowerCase() !== args.sender.toLowerCase()) {
    throw new Error(`${step} tx ${txHash} from ${receipt.from} != signer ${args.sender}`);
  }
  const wantTo = (args.expectedTo ?? request.to).toLowerCase();
  if ((receipt.to ?? "").toLowerCase() !== wantTo) {
    throw new Error(`${step} tx ${txHash} to ${receipt.to} != expected ${args.expectedTo ?? request.to}`);
  }
  state = clearPending(state, step);
  saveState(state, statePath);
  if (receipt.status !== "success") {
    throw new Error(`${step} tx ${txHash} reverted — pending cleared; re-run allowed`);
  }
  return { state, txHash, receipt, resumed: false };
}
