import React, { useState } from 'react';
import { usePublicClient, useAccount } from 'wagmi';
import { isAddress } from 'viem';
import { ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { ARC_TESTNET_CHAIN_ID } from '../contracts';
import { buildTxExplorerUrl, buildAddressExplorerUrl } from '@/onchain-facts';
import { formatUsdc } from '@/onchain-money';
import { useAllVaultAddresses } from '../hooks/useVaultDiscovery';
import { scanClaimedLogs, type ClaimedLog, type ScanProgress } from '../lib/scanClaimedLogs';

// N-4: 6+4 hex, full address on hover
function fmtAddr(a: string) {
  return <span title={a}>{`${a.slice(0, 8)}…${a.slice(-4)}`}</span>;
}

export function VendorPanel() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: ARC_TESTNET_CHAIN_ID });
  const { addresses: allVaults, count } = useAllVaultAddresses();

  // Payee filter: default to connected wallet, allow override
  const [payeeFilter, setPayeeFilter] = useState('');
  const [payeeFilterErr, setPayeeFilterErr] = useState('');
  const effectivePayee = payeeFilter || address || '';

  const [events, setEvents] = useState<ClaimedLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  // Advanced single-vault search
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [singleVault, setSingleVault] = useState('');
  const [singleVaultErr, setSingleVaultErr] = useState('');
  const [singleEvents, setSingleEvents] = useState<ClaimedLog[]>([]);
  const [singleLoading, setSingleLoading] = useState(false);
  const [singleProgress, setSingleProgress] = useState<ScanProgress | null>(null);
  const [singleFailed, setSingleFailed] = useState(0);
  const [singleTruncated, setSingleTruncated] = useState(false);
  const [singleError, setSingleError] = useState('');
  const [singleSearched, setSingleSearched] = useState(false);

  const handleScanAll = () => { void doScanAll(); };
  const doScanAll = async () => {
    // M-1: validate payee override if provided
    if (payeeFilter && !isAddress(payeeFilter)) {
      setPayeeFilterErr('Invalid address');
      return;
    }
    setPayeeFilterErr('');
    if (!effectivePayee) { setError('Connect wallet or enter a payee address'); return; }
    if (allVaults.length === 0) { setError('No vaults found in factory yet'); return; }
    setLoading(true);
    setError('');
    setEvents([]);
    setSearched(false);
    setScanProgress(null);
    setFailedCount(0);
    setTruncated(false);
    try {
      const { logs, failedCount: fc, truncated: tr } = await scanClaimedLogs(
        client!,
        allVaults,
        {
          payeeFilter: effectivePayee as `0x${string}`,
          onProgress: (p) => setScanProgress(p),
        },
      );
      setEvents(logs);
      setFailedCount(fc);
      setTruncated(tr);
      setSearched(true);
    } catch (e: unknown) {
      setError('Scan failed. Please try again.');
      void e;
    } finally {
      setLoading(false);
      setScanProgress(null);
    }
  };

  const handleSingleSearch = () => { void doSingleSearch(); };
  const doSingleSearch = async () => {
    // M-1: full isAddress validation instead of just startsWith('0x')
    if (!singleVault || !isAddress(singleVault)) {
      setSingleVaultErr('Invalid address');
      return;
    }
    setSingleVaultErr('');
    setSingleLoading(true);
    setSingleError('');
    setSingleEvents([]);
    setSingleSearched(false);
    setSingleProgress(null);
    setSingleFailed(0);
    setSingleTruncated(false);
    try {
      const { logs, failedCount: fc, truncated: tr } = await scanClaimedLogs(
        client!,
        [singleVault],
        {
          ...(effectivePayee ? { payeeFilter: effectivePayee as `0x${string}` } : {}),
          onProgress: (p) => setSingleProgress(p),
        },
      );
      setSingleEvents(logs);
      setSingleFailed(fc);
      setSingleTruncated(tr);
      setSingleSearched(true);
    } catch (e: unknown) {
      setSingleError('Scan failed. Please try again.');
      void e;
    } finally {
      setSingleLoading(false);
      setSingleProgress(null);
    }
  };

  const total = events.reduce((s, e) => s + e.amount, 0n);
  const singleTotal = singleEvents.reduce((s, e) => s + e.amount, 0n);

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] text-sm placeholder:text-[var(--subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] font-mono';
  const labelCls = 'block text-xs font-medium text-[var(--muted)] mb-1';
  const cardCls = 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] backdrop-blur-sm p-5 space-y-4';
  const btnPrimary = 'w-full py-2.5 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50 disabled:cursor-not-allowed';
  const errCls = 'text-xs text-[var(--danger)] mt-1';

  return (
    <div className="space-y-5">
      {/* All-vault scan */}
      <div className={cardCls}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--ink)]">Incoming Payments</h3>
          {count > 0 && (
            <span className="text-xs text-[var(--muted)] tabular-nums">{count} vault{count !== 1 ? 's' : ''} in registry</span>
          )}
        </div>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>
              Payee address
              {address && !payeeFilter && <span className="ml-1 text-[var(--muted)]">(using connected wallet)</span>}
            </label>
            <input
              className={inputCls}
              placeholder={address ? address : '0x…'}
              value={payeeFilter}
              onChange={e => { setPayeeFilter(e.target.value); setPayeeFilterErr(''); }}
            />
            {payeeFilterErr && <p className={errCls}>{payeeFilterErr}</p>}
          </div>
          <button className={btnPrimary} onClick={handleScanAll} disabled={loading || allVaults.length === 0}>
            {loading
              ? (scanProgress
                  ? `Scanning blocks ${scanProgress.fromBlock.toString()}…${scanProgress.toBlock.toString()} of ${scanProgress.headBlock.toString()}`
                  : `Scanning ${allVaults.length} vault${allVaults.length !== 1 ? 's' : ''}…`)
              : `Scan all ${allVaults.length} vault${allVaults.length !== 1 ? 's' : ''}`}
          </button>
          {error && <p className={errCls}>{error}</p>}
        </div>
      </div>

      {/* Results */}
      {searched && (
        <div className={cardCls}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              {events.length} payment{events.length !== 1 ? 's' : ''} found
            </h3>
            {events.length > 0 && (
              <span className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                {/* H-2: label total when truncated */}
                {formatUsdc(total)} USDC{truncated ? ' (last ~13 h)' : ' total'}
              </span>
            )}
          </div>
          {/* H-2: truncation warning */}
          {truncated && (
            <p className="text-xs text-amber-600">
              Showing last ~48k blocks — earlier payments may be missing
            </p>
          )}
          {failedCount > 0 && (
            <p className="text-xs text-amber-600">{failedCount} vault{failedCount !== 1 ? 's' : ''} could not be scanned</p>
          )}
          {events.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No incoming payments found in recent history.</p>
          ) : (
            <div className="space-y-2">
              {/* N-2: stable key from txHash+vault+blockNumber */}
              {events.map((ev) => (
                <div
                  key={`${ev.txHash}-${ev.vault}-${ev.blockNumber.toString()}`}
                  className="rounded-xl bg-[var(--surface-muted)] px-4 py-3 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-[var(--muted)]">From vault</span>
                      <a
                        href={buildAddressExplorerUrl(ARC_TESTNET_CHAIN_ID, ev.vault)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs text-[var(--ink)] hover:underline"
                      >
                        {fmtAddr(ev.vault)}
                      </a>
                    </div>
                    <p className="text-xs text-[var(--muted)]">Block {ev.blockNumber.toString()}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                      {formatUsdc(ev.amount)} USDC
                    </p>
                    <a
                      href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, ev.txHash)}
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
          )}
        </div>
      )}

      {/* Advanced: single vault search */}
      <div className={cardCls}>
        <button
          onClick={() => setShowAdvanced(s => !s)}
          className="flex items-center justify-between w-full text-sm font-semibold text-[var(--ink)]"
        >
          <span>Advanced: search one vault</span>
          {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {showAdvanced && (
          <div className="space-y-3 pt-1">
            <div>
              <label className={labelCls}>Vault Address</label>
              {/* M-1: full isAddress check on search */}
              <input
                className={inputCls}
                placeholder="0x vault address"
                value={singleVault}
                onChange={e => { setSingleVault(e.target.value); setSingleVaultErr(''); }}
              />
              {singleVaultErr && <p className={errCls}>{singleVaultErr}</p>}
            </div>
            <button className={btnPrimary} onClick={handleSingleSearch} disabled={singleLoading}>
              {singleLoading
                ? (singleProgress
                    ? `Scanning blocks ${singleProgress.fromBlock.toString()}…${singleProgress.toBlock.toString()} of ${singleProgress.headBlock.toString()}`
                    : 'Searching…')
                : 'Fetch Payments'}
            </button>
            {singleError && <p className={errCls}>{singleError}</p>}
            {singleFailed > 0 && (
              <p className="text-xs text-amber-600">Vault could not be fully scanned</p>
            )}
            {singleSearched && (
              <div className="space-y-2 pt-1">
                {/* H-2: truncation warning for single-vault search */}
                {singleTruncated && (
                  <p className="text-xs text-amber-600">
                    Showing last ~48k blocks — earlier payments may be missing
                  </p>
                )}
                {singleEvents.length > 0 && (
                  <p className="text-xs text-[var(--muted)] tabular-nums">
                    {formatUsdc(singleTotal)} USDC{singleTruncated ? ' (last ~13 h)' : ' total'}
                  </p>
                )}
                {singleEvents.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No events found in recent history.</p>
                ) : singleEvents.map((ev) => (
                  <div
                    key={`${ev.txHash}-${ev.vault}-${ev.blockNumber.toString()}`}
                    className="rounded-xl bg-[var(--surface-muted)] px-4 py-3 flex items-center justify-between gap-3"
                  >
                    <div>
                      {/* N-4: full address on hover */}
                      <p className="text-xs font-mono text-[var(--ink)]">{fmtAddr(ev.payee)}</p>
                      <p className="text-xs text-[var(--muted)]">Block {ev.blockNumber.toString()}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums text-[var(--ink)]">{formatUsdc(ev.amount)} USDC</p>
                      <a href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, ev.txHash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--ink)]">
                        View <ExternalLink size={10} />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
