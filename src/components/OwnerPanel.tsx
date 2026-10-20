import React, { useState, useRef, useCallback } from 'react';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi';
import { erc20Abi } from 'viem';
import { toast } from 'sonner';
import { Plus, Trash2, Settings, ShieldOff, ShieldCheck, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { FACTORY_ADDRESS, FACTORY_ABI, VAULT_ABI, ARC_TESTNET_CHAIN_ID } from '../contracts';
import { getUsdc, buildAddressExplorerUrl } from '@/onchain-facts';
import { parseAmount, formatUsdc } from '@/onchain-money';
import { TxHashBadge } from './TxHashBadge';
import { VestedTicker } from './VestedTicker';
import { useOwnerVaults, VaultInfo } from '../hooks/useVaultDiscovery';

const USDC = getUsdc(ARC_TESTNET_CHAIN_ID)!;
const factoryConfigured = Boolean(FACTORY_ADDRESS);
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;

const STATUS_BADGE: Record<VaultInfo['status'], string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  paused: 'bg-amber-50 text-amber-700 border-amber-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
  expired: 'bg-slate-100 text-slate-500 border-slate-200',
  unfunded: 'bg-slate-100 text-slate-500 border-slate-200',
};

function fmtAddr(a: string) { return `${a.slice(0, 8)}…${a.slice(-4)}`; }

export function OwnerPanel() {
  const { address, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const isCorrectChain = chainId === ARC_TESTNET_CHAIN_ID;

  // ── Vault discovery ──────────────────────────────────────────────────────
  const { vaults, refetch: refetchVaults } = useOwnerVaults(address);
  const [selectedVault, setSelectedVault] = useState<string>('');

  // Find selected vault's policy from discovery results
  const selectedInfo = vaults.find(v => v.address.toLowerCase() === selectedVault.toLowerCase());
  const policy = selectedInfo?.policy;

  // Advanced manual fallback
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualVault, setManualVault] = useState('');
  const vaultAddr = showAdvanced && manualVault ? manualVault : selectedVault;

  // ── Create vault form ────────────────────────────────────────────────────
  const [agentAddr, setAgentAddr] = useState('');
  const [agentId, setAgentId] = useState('0');
  const [registryAddr, setRegistryAddr] = useState(ZERO);
  const [operatorAddr, setOperatorAddr] = useState(ZERO);

  // ── Deposit form ─────────────────────────────────────────────────────────
  const [depositAmt, setDepositAmt] = useState('');
  const [depositMode, setDepositMode] = useState<0 | 1>(0);

  // ── Payee form ───────────────────────────────────────────────────────────
  const [payeeAddr, setPayeeAddr] = useState('');

  // ── Operator form ────────────────────────────────────────────────────────
  const [newOperator, setNewOperator] = useState('');

  // ── PerTxCap form ────────────────────────────────────────────────────────
  const [txCap, setTxCap] = useState('');

  // ── Last tx ──────────────────────────────────────────────────────────────
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();

  // ── Pending deposit after approval ──────────────────────────────────────
  const pendingDepositRef = useRef<{ amt: bigint; vault: string; mode: 0 | 1 } | null>(null);

  const { writeContract, isPending } = useWriteContract({
    mutation: {
      onSuccess: (hash) => {
        setLastHash(hash);
        setTimeout(() => refetchVaults(), 4000);
      },
      onError: (e) => toast.error(e.message.slice(0, 120)),
    },
  });

  const { isLoading: isConfirming, isSuccess: approvalDone } = useWaitForTransactionReceipt({ hash: lastHash });

  const fireDeposit = useCallback(() => {
    const pd = pendingDepositRef.current;
    if (!pd) return;
    pendingDepositRef.current = null;
    writeContract({
      address: pd.vault as `0x${string}`,
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [pd.amt, pd.mode],
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    toast.info('Step 2/2: Depositing USDC into vault…');
  }, [writeContract]);

  React.useEffect(() => {
    if (approvalDone && pendingDepositRef.current) {
      fireDeposit();
    }
  }, [approvalDone, fireDeposit]);

  const switchIfNeeded = () => {
    if (!isCorrectChain) { switchChain({ chainId: ARC_TESTNET_CHAIN_ID }); return true; }
    return false;
  };

  const handleApproveAndDeposit = () => {
    if (switchIfNeeded()) return;
    if (!vaultAddr || !depositAmt) return;
    try {
      const parsed = parseAmount(ARC_TESTNET_CHAIN_ID, depositAmt);
      pendingDepositRef.current = { amt: parsed.raw, vault: vaultAddr, mode: depositMode };
      writeContract({
        address: USDC.address as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vaultAddr as `0x${string}`, parsed.raw],
        chainId: ARC_TESTNET_CHAIN_ID,
      });
      toast.info('Step 1/2: Approving USDC spend…');
    } catch (e: unknown) {
      toast.error(String((e as Error)?.message ?? e).slice(0, 120));
    }
  };

  const handleCreateVault = () => {
    if (switchIfNeeded()) return;
    if (!factoryConfigured) { toast.error('Factory not deployed yet.'); return; }
    if (!agentAddr) { toast.error('Agent address required'); return; }
    writeContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'createVault',
      args: [
        address!,
        agentAddr as `0x${string}`,
        BigInt(agentId),
        registryAddr,
        operatorAddr,
      ],
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    toast.info('Creating vault…');
  };

  const vaultAction = (fn: string, args: unknown[]) => {
    if (switchIfNeeded()) return;
    if (!vaultAddr) { toast.error('Select or enter a vault'); return; }
    writeContract({
      address: vaultAddr as `0x${string}`,
      abi: VAULT_ABI,
      functionName: fn,
      args,
      chainId: ARC_TESTNET_CHAIN_ID,
    });
    toast.info(`Sending ${fn}…`);
  };

  const isBusy = isPending || isConfirming;
  // Capture mount epoch once so render stays pure
  const [mountTimeSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  const isExpired = policy && policy.endTime > 0n && Number(policy.endTime) < mountTimeSec;

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] text-sm placeholder:text-[var(--subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] font-mono';
  const labelCls = 'block text-xs font-medium text-[var(--muted)] mb-1';
  const btnPrimary = 'w-full py-2.5 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50 disabled:cursor-not-allowed';
  const btnSecondary = 'flex-1 py-2 px-3 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] text-[var(--ink)] text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50';
  const cardCls = 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] backdrop-blur-sm p-5 space-y-4';

  return (
    <div className="space-y-5">
      {lastHash && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">Last tx:</span>
          <TxHashBadge hash={lastHash} />
        </div>
      )}

      {/* Create Vault */}
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-[var(--ink)] flex items-center gap-2">
          <Plus size={15} /> Create Vault
        </h3>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Agent Address</label>
            <input className={inputCls} placeholder="0x…" value={agentAddr} onChange={e => setAgentAddr(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Agent ID (ERC-8004)</label>
              <input className={inputCls} type="number" placeholder="0" value={agentId} onChange={e => setAgentId(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Registry (optional)</label>
              <input className={inputCls} placeholder="0x…" value={registryAddr} onChange={e => setRegistryAddr(e.target.value as `0x${string}`)} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Operator (optional)</label>
            <input className={inputCls} placeholder="0x…" value={operatorAddr} onChange={e => setOperatorAddr(e.target.value as `0x${string}`)} />
          </div>
          <button className={btnPrimary} onClick={handleCreateVault} disabled={isBusy || !factoryConfigured}>
            {isBusy ? 'Confirm in wallet…' : 'Create Vault'}
          </button>
          {!factoryConfigured && (
            <p className="text-xs text-amber-600">Set VITE_FACTORY_ADDRESS in .env after deploy.</p>
          )}
        </div>
      </div>

      {/* My Vaults */}
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-[var(--ink)]">My Vaults</h3>
        {vaults.length === 0 ? (
          <p className="text-xs text-[var(--muted)]">No vaults found for your address yet.</p>
        ) : (
          <div className="space-y-2">
            {vaults.map(v => (
              <button
                key={v.address}
                onClick={() => setSelectedVault(v.address)}
                className={[
                  'w-full flex items-center justify-between px-3 py-2.5 rounded-xl border text-left transition-all',
                  selectedVault.toLowerCase() === v.address.toLowerCase()
                    ? 'border-[var(--accent)] bg-[var(--surface-muted)]'
                    : 'border-[var(--border)] hover:border-[var(--border-strong)] bg-[var(--surface)]',
                ].join(' ')}
              >
                <div>
                  <p className="text-xs font-mono text-[var(--ink)]">{fmtAddr(v.address)}</p>
                  <p className="text-xs text-[var(--muted)] mt-0.5">
                    Agent: {fmtAddr(v.policy.agent)}
                    {v.policy.rate > 0n && (
                      <span className="ml-1.5 tabular-nums">
                        · {formatUsdc(v.policy.claimable)} claimable
                      </span>
                    )}
                  </p>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${STATUS_BADGE[v.status]}`}>
                  {v.status}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Advanced manual override */}
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

      {/* Live budget for selected vault */}
      {policy && policy.rate > 0n && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-[var(--ink)]">Live Budget</h3>
          <VestedTicker
            vestedRaw={policy.vested}
            claimedRaw={policy.claimed}
            rate={policy.rate}
            startTime={policy.startTime}
            endTime={policy.endTime}
            totalDeposited={policy.vested + policy.claimable}
            cancelled={policy.cancelled}
            showProgress
          />
          {selectedVault && (
            <a
              href={buildAddressExplorerUrl(ARC_TESTNET_CHAIN_ID, selectedVault)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors underline underline-offset-2"
            >
              View vault on explorer
            </a>
          )}
        </div>
      )}

      {/* Deposit (only shown when a vault is selected) */}
      {(selectedVault || manualVault) && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-[var(--ink)]">Deposit USDC</h3>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Amount (USDC)</label>
              <input className={inputCls} type="number" placeholder="100" value={depositAmt} onChange={e => setDepositAmt(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Mode</label>
              <select
                className={inputCls}
                value={depositMode}
                onChange={e => setDepositMode(Number(e.target.value) as 0 | 1)}
              >
                <option value={0}>Extend duration — adds time at current rate</option>
                <option value={1}>Raise rate — speeds up vesting, keeps end time</option>
              </select>
              {depositMode === 0 && isExpired && (
                <p className="text-xs text-blue-600 mt-1">Expired vault: EXTEND will restart the stream from now.</p>
              )}
            </div>
            <button className={btnPrimary} onClick={handleApproveAndDeposit} disabled={isBusy}>
              {isBusy ? 'Confirm in wallet…' : 'Approve & Deposit'}
            </button>
          </div>
        </div>
      )}

      {/* Payee Management */}
      {(selectedVault || manualVault) && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-[var(--ink)] flex items-center gap-2">
            <Settings size={15} /> Payee Allowlist
          </h3>
          {policy && policy.payees.length > 0 && (
            <div className="space-y-1">
              {policy.payees.map(p => (
                <div key={p} className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[var(--surface-muted)]">
                  <span className="font-mono text-xs text-[var(--ink)]">{p}</span>
                  <button
                    onClick={() => vaultAction('removePayee', [p])}
                    disabled={isBusy}
                    className="text-[var(--danger)] hover:text-red-700 disabled:opacity-40 transition-colors"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <div>
              <label className={labelCls}>Add Payee</label>
              <input className={inputCls} placeholder="0x…" value={payeeAddr} onChange={e => setPayeeAddr(e.target.value)} />
            </div>
            <button className={btnSecondary} onClick={() => vaultAction('addPayee', [payeeAddr])} disabled={isBusy}>
              <Plus size={13} className="inline mr-1" />Add payee
            </button>
          </div>
        </div>
      )}

      {/* Operator + PerTxCap */}
      {(selectedVault || manualVault) && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-[var(--ink)] flex items-center gap-2">
            <Settings size={15} /> Operator & Limits
          </h3>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>
                Operator
                {newOperator === ZERO && <span className="ml-1 text-amber-600">(disable operator)</span>}
              </label>
              <div className="flex gap-2">
                <input className={`${inputCls} flex-1`} placeholder="0x… or 0x0 to disable" value={newOperator} onChange={e => setNewOperator(e.target.value)} />
                <button className="px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors disabled:opacity-50" onClick={() => vaultAction('setOperator', [newOperator])} disabled={isBusy}>Set</button>
              </div>
            </div>
            <div>
              <label className={labelCls}>Per-Tx Cap (USDC, 0 = no cap)</label>
              <div className="flex gap-2">
                <input className={`${inputCls} flex-1`} type="number" placeholder="50" value={txCap} onChange={e => setTxCap(e.target.value)} />
                <button className="px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors disabled:opacity-50" onClick={() => {
                  const raw = txCap ? parseAmount(ARC_TESTNET_CHAIN_ID, txCap).raw : 0n;
                  vaultAction('setPerTxCap', [raw]);
                }} disabled={isBusy}>Set</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Vault Controls */}
      {(selectedVault || manualVault) && (
        <div className={cardCls}>
          <h3 className="text-sm font-semibold text-[var(--ink)]">Vault Controls</h3>
          <div className="flex gap-2 flex-wrap">
            <button className={btnSecondary} onClick={() => vaultAction('pause', [])} disabled={isBusy}>
              <ShieldOff size={13} className="inline mr-1" />Pause
            </button>
            <button className={btnSecondary} onClick={() => vaultAction('unpause', [])} disabled={isBusy}>
              <ShieldCheck size={13} className="inline mr-1" />Unpause
            </button>
            <button
              className="flex-1 py-2 px-3 rounded-lg border border-red-200 hover:bg-red-50 text-red-600 text-sm font-medium transition-colors focus:outline-none disabled:opacity-50"
              onClick={() => vaultAction('cancel', [])}
              disabled={isBusy}
            >
              <XCircle size={13} className="inline mr-1" />Cancel Stream
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
