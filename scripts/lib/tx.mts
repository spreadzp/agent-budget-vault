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
  clearPending,
  markSubmitted,
  recordIntent,
  saveState,
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

/**
 * A persisted txHash with no receipt: in-flight if the node knows it,
 * else rebroadcast the identical journaled raw bytes (idempotent by hash).
 * Returns the receipt when the tx provably landed, or undefined when it
 * provably never did. Throws only when the outcome is genuinely unknown.
 */
export async function reconcileHashedPending(
  client: PublicClient,
  step: TxStep,
  pend: PendingTx,
): Promise<{ receipt?: TransactionReceipt; status: "mined" | "reverted" | "in-flight" | "never-sent" }> {
  const hash = pend.txHash!;
  const rcpt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
  if (rcpt) {
    return { receipt: rcpt, status: rcpt.status === "success" ? "mined" : "reverted" };
  }
  const inFlight = await client.getTransaction({ hash }).then(() => true).catch(() => false);
  if (inFlight) return { status: "in-flight" };
  // no receipt, no tx: never reached the node — rebroadcast identical bytes if present
  const raw = typeof pend.intent.params.raw === "string" ? (pend.intent.params.raw as `0x${string}`) : undefined;
  if (raw === undefined) return { status: "never-sent" };
  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
  } catch {
    // "already known" races are fine; anything else means the signed tx is dead
    // (nonce consumed by a different tx) — still never-sent by this hash.
    const rc = await client.getTransactionReceipt({ hash }).catch(() => undefined);
    if (rc) return { receipt: rc, status: rc.status === "success" ? "mined" : "reverted" };
    return { status: "never-sent" };
  }
  const rc = await client
    .waitForTransactionReceipt({ hash, timeout: 60_000 })
    .catch(() => undefined);
  if (!rc) return { status: "in-flight" };
  return { receipt: rc, status: rc.status === "success" ? "mined" : "reverted" };
}

async function adoptPending(args: {
  client: PublicClient;
  step: TxStep;
  pend: PendingTx;
  sender: `0x${string}`;
  expectedTo?: `0x${string}`;
}): Promise<{ receipt: TransactionReceipt } | { dead: "reverted" | "never-sent" } | never> {
  const { client, step, pend } = args;
  const r = await reconcileHashedPending(client, step, pend);
  if (r.status === "in-flight") {
    throw new Error(
      `${step} tx ${pend.txHash} exists but no receipt — in flight, resend forbidden (D-254-12); retry later`,
    );
  }
  if (r.status === "never-sent") {
    return { dead: "never-sent" };
  }
  if (r.status === "reverted") {
    return { dead: "reverted" };
  }
  const rcpt = r.receipt!;
  // bind the receipt to this intent (audit M5): right sender, right target
  if (rcpt.from.toLowerCase() !== args.sender.toLowerCase()) {
    throw new Error(`${step} tx ${pend.txHash} from ${rcpt.from} != signer ${args.sender}`);
  }
  const wantTo = (args.expectedTo ?? (pend.intent.params.to as string | undefined) ?? "").toLowerCase();
  if (wantTo && (rcpt.to ?? "").toLowerCase() !== wantTo) {
    throw new Error(`${step} tx ${pend.txHash} to ${rcpt.to} != expected ${args.expectedTo ?? pend.intent.params.to}`);
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
      // Provably dead: reverted on-chain, or never reached the node — a hash
      // whose signed bytes never left this journal can never land later.
      // Clearing is safe; the stage rollback is the caller's/resume's job.
      state = clearPending(state, step);
      saveState(state, statePath);
      throw new Error(
        `${step} tx ${pend.txHash} ${out.dead === "reverted" ? "reverted" : "never reached the chain"} — ` +
          `pending cleared; re-run allowed`,
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
    nonce: prepared.nonce ?? 0,
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
      throw new Error(
        `${step} broadcast failed (${broadcastErr instanceof Error ? broadcastErr.message.slice(0, 120) : String(broadcastErr)}) — ` +
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
