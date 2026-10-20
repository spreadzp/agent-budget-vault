import React, { useState, useRef, useCallback } from 'react';
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from 'wagmi';
import { erc20Abi, isAddress } from 'viem';
import { toast } from 'sonner';
import { Plus, Trash2, Settings, ShieldOff, ShieldCheck, XCircle, ChevronDown, ChevronUp, AlertTriangle } from 'lucide-react';
import { FACTORY_ADDRESS, FACTORY_ABI, VAULT_ABI, ARC_CHAIN_ID } from '../contracts';
import { getUsdc, buildAddressExplorerUrl, requireChain } from '@/onchain-facts';
import { parseAmount, formatUsdc } from '@/onchain-money';
import { TxHashBadge } from './TxHashBadge';
import { VestedTicker } from './VestedTicker';
import { useOwnerVaults, VaultInfo } from '../hooks/useVaultDiscovery';

const USDC = getUsdc(ARC_CHAIN_ID)!;
const CHAIN_NAME = requireChain(ARC_CHAIN_ID).name;
const factoryConfigured = Boolean(FACTORY_ADDRESS);
const ZERO = '0x0000000000000000000000000000000000000000' as `0x${string}`;

// N-4: show 6+4 hex chars, full address on hover
function fmtAddr(a: string) {
  return <span title={a}>{`${a.slice(0, 8)}…${a.slice(-4)}`}</span>;
}

const STATUS_BADGE: Record<VaultInfo['status'], string> = {
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  paused: 'bg-amber-50 text-amber-700 border-amber-200',
  cancelled: 'bg-red-50 text-red-700 border-red-200',
  expired: 'bg-slate-100 text-slate-500 border-slate-200',
  unfunded: 'bg-slate-100 text-slate-500 border-slate-200',
};

export function OwnerPanel() {
  const { address, chainId } = useAccount();
  // M-2: derive disabled state before any click
  const isCorrectChain = chainId === ARC_CHAIN_ID;
  const { switchChain } = useSwitchChain();

  // ── Vault discovery ──────────────────────────────────────────────────────
  const { vaults, refetch: refetchVaults } = useOwnerVaults(address);
  const [selectedVault, setSelectedVault] = useState<string>('');

  const selectedInfo = vaults.find(v => v.address.toLowerCase() === selectedVault.toLowerCase());
  const policy = selectedInfo?.policy;

  // Advanced manual fallback (N-5: ownership warning)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualVault, setManualVault] = useState('');
  const vaultAddr = showAdvanced && manualVault ? manualVault : selectedVault;
  const manualVaultIsOwned = !manualVault || !policy || !address
    ? true  // no warning if no manual address or no policy loaded
    : policy.owner.toLowerCase() === address.toLowerCase();

  // ── Create vault form ────────────────────────────────────────────────────
  const [agentAddr, setAgentAddr] = useState('');
  const [agentAddrErr, setAgentAddrErr] = useState('');
  // N-8: safe agentId parsing
  const [agentIdStr, setAgentIdStr] = useState('0');
  const [registryAddr, setRegistryAddr] = useState(ZERO);
  const [operatorAddr, setOperatorAddr] = useState(ZERO);

  // ── Deposit form ─────────────────────────────────────────────────────────
  const [depositAmt, setDepositAmt] = useState('');
  const [depositMode, setDepositMode] = useState<0 | 1>(0);

  // ── Payee form ───────────────────────────────────────────────────────────
  const [payeeAddr, setPayeeAddr] = useState('');
  const [payeeAddrErr, setPayeeAddrErr] = useState('');

  // ── Operator form ────────────────────────────────────────────────────────
  const [newOperator, setNewOperator] = useState('');
  const [operatorErr, setOperatorErr] = useState('');

  // ── PerTxCap form ────────────────────────────────────────────────────────
  const [txCap, setTxCap] = useState('');

  // ── Last tx (generic — toasts only) ─────────────────────────────────────
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>();

  // H-1: dedicated approve hash, separate from lastHash
  const [approveHash, setApproveHash] = useState<`0x${string}` | undefined>();
  const pendingDepositRef = useRef<{ amt: bigint; vault: string; mode: 0 | 1 } | null>(null);

  // H-1: stale allowance state
  const [depositFailed, setDepositFailed] = useState(false);
  const [staledVault, setStaledVault] = useState<string>('');

  const { writeContract, isPending } = useWriteContract({
    mutation: {
      onSuccess: (hash) => {
        setLastHash(hash);
      },
      onError: (e) => toast.error(e.message.slice(0, 120)),
    },
  });

  // N-3: refetch driven by receipt success, not setTimeout
  const { isLoading: isConfirming, isSuccess: lastTxSuccess } =
    useWaitForTransactionReceipt({ hash: lastHash });

  React.useEffect(() => {
    if (lastTxSuccess) refetchVaults();
  }, [lastTxSuccess, refetchVaults]);

  // H-1: watch the approve hash specifically
  const { isSuccess: approvalDone } = useWaitForTransactionReceipt({ hash: approveHash });

  const fireDeposit = useCallback(() => {
    const pd = pendingDepositRef.current;
    if (!pd) return;
    pendingDepositRef.current = null;
    writeContract(
      {
        address: pd.vault as `0x${string}`,
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [pd.amt, pd.mode],
        chainId: ARC_CHAIN_ID,
      },
      {
        onError: (e) => {
          // H-1b: deposit failed — stale allowance remains
          setDepositFailed(true);
          setStaledVault(pd.vault);
          toast.error(`Deposit failed: ${e.message.slice(0, 100)}`);
        },
      },
    );
    toast.info('Step 2/2: Depositing USDC into vault…');
  }, [writeContract]);

  React.useEffect(() => {
    if (approvalDone && pendingDepositRef.current) {
      fireDeposit();
    }
  }, [approvalDone, fireDeposit]);

  const handleApproveAndDeposit = () => {
    if (!isCorrectChain) { switchChain({ chainId: ARC_CHAIN_ID }); return; }
    if (!vaultAddr || !depositAmt) return;
    setDepositFailed(false);
    setStaledVault('');
    try {
      const parsed = parseAmount(ARC_CHAIN_ID, depositAmt);
      pendingDepositRef.current = { amt: parsed.raw, vault: vaultAddr, mode: depositMode };
      writeContract(
        {
          address: USDC.address as `0x${string}`,
          abi: erc20Abi,
          functionName: 'approve',
          args: [vaultAddr as `0x${string}`, parsed.raw],
          chainId: ARC_CHAIN_ID,
        },
        {
          onSuccess: (hash) => {
            // H-1a: track approve hash separately so only this approval triggers deposit
            setApproveHash(hash);
          },
        },
      );
      toast.info('Step 1/2: Approving USDC spend…');
    } catch (e: unknown) {
      toast.error(String((e as Error)?.message ?? e).slice(0, 120));
    }
  };

  const handleRevokeAllowance = () => {
    if (!staledVault) return;
    writeContract({
      address: USDC.address as `0x${string}`,
      abi: erc20Abi,
      functionName: 'approve',
      args: [staledVault as `0x${string}`, 0n],
      chainId: ARC_CHAIN_ID,
    });
    setDepositFailed(false);
    setStaledVault('');
    toast.info('Revoking stale allowance…');
  };

  const handleCreateVault = () => {
    if (!isCorrectChain) { switchChain({ chainId: ARC_CHAIN_ID }); return; }
    if (!factoryConfigured) { toast.error('Factory not deployed yet.'); return; }

    // M-1: address validation
    if (!agentAddr || !isAddress(agentAddr)) {
      setAgentAddrErr('Invalid address');
      return;
    }
    if (agentAddr.toLowerCase() === ZERO.toLowerCase()) {
      setAgentAddrErr('Agent cannot be the zero address');
      return;
    }
    setAgentAddrErr('');

    // N-8: safe agentId parse
    const rawId = Math.floor(parseInt(agentIdStr, 10));
    if (!Number.isFinite(rawId) || rawId < 0) { toast.error('Agent ID must be a non-negative integer'); return; }

    writeContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'createVault',
      args: [
        address!,
        agentAddr,
        BigInt(rawId),
        registryAddr,
        operatorAddr,
      ],
      chainId: ARC_CHAIN_ID,
    });
    toast.info('Creating vault…');
  };

  const vaultAction = (fn: string, args: unknown[]) => {
    if (!isCorrectChain) { switchChain({ chainId: ARC_CHAIN_ID }); return; }
    if (!vaultAddr) { toast.error('Select or enter a vault'); return; }

    // M-1: validate address-type args
    if (fn === 'addPayee' || fn === 'removePayee') {
      const addr = args[0] as string;
      if (!isAddress(addr)) { setPayeeAddrErr('Invalid address'); return; }
      setPayeeAddrErr('');
    }
    if (fn === 'setOperator') {
      const addr = args[0] as string;
      // zero address is valid for setOperator (disable)
      if (addr !== ZERO && !isAddress(addr)) { setOperatorErr('Invalid address'); return; }
      setOperatorErr('');
    }

    writeContract({
      address: vaultAddr as `0x${string}`,
      abi: VAULT_ABI,
      functionName: fn,
      args,
      chainId: ARC_CHAIN_ID,
    });
    toast.info(`Sending ${fn}…`);
  };

  const isBusy = isPending || isConfirming;
  const [mountTimeSec] = useState<number>(() => Math.floor(Date.now() / 1000));
  const isExpired = policy && policy.endTime > 0n && Number(policy.endTime) < mountTimeSec;

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] text-sm placeholder:text-[var(--subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] font-mono';
  const labelCls = 'block text-xs font-medium text-[var(--muted)] mb-1';
  const btnPrimary = 'w-full py-2.5 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50 disabled:cursor-not-allowed';
  const btnSecondary = 'flex-1 py-2 px-3 rounded-lg border border-[var(--border)] hover:bg-[var(--surface-muted)] text-[var(--ink)] text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50';
  const cardCls = 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] backdrop-blur-sm p-5 space-y-4';
  const errCls = 'text-xs text-[var(--danger)] mt-1';

  return (
    <div className="space-y-5">
      {lastHash && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--muted)]">Last tx:</span>
          <TxHashBadge hash={lastHash} />
        </div>
      )}

      {/* M-2: wrong-network banner + disabled button */}
      {!isCorrectChain && address && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-amber-600 shrink-0" />
          <p className="text-xs text-amber-700">
            Switch to {CHAIN_NAME} to use Owner actions.{' '}
            <button
              className="underline font-medium"
              onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
            >
              Switch now
            </button>
          </p>
        </div>
      )}

      {/* H-1b: stale allowance banner */}
      {depositFailed && staledVault && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <AlertTriangle size={14} className="text-red-600 shrink-0" />
            <p className="text-xs text-red-700">
              Deposit failed. A stale USDC allowance remains on the vault.
            </p>
          </div>
          <button
            onClick={handleRevokeAllowance}
            disabled={isBusy}
            className="shrink-0 px-3 py-1.5 rounded-lg border border-red-300 bg-white hover:bg-red-50 text-red-700 text-xs font-medium transition-colors disabled:opacity-50"
          >
            Revoke stale allowance
          </button>
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
            <input
              className={inputCls}
              placeholder="0x…"
              value={agentAddr}
              onChange={e => { setAgentAddr(e.target.value); setAgentAddrErr(''); }}
            />
            {agentAddrErr && <p className={errCls}>{agentAddrErr}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              {/* N-8: min=0, integer guard */}
              <label className={labelCls}>Agent ID (ERC-8004)</label>
              <input
                className={inputCls}
                type="number"
                min="0"
                placeholder="0"
                value={agentIdStr}
                onChange={e => setAgentIdStr(e.target.value)}
              />
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
          <button
            className={btnPrimary}
            onClick={handleCreateVault}
            disabled={isBusy || !factoryConfigured || !isCorrectChain}
          >
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
                  {/* N-4: title on hover */}
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
            <input
              className={inputCls}
              placeholder="0x vault address"
              value={manualVault}
              onChange={e => setManualVault(e.target.value)}
            />
            {/* N-5: ownership warning */}
            {manualVault && isAddress(manualVault) && !manualVaultIsOwned && (
              <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                <AlertTriangle size={11} />
                Connected wallet is not the owner of this vault
              </p>
            )}
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
            paused={policy.paused}
            showProgress
          />
          {selectedVault && (
            <a
              href={buildAddressExplorerUrl(ARC_CHAIN_ID, selectedVault)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-[var(--muted)] hover:text-[var(--ink)] transition-colors underline underline-offset-2"
            >
              View vault on explorer
            </a>
          )}
        </div>
      )}

      {/* Deposit */}
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
            {/* M-2: disable button when wrong chain */}
            <button
              className={btnPrimary}
              onClick={handleApproveAndDeposit}
              disabled={isBusy || !isCorrectChain}
            >
              {!isCorrectChain
                ? `Switch to ${CHAIN_NAME} first`
                : isBusy
                  ? 'Confirm in wallet…'
                  : 'Approve & Deposit'}
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
                  {/* N-4: full address on hover */}
                  <span className="font-mono text-xs text-[var(--ink)]" title={p}>{p.slice(0, 8)}…{p.slice(-4)}</span>
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
              <input
                className={inputCls}
                placeholder="0x…"
                value={payeeAddr}
                onChange={e => { setPayeeAddr(e.target.value); setPayeeAddrErr(''); }}
              />
              {payeeAddrErr && <p className={errCls}>{payeeAddrErr}</p>}
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
            <Settings size={15} /> Operator &amp; Limits
          </h3>
          <div className="space-y-3">
            <div>
              <label className={labelCls}>
                Operator
                {newOperator === ZERO && <span className="ml-1 text-amber-600">(disable operator)</span>}
              </label>
              <div className="flex gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  placeholder="0x… or 0x0 to disable"
                  value={newOperator}
                  onChange={e => { setNewOperator(e.target.value); setOperatorErr(''); }}
                />
                <button
                  className="px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors disabled:opacity-50"
                  onClick={() => vaultAction('setOperator', [newOperator || ZERO])}
                  disabled={isBusy}
                >
                  Set
                </button>
              </div>
              {operatorErr && <p className={errCls}>{operatorErr}</p>}
            </div>
            <div>
              <label className={labelCls}>Per-Tx Cap (USDC, 0 = no cap)</label>
              <div className="flex gap-2">
                <input className={`${inputCls} flex-1`} type="number" placeholder="50" value={txCap} onChange={e => setTxCap(e.target.value)} />
                <button
                  className="px-3 py-2 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-medium transition-colors disabled:opacity-50"
                  onClick={() => {
                    const raw = txCap ? parseAmount(ARC_CHAIN_ID, txCap).raw : 0n;
                    vaultAction('setPerTxCap', [raw]);
                  }}
                  disabled={isBusy}
                >
                  Set
                </button>
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


