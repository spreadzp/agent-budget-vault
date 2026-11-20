// Regression tests for audit C1 (254-7): the txHash must be persisted BEFORE
// broadcast, and an adopted/orphaned intent must never produce a second send.
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type TransactionReceipt } from "viem";
import {
  initialState,
  loadState,
  markSubmitted,
  recordIntent,
  saveState,
  type SpikeState,
} from "./state.mts";
import { submitGuarded } from "./tx.mts";

const SENDER = "0x9264365408D363E7f142828f063077d7ab7C41d9" as const;
const TO = "0x3600000000000000000000000000000000000000" as const;
const REQ = { to: TO, data: "0xa9059cbb" as `0x${string}` };
const SIGNED = "0x02f8b0deadbeefcafe" as `0x${string}`;
const SIGNED_HASH = keccak256(SIGNED);

const dirs: string[] = [];
let stateFile = "";
beforeEach(() => {
  const d = mkdtempSync(join(tmpdir(), "peach-tx-"));
  dirs.push(d);
  stateFile = join(d, "state.json");
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const okReceipt = (hash: string, over: Partial<TransactionReceipt> = {}) =>
  ({
    status: "success",
    transactionHash: hash,
    from: SENDER,
    to: TO,
    logs: [],
    ...over,
  }) as unknown as TransactionReceipt;

/** mode: ok | lost-response (node accepted, reply lost) | rejected (never arrived) */
function mockClients(mode: "ok" | "lost-response" | "rejected" = "ok", pendingNonce = 7) {
  let broadcasts = 0;
  let blockNumber = 100n;
  const seen = new Set<string>();
  const nf = (name: string): Error => Object.assign(new Error("not found"), { name });
  const wallet = {
    account: { address: SENDER },
    prepareTransactionRequest: async () => ({ nonce: 7 }),
    signTransaction: async () => SIGNED,
  };
  const client = {
    getBlockNumber: async () => ++blockNumber,
    // archive nonce reads: the slot crossing 7 → 8 happened at block 60
    getTransactionCount: async (a?: { blockNumber?: bigint }) =>
      a?.blockNumber !== undefined ? (a.blockNumber >= 60n ? pendingNonce : 7) : pendingNonce,
    // crossing block (≥60): a DIFFERENT tx from the same sender at nonce 7
    // consumed the slot — airtight "other" for the block-body proof.
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) =>
      blockNumber !== undefined && blockNumber >= 60n
        ? { transactions: [{ hash: "0xaaa0000000000000000000000000000000000000000000000000000000000001", from: SENDER, nonce: 7 }] }
        : { transactions: [] },
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (!seen.has(hash)) throw nf("TransactionReceiptNotFoundError");
      return okReceipt(hash);
    },
    getTransaction: async ({ hash }: { hash: string }) => {
      if (!seen.has(hash)) throw nf("TransactionNotFoundError");
      return { hash };
    },
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
      broadcasts++;
      const h = keccak256(serializedTransaction as `0x${string}`);
      if (mode !== "rejected") seen.add(h);
      if (mode === "ok") return h;
      throw new Error(mode === "lost-response" ? "HTTP timeout" : "connection refused");
    },
    waitForTransactionReceipt: async ({ hash }: { hash: string }) => okReceipt(hash),
  };
  return { wallet, client, broadcasts: () => broadcasts, seen };
}

const base = (client: unknown, wallet: unknown, state: SpikeState) => ({
  client: client as never,
  wallet: wallet as never,
  state,
  step: "swap" as const,
  sender: SENDER,
  params: { amountIn: "5000000" },
  request: REQ,
  statePath: stateFile,
});

describe("submitGuarded — sign-before-broadcast (audit C1)", () => {
  test("txHash is persisted to disk before broadcast", async () => {
    const { client, wallet } = mockClients("ok");
    let observed: string | undefined;
    const wrapped = {
      ...client,
      sendRawTransaction: async (a: { serializedTransaction: string }) => {
        const onDisk = loadState(stateFile);
        observed = onDisk.pending.swap?.txHash;
        return client.sendRawTransaction(a);
      },
    };
    const s0 = initialState();
    saveState(s0, stateFile);
    const r = await submitGuarded({ ...base(wrapped, wallet, s0), request: REQ });
    expect(r.txHash).toBe(SIGNED_HASH);
    expect(observed).toBe(SIGNED_HASH);
  });

  test("lost response → receipt found in catch → adopt, no second send", async () => {
    const { client, wallet, broadcasts } = mockClients("lost-response");
    const s0 = initialState();
    saveState(s0, stateFile);
    const r = await submitGuarded({ ...base(client, wallet, s0), request: REQ });
    expect(r.txHash).toBe(SIGNED_HASH);
    expect(broadcasts()).toBe(1);
  });

  test("rejected → hash still on disk → next run adopts by hash, zero re-send", async () => {
    const { client, wallet, broadcasts, seen } = mockClients("rejected");
    const s0 = initialState();
    saveState(s0, stateFile);

    await expect(
      submitGuarded({ ...base(client, wallet, s0), request: REQ }),
    ).rejects.toThrow(/broadcast failed|outcome unknown/);
    const onDisk = loadState(stateFile);
    expect(onDisk.pending.swap?.txHash).toBe(SIGNED_HASH);

    // node accepted it after all — run 2 must adopt, never re-send
    seen.add(SIGNED_HASH);
    const r = await submitGuarded({ ...base(client, wallet, loadState(stateFile)), request: REQ });
    expect(r.resumed).toBe(true);
    expect(r.txHash).toBe(SIGNED_HASH);
    expect(broadcasts()).toBe(1); // one broadcast total — the first
  });

  test("orphan intent (no txHash) + pending nonce moved → refuse resend", async () => {
    const { client, wallet } = mockClients("ok", 8);
    let s = initialState();
    s = recordIntent(s, {
      step: "swap",
      sender: SENDER,
      nonce: 7,
      params: {},
      createdAt: new Date().toISOString(),
    });
    saveState(s, stateFile);
    await expect(
      submitGuarded({ ...base(client, wallet, s), request: REQ }),
    ).rejects.toThrow(/possible broadcast|Refusing resend/i);
  });

  test("orphan intent + nonce unchanged → drop and send fresh", async () => {
    const { client, wallet, broadcasts } = mockClients("ok", 7);
    let s = initialState();
    s = recordIntent(s, {
      step: "swap",
      sender: SENDER,
      nonce: 7,
      params: {},
      createdAt: new Date().toISOString(),
    });
    saveState(s, stateFile);
    const r = await submitGuarded({ ...base(client, wallet, s), request: REQ });
    expect(r.resumed).toBe(false);
    expect(broadcasts()).toBe(1);
  });

  // audit N2-H1: missing receipt + missing tx + no raw is UNKNOWN, not dead —
  // an RPC error is never proof of death. Fail closed, keep the pending.
  test("pending with txHash + no receipt + no tx + no raw → unknown, fail closed", async () => {
    const { client, wallet, broadcasts } = mockClients("ok");
    let s = initialState();
    s = recordIntent(s, {
      step: "swap",
      sender: SENDER,
      nonce: 7,
      params: {}, // no journaled raw → death cannot be proven
      createdAt: new Date().toISOString(),
    });
    s = markSubmitted(s, "swap", "0xdeadbeef00000000000000000000000000000000000000000000000000000001");
    saveState(s, stateFile);
    await expect(
      submitGuarded({ ...base(client, wallet, s), request: REQ }),
    ).rejects.toThrow(/outcome unproven|fail closed/);
    expect(broadcasts()).toBe(0);
    expect(loadState(stateFile).pending.swap?.txHash).toBeDefined();
  });

  // audit N2-H1: 'never-sent' is airtight only when the chain proves the
  // nonce slot was consumed by a different tx (latest nonce > journaled).
  test("pending with txHash + nonce consumed on-chain → provably dead", async () => {
    const { client, wallet } = mockClients("ok", 8);
    let s = initialState();
    s = recordIntent(s, {
      step: "swap",
      sender: SENDER,
      nonce: 7,
      params: {},
      createdAt: new Date().toISOString(),
    });
    s = markSubmitted(s, "swap", "0xdeadbeef00000000000000000000000000000000000000000000000000000001");
    saveState(s, stateFile);
    await expect(
      submitGuarded({ ...base(client, wallet, s), request: REQ }),
    ).rejects.toThrow(/never reached the chain|pending cleared/);
    const disk = loadState(stateFile);
    expect(disk.pending.swap).toBeUndefined();
    expect(disk.intents[disk.intents.length - 1]?.params.dead).toBe("never-sent");
  });

  // audit N-H1+N-M8: crash after the atomic save but before broadcast → the
  // journaled raw is resent verbatim (idempotent by hash), never re-signed.
  test("never-broadcast hash+raw → rebroadcast identical bytes, no new signature", async () => {
    const { client, wallet, seen } = mockClients("rejected");
    const s0 = initialState();
    saveState(s0, stateFile);

    let signs = 0;
    const counting = {
      ...wallet,
      signTransaction: async (p: unknown) => {
        signs++;
        void p;
        return wallet.signTransaction();
      },
    };
    await expect(
      submitGuarded({ ...base(client, counting, s0), request: REQ }),
    ).rejects.toThrow(/broadcast failed/);
    expect(signs).toBe(1);

    // run 2: pending carries txHash+raw; node knows nothing → the SAME signed
    // bytes are resent verbatim (seen.add models node acceptance this time).
    const accepting = {
      ...(client as Record<string, unknown>),
      sendRawTransaction: async (a: { serializedTransaction: string }) => {
        const h = keccak256(a.serializedTransaction as `0x${string}`);
        seen.add(h);
        return h;
      },
    };
    const r = await submitGuarded({
      ...base(client, counting, loadState(stateFile)),
      request: REQ,
      client: accepting as never,
    });
    expect(r.txHash).toBe(SIGNED_HASH);
    expect(r.resumed).toBe(true);
    expect(signs).toBe(1); // no second signature — identical bytes resent
  });

  test("receipt bound to sender/target — foreign receipt rejected", async () => {
    const { client, wallet } = mockClients("ok");
    let s = initialState();
    s = recordIntent(s, {
      step: "swap",
      sender: SENDER,
      nonce: 7,
      params: {},
      createdAt: new Date().toISOString(),
    });
    s = markSubmitted(s, "swap", "0xdeadbeef00000000000000000000000000000000000000000000000000000001");
    saveState(s, stateFile);
    const foreign = {
      ...client,
      getTransactionReceipt: async () =>
        okReceipt("0xdeadbeef00000000000000000000000000000000000000000000000000000001", {
          from: "0x00000000000000000000000000000000000000ff",
        }),
    };
    await expect(
      submitGuarded({ ...base(foreign, wallet, s), request: REQ }),
    ).rejects.toThrow(/!= signer/);
  });
});
