// SLICE-254-2: `provision` — create ONE testnet BudgetVault via factory.
// Idempotent by construction (update note): state reuse + on-chain
// vaultOf[agent] lookup-before-create; replay-protected per D-254-12.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, getAddress, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  chainOf,
  FACTORY_ABI,
  publicClientFor,
  VAULT_POLICY_ABI,
  type VaultPolicy,
} from "../chain.mts";
import { EVIDENCE_DIR, type ChainConfig } from "../config.mts";
import { requiredEnv } from "../env.mts";
import {
  advance,
  clearPending,
  loadState,
  markSubmitted,
  recordIntent,
  saveState,
  type SpikeState,
} from "../state.mts";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const PROVISION_EVIDENCE = join(EVIDENCE_DIR, "provision.json");

export interface ProvisionParams {
  owner: `0x${string}`;
  agent: `0x${string}`;
  agentId: bigint;
  registry: `0x${string}`;
  operator: `0x${string}`;
}

export function buildProvisionParams(signer: `0x${string}`): ProvisionParams {
  return { owner: signer, agent: signer, agentId: 254n, registry: ZERO, operator: ZERO };
}

export function evaluateVaultPolicy(
  p: VaultPolicy,
  expected: { owner: `0x${string}`; token: `0x${string}` },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (p.owner.toLowerCase() !== expected.owner.toLowerCase())
    failures.push(`owner ${p.owner} != expected ${expected.owner}`);
  if (p.token.toLowerCase() !== expected.token.toLowerCase())
    failures.push(`token ${p.token} != expected ${expected.token}`);
  if (p.cancelled) failures.push("vault is cancelled");
  return { ok: failures.length === 0, failures };
}

async function readPolicy(client: PublicClient, vault: `0x${string}`): Promise<VaultPolicy> {
  return (await client.readContract({
    address: vault,
    abi: VAULT_POLICY_ABI,
    functionName: "policy",
  })) as VaultPolicy;
}

function persistState(s: SpikeState): SpikeState {
  saveState(s);
  return s;
}

function writeProvisionEvidence(rec: Record<string, unknown>): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(PROVISION_EVIDENCE, `${JSON.stringify(rec, null, 2)}\n`);
  return PROVISION_EVIDENCE;
}

export interface ProvisionResult {
  vault: `0x${string}`;
  txHash?: `0x${string}`;
  reused: boolean;
  policy: VaultPolicy;
}

export async function provision(
  cfg: ChainConfig,
  signerEnv = "PRIVATE_KEY",
): Promise<ProvisionResult> {
  const client = publicClientFor(cfg);
  const chainId = await client.getChainId();
  if (chainId !== cfg.chainId)
    throw new Error(`post-check chainId: RPC reports ${chainId}, expected ${cfg.chainId}`);

  const account = privateKeyToAccount(
    (requiredEnv(signerEnv).startsWith("0x")
      ? requiredEnv(signerEnv)
      : `0x${requiredEnv(signerEnv)}`) as `0x${string}`,
  );
  const signer = account.address;
  let state = loadState();
  const expectedToken = cfg.vaultDepositToken;

  const adoptVault = async (
    vault: `0x${string}`,
    txHash: `0x${string}` | undefined,
    reused: boolean,
  ): Promise<ProvisionResult> => {
    const policy = await readPolicy(client, vault);
    const chk = evaluateVaultPolicy(policy, { owner: signer, token: expectedToken });
    if (!chk.ok) throw new Error(`vault post-checks failed: ${chk.failures.join("; ")}`);
    if (state.stage === "INIT") state = advance(state, "PROVISIONED", `vault ${vault}`);
    state = { ...state, vault };
    persistState(state);
    writeProvisionEvidence({
      slice: "254-2",
      at: new Date().toISOString(),
      chainId: cfg.chainId,
      vault,
      txHash: txHash ?? null,
      reused,
      signer,
      policy: {
        owner: policy.owner,
        agent: policy.agent,
        agentId: policy.agentId.toString(),
        token: policy.token,
        cancelled: policy.cancelled,
      },
      postChecks: "ok",
    });
    return { vault, txHash, reused, policy };
  };

  // 0) already provisioned -> verify still good on-chain
  if (state.vault) {
    const policy = await readPolicy(client, state.vault);
    const chk = evaluateVaultPolicy(policy, { owner: signer, token: expectedToken });
    if (chk.ok) return { vault: state.vault, reused: true, policy };
  }

  // 1) pending intent reconcile (crash between persist and broadcast/mine)
  const pend = state.pending.provision;
  if (pend?.txHash) {
    const rcpt = await client
      .getTransactionReceipt({ hash: pend.txHash })
      .catch(() => undefined);
    if (!rcpt) {
      throw new Error(
        `provision tx ${pend.txHash} in flight / no receipt — resend forbidden (D-254-12); retry later`,
      );
    }
    if (rcpt.status !== "success") {
      state = persistState(clearPending(state, "provision"));
      throw new Error(`provision tx ${pend.txHash} reverted — pending cleared, re-run allowed`);
    }
    const vault = (await client.readContract({
      address: cfg.factory,
      abi: FACTORY_ABI,
      functionName: "vaultOf",
      args: [signer],
    }));
    state = persistState(clearPending(state, "provision"));
    if (vault === ZERO) throw new Error(`tx ${pend.txHash} mined but vaultOf==0 — investigate`);
    return adoptVault(vault, pend.txHash, true);
  }
  if (pend) {
    // intent persisted but never broadcast — safe to replace
    state = persistState(clearPending(state, "provision"));
  }

  // 2) lookup-before-create: factory already knows a vault for this agent
  const existing = (await client.readContract({
    address: cfg.factory,
    abi: FACTORY_ABI,
    functionName: "vaultOf",
    args: [signer],
  }));
  if (existing !== ZERO) return adoptVault(existing, undefined, true);

  // 3) create: persist tx-intent BEFORE broadcast (D-254-12)
  const params = buildProvisionParams(signer);
  const nonce = await client.getTransactionCount({ address: signer });
  state = persistState(
    recordIntent(state, {
      step: "provision",
      sender: signer,
      nonce,
      params: { ...params, agentId: params.agentId.toString(), factory: cfg.factory },
      createdAt: new Date().toISOString(),
    }),
  );

  const wallet = createWalletClient({
    account,
    chain: chainOf(cfg),
    transport: http(cfg.rpcUrl),
  });
  const txHash = await wallet.writeContract({
    address: cfg.factory,
    abi: FACTORY_ABI,
    functionName: "createVault",
    args: [params.owner, params.agent, params.agentId, params.registry, params.operator],
    chain: chainOf(cfg),
  });
  state = persistState(markSubmitted(state, "provision", txHash));

  const rcpt = await client.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== "success") {
    state = persistState(clearPending(state, "provision"));
    throw new Error(`createVault tx ${txHash} reverted — pending cleared, re-run allowed`);
  }
  const vault = getAddress(
    (await client.readContract({
      address: cfg.factory,
      abi: FACTORY_ABI,
      functionName: "vaultOf",
      args: [signer],
    })),
  );
  state = persistState(clearPending(state, "provision"));
  return adoptVault(vault, txHash, false);
}
