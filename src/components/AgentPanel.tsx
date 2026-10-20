import React, { useState } from 'react';
import {
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useAccount,
  useSwitchChain,
} from 'wagmi';
import { toast } from 'sonner';
import { VAULT_ABI, ARC_TESTNET_CHAIN_ID } from '../contracts';
import { parseAmount } from '@/onchain-money';
import { VestedTicker } from './VestedTicker';
import { TxHashBadge } from './TxHashBadge';

interface PolicyView {
  owner: string;
  agent: string;
  operator: string;
  agentId: bigint;
  registry: string;
  token: string;
  rate: bigint;
  startTime: bigint;
  endTime: bigint;
  perTxCap: bigint;
  paused: boolean;
  cancelled: boolean;
  vested: bigint;
  claimed: bigint;
  claimable: bigint;
  payees: readonly string[];
}

export function AgentPanel() {
  const { chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const isCorrectChain = chainId === ARC_TESTNET_CHAIN_ID;

  const [vaultAddr, setVaultAddr] = useState('');
  const [claimAmt, setClaimAmt] = useState('');
  const [payeeAddr, setPayeeAddr] = useState('');
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();

  const validVault = vaultAddr.length > 0 && vaultAddr.startsWith('0x');

  const { data: policy, refetch } = useReadContract({
    address: (validVault ? vaultAddr : '0x0000000000000000000000000000000000000000') as `0x${string}`,
    abi: VAULT_ABI,
    functionName: 'policy',
    chainId: ARC_TESTNET_CHAIN_ID,
    query: { enabled: validVault },
  }) as unknown as { data: PolicyView | undefined; refetch: () => void };

  const { writeContract, isPending } = useWriteContract({
    mutation: {
      onSuccess: (hash) => {
        setLastHash(hash);
        setTimeout(() => refetch(), 4000);
      },
      onError: (e) => toast.error(e.message.slice(0, 120)),
    },
  });

  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: lastHash });

  const handleClaim = () => {
    if (!isCorrectChain) { switchChain({ chainId: ARC_TESTNET_CHAIN_ID }); return; }
    if (!vaultAddr || !claimAmt || !payeeAddr) { toast.error('Fill all claim fields'); return; }
    try {
      const parsed = parseAmount(ARC_TESTNET_CHAIN_ID, claimAmt);
      writeContract({
        address: vaultAddr as `0x${string}`,
        abi: VAULT_ABI,
        functionName: 'claim',
        args: [parsed.raw, payeeAddr as `0x${string}`],
        chainId: ARC_TESTNET_CHAIN_ID,
      });
      toast.info('Claiming…');
    } catch (e: unknown) {
      toast.error(String((e as Error)?.message ?? e).slice(0, 120));
    }
  };

  const isBusy = isPending || isConfirming;
  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] text-sm placeholder:text-[var(--subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] font-mono';
  const labelCls = 'block text-xs font-medium text-[var(--muted)] mb-1';
  const cardCls = 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] backdrop-blur-sm p-5 space-y-4';
  const btnPrimary = 'w-full py-2.5 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="space-y-5">
      {lastHash && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">Last tx:</span>
          <TxHashBadge hash={lastHash} />
        </div>
      )}

      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-[var(--ink)]">Vault Address</h3>
        <div>
          <label className={labelCls}>Enter vault address to inspect</label>
          <input
            className={inputCls}
            placeholder="0x vault address"
            value={vaultAddr}
            onChange={e => setVaultAddr(e.target.value)}
          />
        </div>
      </div>

      {policy && (
        <>
          {/* Ticking vested/claimable display */}
          <div className={cardCls}>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Live Budget</h3>
            <VestedTicker
              vestedRaw={policy.vested}
              claimedRaw={policy.claimed}
              rate={policy.rate}
              startTime={policy.startTime}
              endTime={policy.endTime}
              totalDeposited={policy.vested + (policy.claimable - (policy.vested - policy.claimed))}
              cancelled={policy.cancelled}
            />
            {(policy.paused || policy.cancelled) && (
              <div className="flex gap-2 flex-wrap">
                {policy.paused && (
                  <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">Paused</span>
                )}
                {policy.cancelled && (
                  <span className="px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200 text-xs font-medium">Cancelled</span>
                )}
              </div>
            )}
          </div>

          {/* Schedule */}
          <div className={cardCls}>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Schedule</h3>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
              {[
                ['Start', policy.startTime > 0n ? new Date(Number(policy.startTime) * 1000).toLocaleString() : '—'],
                ['End', policy.endTime > 0n ? new Date(Number(policy.endTime) * 1000).toLocaleString() : '—'],
                ['Rate/s', policy.rate > 0n ? `${(Number(policy.rate) / 1e6).toFixed(8)} USDC` : '—'],
                ['Per-tx Cap', policy.perTxCap > 0n ? `${(Number(policy.perTxCap) / 1e6).toFixed(2)} USDC` : 'None'],
                ['Agent ID', policy.agentId.toString()],
                ['Registry', policy.registry !== '0x0000000000000000000000000000000000000000' ? `${policy.registry.slice(0, 8)}…` : '—'],
              ].map(([k, v]) => (
                <React.Fragment key={k}>
                  <span className="text-[var(--muted)] text-xs font-medium">{k}</span>
                  <span className="text-[var(--ink)] text-xs tabular-nums font-mono">{v}</span>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Payees */}
          {policy.payees.length > 0 && (
            <div className={cardCls}>
              <h3 className="text-sm font-semibold text-[var(--ink)]">Allowed Payees</h3>
              <div className="space-y-1">
                {policy.payees.map((p) => (
                  <div key={p} className="px-3 py-1.5 rounded-lg bg-[var(--surface-muted)] font-mono text-xs text-[var(--ink)]">{p}</div>
                ))}
              </div>
            </div>
          )}

          {/* Claim */}
          <div className={cardCls}>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Claim Budget</h3>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Amount (USDC)</label>
                <input className={inputCls} type="number" placeholder="10" value={claimAmt} onChange={e => setClaimAmt(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Payee (must be allowlisted)</label>
                <input className={inputCls} placeholder="0x…" value={payeeAddr} onChange={e => setPayeeAddr(e.target.value)} />
                {payeeAddr && policy.payees.length > 0 && (
                  <p className={`text-xs mt-1 ${policy.payees.map(p => p.toLowerCase()).includes(payeeAddr.toLowerCase()) ? 'text-emerald-600' : 'text-red-500'}`}>
                    {policy.payees.map(p => p.toLowerCase()).includes(payeeAddr.toLowerCase()) ? 'Payee is allowlisted' : 'Payee NOT in allowlist'}
                  </p>
                )}
              </div>
              <button
                className={btnPrimary}
                onClick={handleClaim}
                disabled={isBusy || policy.paused}
              >
                {isBusy ? 'Confirm in wallet…' : policy.paused ? 'Vault is paused' : 'Claim'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
