import React, { useState } from 'react';
import { usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';
import { ExternalLink, Search } from 'lucide-react';
import { ARC_TESTNET_CHAIN_ID } from '../contracts';
import { buildTxExplorerUrl } from '@/onchain-facts';
import { formatUsdc } from '@/onchain-money';

interface ClaimEvent {
  caller: string;
  payee: string;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
}

export function VendorPanel() {
  const [vaultAddr, setVaultAddr] = useState('');
  const [payeeFilter, setPayeeFilter] = useState('');
  const [events, setEvents] = useState<ClaimEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const client = usePublicClient({ chainId: ARC_TESTNET_CHAIN_ID });

  const handleSearch = () => {
    void doSearch();
  };
  const doSearch = async () => {
    if (!vaultAddr || !vaultAddr.startsWith('0x')) { setError('Enter a valid vault address'); return; }
    setLoading(true);
    setError('');
    setEvents([]);
    setSearched(false);
    try {
      // Fetch from current block minus 10000, to keep the scan bounded
      const blockNumber = await client!.getBlockNumber();
      const fromBlock = blockNumber > 10000n ? blockNumber - 10000n : 0n;

      const logs = await client!.getLogs({
        address: vaultAddr as `0x${string}`,
        event: parseAbiItem('event Claimed(address indexed caller, address indexed payee, uint256 amount)'),
        fromBlock,
        toBlock: 'latest',
      });

      const parsed: ClaimEvent[] = logs
        .filter(l => !payeeFilter || l.args.payee?.toLowerCase() === payeeFilter.toLowerCase())
        .map(l => ({
          caller: l.args.caller as string,
          payee: l.args.payee as string,
          amount: l.args.amount as bigint,
          txHash: l.transactionHash,
          blockNumber: l.blockNumber ?? 0n,
        }))
        .reverse();

      setEvents(parsed);
      setSearched(true);
    } catch (e: unknown) {
      setError(String((e as Error)?.message ?? e).slice(0, 200));
    } finally {
      setLoading(false);
    }
  };

  const total = events.reduce((s, e) => s + e.amount, 0n);

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--ink)] text-sm placeholder:text-[var(--subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--focus)] font-mono';
  const labelCls = 'block text-xs font-medium text-[var(--muted)] mb-1';
  const cardCls = 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] backdrop-blur-sm p-5 space-y-4';
  const btnPrimary = 'w-full py-2.5 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="space-y-5">
      <div className={cardCls}>
        <h3 className="text-sm font-semibold text-[var(--ink)] flex items-center gap-2">
          <Search size={15} /> Search Payments
        </h3>
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Vault Address</label>
            <input className={inputCls} placeholder="0x vault address" value={vaultAddr} onChange={e => setVaultAddr(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Filter by payee (optional)</label>
            <input className={inputCls} placeholder="0x your address" value={payeeFilter} onChange={e => setPayeeFilter(e.target.value)} />
          </div>
          <button className={btnPrimary} onClick={handleSearch} disabled={loading}>
            {loading ? 'Searching…' : 'Fetch Payments'}
          </button>
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
        </div>
      </div>

      {searched && (
        <div className={cardCls}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--ink)]">
              {events.length} payment{events.length !== 1 ? 's' : ''} found
            </h3>
            {events.length > 0 && (
              <span className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                Total: {formatUsdc(total)} USDC
              </span>
            )}
          </div>

          {events.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">No claim events found in the last 10,000 blocks.</p>
          ) : (
            <div className="space-y-2">
              {events.map((ev, i) => (
                <div key={i} className="rounded-xl bg-[var(--surface-muted)] px-4 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-[var(--muted)]">Payee</span>
                      <span className="font-mono text-xs text-[var(--ink)] truncate">{ev.payee.slice(0, 10)}…{ev.payee.slice(-4)}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[var(--muted)]">Block {ev.blockNumber.toString()}</span>
                    </div>
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
    </div>
  );
}
