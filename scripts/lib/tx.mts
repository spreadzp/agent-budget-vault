// Guarded broadcast per D-254-12, hardened after the 254-7 audit (C1):
// the tx is signed LOCALLY first, and the txHash (derivable from the signed
// payload) is persisted BEFORE any network send. A crash anywhere after that
// point leaves pending.txHash on disk, so the next run reconciles by hash and
// can never broadcast a second copy of the financial action.
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
  resumed: boolean; // true when adopted from a prior pending entry
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

async function adoptPending(args: {
  client: PublicClient;
  step: TxStep;
  pend: PendingTx;
  sender: `0x${string}`;
  expectedTo?: `0x${string}`;
}): Promise<{ receipt: TransactionReceipt } | never> {
  const { client, step, pend } = args;
  const rcpt = await client
    .getTransactionReceipt({ hash: pend.txHash! })
    .catch(() => undefined);
  if (!rcpt) {
    const tx = await client.getTransaction({ hash: pend.txHash! }).catch(() => undefined);
    throw new Error(
      tx
        ? `${step} tx ${pend.txHash} exists but no receipt — in flight, resend forbidden (D-254-12); retry later`
        : `${step} tx ${pend.txHash} not found on-chain — TX_OUTCOME_UNKNOWN; check nonce/chain manually before any resend`,
    );
  }
  // bind the receipt to this intent (audit M5): right sender, right target
  if (rcpt.from.toLowerCase() !== args.sender.toLowerCase()) {
    throw new Error(`${step} tx ${pend.txHash} from ${rcpt.from} != signer ${args.sender}`);
  }
  const wantTo = (args.expectedTo ?? "").toLowerCase();
  if (wantTo && (rcpt.to ?? "").toLowerCase() !== wantTo) {
    throw new Error(`${step} tx ${pend.txHash} to ${rcpt.to} != expected ${args.expectedTo}`);
  }
  return { receipt: rcpt };
}

/**
 * Replay-protected send. `request` is signed and the hash journaled before
 * broadcast; pending.txHash is never absent while anything may be in flight.
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
  /** FSM advance applied right after broadcast, while tx is in flight. */
  onSubmitted?: (state: SpikeState) => SpikeState;
  /** journal path override — tests only; production uses STATE_PATH */
  statePath?: string;
}): Promise<GuardedTx> {
  const { client, wallet, step, request, statePath } = args;
  let state = args.state;
  const pend = state.pending[step];

  if (pend?.txHash) {
    const { receipt: rcpt } = await adoptPending({
      client,
      step,
      pend,
      sender: args.sender,
      expectedTo: args.expectedTo ?? request.to,
    });
    state = clearPending(state, step);
    saveState(state, statePath);
    if (rcpt.status !== "success") {
      throw new Error(`${step} tx ${pend.txHash} reverted — pending cleared; re-run allowed`);
    }
    return { state, txHash: pend.txHash, receipt: rcpt, resumed: true };
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

  // 2) persist intent AND hash before any network send — crash window closed
  state = recordIntent(state, {
    step,
    sender: args.sender,
    nonce: prepared.nonce ?? 0,
    params: args.params,
    createdAt: new Date().toISOString(),
  });
  state = markSubmitted(state, step, txHash);
  saveState(state, statePath);

  // 3) broadcast
  try {
    await client.sendRawTransaction({ serializedTransaction: raw });
  } catch (e) {
    // maybe sent (timeout/dropped response) — the hash is on disk; adopt if
    // the node already has it, else keep the intent for resume to reconcile.
    const rcpt = await client
      .getTransactionReceipt({ hash: txHash })
      .catch(() => undefined);
    if (!rcpt) {
      throw new Error(
        `${step} broadcast failed (${e instanceof Error ? e.message.slice(0, 120) : String(e)}) — ` +
          `tx ${txHash} persisted with hash; outcome unknown, resend forbidden until reconciled`,
      );
    }
  }

  // 4) stage advance after broadcast ack (hash already on disk — safe if this throws)
  if (args.onSubmitted) {
    state = args.onSubmitted(state);
    saveState(state, statePath);
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
