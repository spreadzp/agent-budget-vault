// SLICE-254-4: deposit + full stream-state verification (D-254-18).
// Audit hardening (254-7): receipt bound to vault+signer (M5), balance-delta
// check can be `skipped` (not faked ok) when the before-balance is unknown
// on a post-hoc resume (H3).
import type { PublicClient, TransactionReceipt } from "viem";
import { ERC20_ABI, VAULT_ABI, VAULT_POLICY_ABI, type VaultPolicy } from "../chain.mts";
import type { VerifyCheck } from "../peach/verification.mts";

export interface DepositVerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
}

export async function verifyDeposit(args: {
  client: PublicClient;
  receipt: TransactionReceipt;
  vault: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  /** null when unknowable post-hoc — the delta check is then skipped, not faked */
  vaultBalanceBefore: bigint | null;
  signer?: `0x${string}`;
  /** audit N-M6: read balances at this block (receipt block on resume) — a
   *  vault that streams out makes a latest-block read falsely fail */
  blockNumber?: bigint;
}): Promise<DepositVerifyResult> {
  const checks: VerifyCheck[] = [];
  const { client, receipt, vault } = args;

  checks.push({
    name: "receipt.status",
    ok: receipt.status === "success",
    detail: receipt.status,
  });
  checks.push({
    name: "receipt.to==vault",
    ok: (receipt.to ?? "").toLowerCase() === vault.toLowerCase(),
    detail: `${receipt.to} vs ${vault}`,
  });
  if (args.signer) {
    checks.push({
      name: "receipt.from==signer",
      ok: receipt.from.toLowerCase() === args.signer.toLowerCase(),
      detail: receipt.from,
    });
  }

  const events = await client.getContractEvents({
    address: vault,
    abi: VAULT_ABI,
    eventName: "Deposited",
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  const mine = events.find((e) => e.transactionHash === receipt.transactionHash);
  checks.push({
    name: "Deposited event",
    ok: Boolean(mine) && mine!.args.amount === args.amount,
    detail: mine ? `amount=${mine.args.amount}` : "not found in block",
  });

  const [bal, policy] = await Promise.all([
    client.readContract({
      address: args.token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [vault],
      ...(args.blockNumber !== undefined ? { blockNumber: args.blockNumber } : {}),
    }),
    client.readContract({ address: vault, abi: VAULT_POLICY_ABI, functionName: "policy" }) as Promise<VaultPolicy>,
  ]);

  if (args.vaultBalanceBefore === null) {
    // audit N-M6: skipped checks fail a naive `.ok` filter — they carry
    // ok:false + skipped:true and the aggregator treats them as non-blocking.
    checks.push({
      name: "vault token balance += amount",
      ok: false,
      skipped: true,
      detail: `skipped — before-balance unknown post-hoc; current ${bal}`,
    });
  } else {
    checks.push({
      name: "vault token balance += amount",
      ok: bal - args.vaultBalanceBefore === args.amount,
      detail: `${args.vaultBalanceBefore} -> ${bal}`,
    });
  }
  checks.push({
    name: "stream active (rate>0,startTime>0)",
    ok: policy.rate > 0n && policy.startTime > 0n,
    detail: `rate=${policy.rate} start=${policy.startTime}`,
  });
  checks.push({
    name: "endTime > startTime",
    ok: policy.endTime > policy.startTime,
    detail: `end=${policy.endTime} start=${policy.startTime}`,
  });
  checks.push({
    name: "not cancelled",
    ok: !policy.cancelled,
    detail: `cancelled=${policy.cancelled}`,
  });
  checks.push({
    name: "not paused",
    ok: !policy.paused,
    detail: `paused=${policy.paused}`,
  });

  return { ok: checks.every((c) => c.skipped === true || c.ok), checks };
}
