/**
 * useVaultDiscovery — reads all vaults from the factory.
 *
 * Two access patterns:
 *  - byOwner(address): scans all vaults, returns those whose policy.owner === address.
 *  - byAgent(address): calls factory.vaultOf(address) directly (O(1)).
 */
import { useReadContract, useReadContracts } from 'wagmi';
import { useMemo } from 'react';
import type { Abi } from 'viem';
import { FACTORY_ADDRESS, FACTORY_ABI, VAULT_ABI, ARC_CHAIN_ID } from '../contracts';
import { formatUsdc } from '@/onchain-money';

const FACTORY_ABI_TYPED = FACTORY_ABI as Abi;
const VAULT_ABI_TYPED = VAULT_ABI as Abi;

export interface PolicyView {
  owner: `0x${string}`;
  agent: `0x${string}`;
  operator: `0x${string}`;
  agentId: bigint;
  registry: `0x${string}`;
  token: `0x${string}`;
  rate: bigint;
  startTime: bigint;
  endTime: bigint;
  perTxCap: bigint;
  paused: boolean;
  cancelled: boolean;
  vested: bigint;
  claimed: bigint;
  claimable: bigint;
  payees: readonly `0x${string}`[];
}

export interface VaultInfo {
  address: `0x${string}`;
  policy: PolicyView;
  status: 'active' | 'paused' | 'cancelled' | 'expired' | 'unfunded';
}

function vaultStatus(p: PolicyView): VaultInfo['status'] {
  if (p.cancelled) return 'cancelled';
  if (p.paused) return 'paused';
  if (p.rate === 0n) return 'unfunded';
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (p.endTime > 0n && now > p.endTime) return 'expired';
  return 'active';
}

const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const factoryEnabled = Boolean(FACTORY_ADDRESS);

// ── Owner-side: list all vaults, filter by owner ──────────────────────────

export function useOwnerVaults(ownerAddress?: `0x${string}`) {
  // 1. vaultCount
  const { data: countRaw, refetch: refetchCount } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI_TYPED,
    functionName: 'vaultCount',
    chainId: ARC_CHAIN_ID,
    query: { enabled: factoryEnabled, refetchInterval: 10_000 },
  });
  const count = typeof countRaw === 'bigint' ? Number(countRaw) : 0;

  // 2. vaults(i) for i in [0, count)
  const vaultIndexContracts = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI_TYPED,
        functionName: 'vaults',
        args: [BigInt(i)],
        chainId: ARC_CHAIN_ID,
      })),
    [count],
  );

  const { data: vaultAddrsRaw, refetch: refetchAddrs } = useReadContracts({
    contracts: vaultIndexContracts,
    query: { enabled: factoryEnabled && count > 0 },
  });

  const vaultAddrs = useMemo(
    () =>
      (vaultAddrsRaw ?? [])
        .map((r) => (r.status === 'success' ? (r.result as `0x${string}`) : null))
        .filter(Boolean) as `0x${string}`[],
    [vaultAddrsRaw],
  );

  // 3. policy() per vault
  const policyContracts = useMemo(
    () =>
      vaultAddrs.map((addr) => ({
        address: addr,
        abi: VAULT_ABI_TYPED,
        functionName: 'policy',
        args: [],
        chainId: ARC_CHAIN_ID,
      })),
    [vaultAddrs],
  );

  const { data: policiesRaw, refetch: refetchPolicies } = useReadContracts({
    contracts: policyContracts,
    query: {
      enabled: vaultAddrs.length > 0,
      refetchInterval: 10_000,
    },
  });

  const vaults: VaultInfo[] = useMemo(() => {
    if (!policiesRaw) return [];
    return policiesRaw
      .map((r, i) => {
        if (r.status !== 'success') return null;
        const p = r.result as PolicyView;
        if (ownerAddress && p.owner.toLowerCase() !== ownerAddress.toLowerCase()) return null;
        return {
          address: vaultAddrs[i],
          policy: p,
          status: vaultStatus(p),
        };
      })
      .filter(Boolean) as VaultInfo[];
  }, [policiesRaw, vaultAddrs, ownerAddress]);

  const refetch = () => {
    void refetchCount();
    void refetchAddrs();
    void refetchPolicies();
  };

  return { vaults, count, refetch, loading: !policiesRaw && vaultAddrs.length > 0 };
}

// ── Agent-side: resolve single vault via vaultOf(agent) ──────────────────

export function useAgentVault(agentAddress?: `0x${string}`) {
  const { data: vaultAddrRaw, refetch: refetchAddr } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI_TYPED,
    functionName: 'vaultOf',
    args: [agentAddress ?? ZERO],
    chainId: ARC_CHAIN_ID,
    query: { enabled: factoryEnabled && Boolean(agentAddress) },
  });

  const vaultAddr =
    vaultAddrRaw && vaultAddrRaw !== ZERO ? (vaultAddrRaw as `0x${string}`) : undefined;

  const { data: policyRaw, refetch: refetchPolicy } = useReadContract({
    address: vaultAddr ?? ZERO,
    abi: VAULT_ABI_TYPED,
    functionName: 'policy',
    chainId: ARC_CHAIN_ID,
    query: { enabled: Boolean(vaultAddr), refetchInterval: 10_000 },
  });

  const policy = policyRaw as PolicyView | undefined;
  const info: VaultInfo | undefined =
    vaultAddr && policy
      ? { address: vaultAddr, policy, status: vaultStatus(policy) }
      : undefined;

  const refetch = () => {
    void refetchAddr();
    void refetchPolicy();
  };

  return { vaultAddr, policy, info, refetch };
}

// ── Shared: all vault addresses (for Vendor cross-vault scan) ─────────────

export function useAllVaultAddresses() {
  const { data: countRaw } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI_TYPED,
    functionName: 'vaultCount',
    chainId: ARC_CHAIN_ID,
    query: { enabled: factoryEnabled, refetchInterval: 15_000 },
  });
  const count = typeof countRaw === 'bigint' ? Number(countRaw) : 0;

  const vaultIndexContracts = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI_TYPED,
        functionName: 'vaults',
        args: [BigInt(i)],
        chainId: ARC_CHAIN_ID,
      })),
    [count],
  );

  const { data: vaultAddrsRaw } = useReadContracts({
    contracts: vaultIndexContracts,
    query: { enabled: factoryEnabled && count > 0 },
  });

  const addresses = useMemo(
    () =>
      (vaultAddrsRaw ?? [])
        .map((r) => (r.status === 'success' ? (r.result as `0x${string}`) : null))
        .filter(Boolean) as `0x${string}`[],
    [vaultAddrsRaw],
  );

  return { addresses, count };
}

// Re-export formatUsdc for use in components without extra import
export { formatUsdc };
