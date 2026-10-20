import React, { useState, useEffect } from 'react';
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useAccount,
  usePublicClient,
  useSwitchChain,
} from 'wagmi';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { VAULT_ABI, ARC_TESTNET_CHAIN_ID } from '../contracts';
import { parseAmount, formatUsdc } from '@/onchain-money';
import { buildTxExplorerUrl } from '@/onchain-facts';
import { VestedTicker } from './VestedTicker';
import { TxHashBadge } from './TxHashBadge';
import { useAgentVault } from '../hooks/useVaultDiscovery';
import { scanClaimedLogs, type ClaimedLog, type ScanProgress } from '../lib/scanClaimedLogs';

function fmtAddr(a: string) { return `${a.slice(0, 8)}…${a.slice(-4)}`; }

export function AgentPanel() {
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const isCorrectChain = chainId === ARC_TESTNET_CHAIN_ID;
  const client = usePublicClient({ chainId: ARC_TESTNET_CHAIN_ID });

  // ── Vault discovery ──────────────────────────────────────────────────────
  const { vaultAddr: discoveredVault, policy, refetch } = useAgentVault(address);

  // Advanced manual override
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualVault, setManualVault] = useState('');
  const vaultAddr = showAdvanced && manualVault ? manualVault : discoveredVault;
  const activePolicy = policy;

  // ── Claim form ───────────────────────────────────────────────────────────
  const [claimAmt, setClaimAmt] = useState('');
  const [selectedPayee, setSelectedPayee] = useState('');
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();

  // When payees load, pre-select the first one
  useEffect(() => {
    if (activePolicy?.payees && activePolicy.payees.length > 0 && !selectedPayee) {
      setSelectedPayee(activePolicy.payees[0]);
    }
  }, [activePolicy?.payees, selectedPayee]);

  const { writeContract, isPending } = useWriteContract({
    mutation: {
      onSuccess: (hash) => {
        setLastHash(hash);
        setTimeout(() => {
          void refetch();
          void fetchClaims();
        }, 4000);
      },
      onError: (e) => toast.error(e.message.slice(0, 120)),
    },
  });

  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: lastHash });

  // ── Claim history ────────────────────────────────────────────────────────
  const [claims, setClaims] = useState<ClaimedLog[]>([]);
  const [claimsLoading, setClaimsLoading] = useState(false);
  const [claimsProgress, setClaimsProgress] = useState<ScanProgress | null>(null);
  const [claimsFailed, setClaimsFailed] = useState(0);

  const fetchClaims = async () => {
    if (!vaultAddr || !address || !client) return;
    setClaimsLoading(true);
    setClaimsProgress(null);
    setClaimsFailed(0);
    try {
      const { logs, failedCount } = await scanClaimedLogs(
        client,
        [vaultAddr as `0x${string}`],
        {
          callerFilter: address,
          onProgress: (p) => setClaimsProgress(p),
        },
      );
      setClaims(logs);
      setClaimsFailed(failedCount);
    } finally {
      setClaimsLoading(false);
      setClaimsProgress(null);
    }
  };

  useEffect(() => {
    if (vaultAddr && address) { void fetchClaims(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultAddr, address]);

  const handleClaim = () => {
    if (!isCorrectChain) { switchChain({ chainId: ARC_TESTNET_CHAIN_ID }); return; }
    if (!vaultAddr || !claimAmt || !selectedPayee) { toast.error('Fill all claim fields'); return; }
    try {
      const parsed = parseAmount(ARC_TESTNET_CHAIN_ID, claimAmt);
      writeContract({
        address: vaultAddr as `0x${string}`,
        abi: VAULT_ABI,
        functionName: 'claim',
        args: [parsed.raw, selectedPayee as `0x${string}`],
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

      {/* Vault resolution */}
      <div className={cardCls}>
        {discoveredVault ? (
          <div>
            <p className="text-xs text-[var(--muted)] mb-1">Your vault</p>
            <p className="font-mono text-xs text-[var(--ink)]">{discoveredVault}</p>
          </div>
        ) : (
          <div>
            <p className="text-sm font-medium text-[var(--ink)]">No vault found</p>
            <p className="text-xs text-[var(--muted)] mt-1">
              No vault is registered for your wallet address yet. Ask the owner to create one via the factory.
            </p>
          </div>
        )}

        <button
          onClick={() => setShowAdvanced(s => !s)}
          className="flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
        >
          {showAdvanced ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          Advanced: enter vault address manually
        </button>
        {showAdvanced && (
          <div>
            <label className={labelCls}>Vault Address</label>
            <input className={inputCls} placeholder="0x vault address" value={manualVault} onChange={e => setManualVault(e.target.value)} />
          </div>
        )}
      </div>

      {activePolicy && vaultAddr && (
        <>
          {/* Live ticking budget */}
          <div className={cardCls}>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Live Budget</h3>
            <VestedTicker
              vestedRaw={activePolicy.vested}
              claimedRaw={activePolicy.claimed}
              rate={activePolicy.rate}
              startTime={activePolicy.startTime}
              endTime={activePolicy.endTime}
              totalDeposited={activePolicy.vested + activePolicy.claimable}
              cancelled={activePolicy.cancelled}
              showProgress
            />
            {(activePolicy.paused || activePolicy.cancelled) && (
              <div className="flex gap-2">
                {activePolicy.paused && (
                  <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-xs font-medium">Paused</span>
                )}
                {activePolicy.cancelled && (
                  <span className="px-2.5 py-1 rounded-full bg-red-50 text-red-700 border border-red-200 text-xs font-medium">Cancelled</span>
                )}
              </div>
            )}
          </div>

          {/* Schedule */}
          <div className={cardCls}>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Schedule</h3>
            <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
              {([
                ['Start', activePolicy.startTime > 0n ? new Date(Number(activePolicy.startTime) * 1000).toLocaleString() : '—'],
                ['End', activePolicy.endTime > 0n ? new Date(Number(activePolicy.endTime) * 1000).toLocaleString() : '—'],
                ['Rate/s', activePolicy.rate > 0n ? `${(Number(activePolicy.rate) / 1e6).toFixed(8)} USDC` : '—'],
                ['Per-tx Cap', activePolicy.perTxCap > 0n ? `${formatUsdc(activePolicy.perTxCap)} USDC` : 'None'],
                ['Agent ID', activePolicy.agentId.toString()],
                ['Operator', activePolicy.operator !== '0x0000000000000000000000000000000000000000' ? fmtAddr(activePolicy.operator) : 'None'],
              ] as [string, string][]).map(([k, v]) => (
                <React.Fragment key={k}>
                  <span className="text-[var(--muted)] text-xs font-medium">{k}</span>
                  <span className="text-[var(--ink)] text-xs tabular-nums font-mono">{v}</span>
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Claim */}
          <div className={cardCls}>
            <h3 className="text-sm font-semibold text-[var(--ink)]">Claim Budget</h3>
            <div className="space-y-3">
              <div>
                <label className={labelCls}>Amount (USDC)</label>
                <input className={inputCls} type="number" placeholder="10" value={claimAmt} onChange={e => setClaimAmt(e.target.value)} />
              </div>
              <div>
                <label className={labelCls}>Send to</label>
                {activePolicy.payees.length > 0 ? (
                  <select
                    className={inputCls}
                    value={selectedPayee}
                    onChange={e => setSelectedPayee(e.target.value)}
                  >
                    {activePolicy.payees.map(p => (
                      <option key={p} value={p}>{fmtAddr(p)}</option>
                    ))}
                  </select>
                ) : (
                  <p className="text-xs text-amber-600 mt-1">No payees on allowlist. Owner must add one first.</p>
                )}
              </div>
              <button
                className={btnPrimary}
                onClick={handleClaim}
                disabled={isBusy || activePolicy.paused || activePolicy.payees.length === 0}
              >
                {isBusy ? 'Confirm in wallet…' : activePolicy.paused ? 'Vault is paused' : 'Claim'}
              </button>
            </div>
          </div>

          {/* My claims history */}
          <div className={cardCls}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--ink)]">My Claims</h3>
              {claims.length > 0 && (
                <span className="text-xs tabular-nums text-[var(--muted)]">
                  Total: {formatUsdc(claims.reduce((s, c) => s + c.amount, 0n))} USDC
                </span>
              )}
            </div>
            {claimsLoading && (
              <p className="text-xs text-[var(--muted)]">
                {claimsProgress
                  ? `Scanning blocks ${claimsProgress.fromBlock.toString()}…${claimsProgress.toBlock.toString()} of ${claimsProgress.headBlock.toString()}`
                  : 'Scanning…'}
              </p>
            )}
            {claimsFailed > 0 && (
              <p className="text-xs text-amber-600">{claimsFailed} chunk{claimsFailed !== 1 ? 's' : ''} could not be scanned</p>
            )}
            {!claimsLoading && claims.length === 0 && claimsFailed === 0 && (
              <p className="text-xs text-[var(--muted)]">No claims found in recent history.</p>
            )}
            {claims.map((c, i) => (
              <div key={i} className="rounded-xl bg-[var(--surface-muted)] px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-[var(--ink)]">To: {fmtAddr(c.payee)}</p>
                  <p className="text-xs text-[var(--muted)] mt-0.5">Block {c.blockNumber.toString()}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold tabular-nums text-[var(--ink)]">{formatUsdc(c.amount)} USDC</p>
                  <a
                    href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, c.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors"
                  >
                    View <ExternalLink size={10} />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
