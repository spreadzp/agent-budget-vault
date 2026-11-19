// SLICE-254-4: deposit + full stream-state verification (D-254-18).
import type { PublicClient, TransactionReceipt } from "viem";
import { ERC20_ABI, VAULT_ABI, VAULT_POLICY_ABI, type VaultPolicy } from "../chain.mts";

export interface DepositVerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

export async function verifyDeposit(args: {
  client: PublicClient;
  receipt: TransactionReceipt;
  vault: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  vaultBalanceBefore: bigint;
}): Promise<DepositVerifyResult> {
  const checks: DepositVerifyResult["checks"] = [];
  const { client, receipt, vault } = args;

  checks.push({
    name: "receipt.status",
    ok: receipt.status === "success",
    detail: receipt.status,
  });

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
    }),
    client.readContract({ address: vault, abi: VAULT_POLICY_ABI, functionName: "policy" }) as Promise<VaultPolicy>,
  ]);

  checks.push({
    name: "vault token balance += amount",
    ok: bal - args.vaultBalanceBefore === args.amount,
    detail: `${args.vaultBalanceBefore} -> ${bal}`,
  });
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

  return { ok: checks.every((c) => c.ok), checks };
}
