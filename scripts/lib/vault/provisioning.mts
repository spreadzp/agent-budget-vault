// SLICE-254-2: `provision` — create ONE testnet BudgetVault via factory.
// Idempotent by construction (update note): state reuse + on-chain
// vaultOf[agent] lookup-before-create; replay-protected per D-254-12.
// Audit hardening (254-7): broadcast goes through submitGuarded
// (sign-before-send, hash persisted first — C1) and the vault policy check
// pins the full expected tuple, not just owner+token (H5).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, encodeFunctionData, getAddress, http, type PublicClient } from "viem";
import {
  chainOf,
  FACTORY_ABI,
  publicClientFor,
  VAULT_POLICY_ABI,
  type VaultPolicy,
} from "../chain.mts";
import { EVIDENCE_DIR, type ChainConfig } from "../config.mts";
import { accountFromEnv } from "../env.mts";
import { advance, clearPending, loadState, saveState, type SpikeState } from "../state.mts";
import { reconcileHashedPending, reconcileOrphanIntent, submitGuarded } from "../tx.mts";

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

/**
 * Full expected-tuple check (audit H5): every field createVault was called
 * with must match, plus the vault must not be cancelled or paused.
 */
export function evaluateVaultPolicy(
  p: VaultPolicy,
  expected: {
    owner: `0x${string}`;
    token: `0x${string}`;
    agent?: `0x${string}`;
    agentId?: bigint;
    registry?: `0x${string}`;
    operator?: `0x${string}`;
  },
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(p.owner, expected.owner)) failures.push(`owner ${p.owner} != expected ${expected.owner}`);
  if (!eq(p.token, expected.token)) failures.push(`token ${p.token} != expected ${expected.token}`);
  if (expected.agent !== undefined && !eq(p.agent, expected.agent))
    failures.push(`agent ${p.agent} != expected ${expected.agent}`);
  if (expected.agentId !== undefined && p.agentId !== expected.agentId)
    failures.push(`agentId ${p.agentId} != expected ${expected.agentId}`);
  if (expected.registry !== undefined && !eq(p.registry, expected.registry))
    failures.push(`registry ${p.registry} != expected ${expected.registry}`);
  if (expected.operator !== undefined && !eq(p.operator, expected.operator))
    failures.push(`operator ${p.operator} != expected ${expected.operator}`);
  if (p.cancelled) failures.push("vault is cancelled");
  if (p.paused) failures.push("vault is paused");
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

  const account = accountFromEnv(signerEnv);
  const signer = account.address;
  let state = loadState();
  const expectedToken = cfg.vaultDepositToken;
  const expectedPolicy = { ...buildProvisionParams(signer), token: expectedToken };

  const adoptVault = async (
    vault: `0x${string}`,
    txHash: `0x${string}` | undefined,
    reused: boolean,
  ): Promise<ProvisionResult> => {
    const policy = await readPolicy(client, vault);
    const chk = evaluateVaultPolicy(policy, expectedPolicy);
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
        registry: policy.registry,
        operator: policy.operator,
        token: policy.token,
        cancelled: policy.cancelled,
        paused: policy.paused,
      },
      postChecks: "ok",
    });
    return { vault, txHash, reused, policy };
  };

  // 0) already provisioned -> verify still good on-chain
  if (state.vault) {
    const policy = await readPolicy(client, state.vault);
    const chk = evaluateVaultPolicy(policy, expectedPolicy);
    if (chk.ok) return { vault: state.vault, reused: true, policy };
  }

  // 1) pending intent reconcile (crash between persist and broadcast/mine).
  // audit N2-L6: route hashed pendings through the shared reconciler so an
  // un-broadcast-but-journaled tx is rebroadcast verbatim or proven dead —
  // not wedged as "in flight" forever.
  const pend = state.pending.provision;
  if (pend?.txHash) {
    const r = await reconcileHashedPending(client, "provision", pend);
    if (r.status === "in-flight" || r.status === "unknown") {
      throw new Error(
        `provision tx ${pend.txHash} ${r.status === "in-flight" ? "in flight / no receipt" : `outcome unproven (${r.reason})`} — resend forbidden (D-254-12); retry later`,
      );
    }
    if (r.status === "mined") {
      const rcpt = r.receipt!;
      if (rcpt.from.toLowerCase() !== signer.toLowerCase() || (rcpt.to ?? "").toLowerCase() !== cfg.factory.toLowerCase()) {
        throw new Error(`provision tx ${pend.txHash} receipt does not match intent (from/to)`);
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
    // reverted or never-sent: mark dead and continue to a fresh create
    pend.intent.params.dead = r.status;
    state = persistState(clearPending(state, "provision"));
  }
  // N3-M1: only the orphan (no-txHash) branch reaches here — a hashed
  // pending was already handled above by the shared reconciler.
  if (pend && !pend.txHash) {
    await reconcileOrphanIntent(client, signer, "provision", pend);
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

  // 3) create: sign locally, persist intent+txHash BEFORE broadcast (C1)
  const params = buildProvisionParams(signer);
  const wallet = createWalletClient({
    account,
    chain: chainOf(cfg),
    transport: http(cfg.rpcUrl),
  });
  const r = await submitGuarded({
    client,
    wallet,
    state,
    step: "provision",
    sender: signer,
    params: { ...params, agentId: params.agentId.toString(), factory: cfg.factory },
    request: {
      to: cfg.factory,
      data: encodeFunctionData({
        abi: FACTORY_ABI,
        functionName: "createVault",
        args: [params.owner, params.agent, params.agentId, params.registry, params.operator],
      }),
    },
    expectedTo: cfg.factory,
  });
  state = r.state;

  const vault = getAddress(
    (await client.readContract({
      address: cfg.factory,
      abi: FACTORY_ABI,
      functionName: "vaultOf",
      args: [signer],
    })),
  );
  return adoptVault(vault, r.txHash, false);
}
