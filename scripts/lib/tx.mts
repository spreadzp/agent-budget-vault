// Guarded broadcast per D-254-12: intent persisted BEFORE send, txHash
// recorded immediately after; resend while outcome unknown is forbidden.
import type { PublicClient, TransactionReceipt } from "viem";
import {
  clearPending,
  markSubmitted,
  recordIntent,
  saveState,
  type SpikeState,
  type TxStep,
} from "./state.mts";

export interface GuardedTx {
  state: SpikeState;
  txHash: `0x${string}`;
  receipt: TransactionReceipt;
  resumed: boolean; // true when adopted from a prior pending entry
}

/**
 * Replay-protected send: adopts a persisted pending tx (by txHash) if the
 * process died after broadcast, otherwise records a fresh intent, sends,
 * and waits for the receipt. Throws on revert / still-in-flight.
 */
export async function submitGuarded(args: {
  client: PublicClient;
  state: SpikeState;
  step: TxStep;
  sender: `0x${string}`;
  params: Record<string, unknown>;
  send: () => Promise<`0x${string}`>;
  /** FSM advance applied right after txHash persistence, while tx is in flight. */
  onSubmitted?: (state: SpikeState) => SpikeState;
}): Promise<GuardedTx> {
  const { client, step, send } = args;
  let state = args.state;
  const pend = state.pending[step];

  if (pend?.txHash) {
    const rcpt = await client
      .getTransactionReceipt({ hash: pend.txHash })
      .catch(() => undefined);
    if (!rcpt) {
      throw new Error(
        `${step} tx ${pend.txHash} in flight / no receipt — resend forbidden (D-254-12)`,
      );
    }
    state = clearPending(state, step);
    saveState(state);
    if (rcpt.status !== "success") {
      throw new Error(`${step} tx ${pend.txHash} reverted — pending cleared; re-run allowed`);
    }
    return { state, txHash: pend.txHash, receipt: rcpt, resumed: true };
  }
  if (pend) {
    // intent persisted but never broadcast — safe to replace
    state = clearPending(state, step);
    saveState(state);
  }

  const nonce = await client.getTransactionCount({ address: args.sender });
  state = recordIntent(state, {
    step,
    sender: args.sender,
    nonce,
    params: args.params,
    createdAt: new Date().toISOString(),
  });
  saveState(state); // persist BEFORE broadcast

  const txHash = await send();
  state = markSubmitted(state, step, txHash);
  if (args.onSubmitted) state = args.onSubmitted(state);
  saveState(state);

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  state = clearPending(state, step);
  saveState(state);
  if (receipt.status !== "success") {
    throw new Error(`${step} tx ${txHash} reverted — pending cleared; re-run allowed`);
  }
  return { state, txHash, receipt, resumed: false };
}
