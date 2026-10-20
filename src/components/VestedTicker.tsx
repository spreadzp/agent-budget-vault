import React, { useEffect, useState } from 'react';
import { formatUsdc } from '@/onchain-money';

interface Props {
  /** vested amount at last read (raw bigint, 6-decimal USDC) */
  vestedRaw: bigint;
  /** claimed so far (raw bigint, 6-decimal USDC) */
  claimedRaw: bigint;
  /** token units per second (raw bigint, 6-decimal USDC) */
  rate: bigint;
  /** stream start timestamp (seconds) */
  startTime: bigint;
  /** stream end timestamp (seconds) */
  endTime: bigint;
  /** total deposited (raw bigint) */
  totalDeposited: bigint;
  /** whether the stream is cancelled */
  cancelled: boolean;
  /** cancel timestamp, if cancelled */
  cancelTime?: bigint;
  /** whether the stream is currently paused — freezes the live ticker */
  paused?: boolean;
  /** show progress bar (default true) */
  showProgress?: boolean;
}

function clamp(v: bigint, lo: bigint, hi: bigint): bigint {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

export function VestedTicker({
  vestedRaw,
  claimedRaw,
  rate,
  startTime,
  endTime,
  totalDeposited,
  cancelled,
  cancelTime,
  paused = false,
  showProgress = true,
}: Props) {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));

  useEffect(() => {
    // When paused or cancelled, no need to tick every second
    if (paused || cancelled) return;
    const id = setInterval(
      () => setNow(BigInt(Math.floor(Date.now() / 1000))),
      1000,
    );
    return () => clearInterval(id);
  }, [paused, cancelled]);

  let liveVested = vestedRaw;
  if (paused || cancelled) {
    // Frozen: show the snapshot from the contract read
    liveVested = vestedRaw;
  } else if (rate > 0n && startTime > 0n) {
    const effectiveEnd = cancelled && cancelTime ? cancelTime : endTime;
    const ts = clamp(now, startTime, effectiveEnd);
    if (ts > startTime) {
      const elapsed = ts - startTime;
      const accrued = rate * elapsed;
      liveVested = clamp(accrued, 0n, totalDeposited);
    } else {
      liveVested = 0n;
    }
  }

  const liveClaimable = liveVested > claimedRaw ? liveVested - claimedRaw : 0n;

  // Progress bar: pct of totalDeposited that has vested
  const progressPct =
    totalDeposited > 0n
      ? Math.min(100, Number((liveVested * 10000n) / totalDeposited) / 100)
      : 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-[var(--surface-muted)] px-4 py-3">
          <p className="text-xs text-[var(--muted)] uppercase tracking-widest font-medium mb-0.5">
            Vested{paused && <span className="ml-1 normal-case text-amber-600">(paused)</span>}
          </p>
          <p className="text-lg font-semibold tabular-nums text-[var(--ink)] display">
            {formatUsdc(liveVested)}{' '}
            <span className="text-sm font-normal text-[var(--muted)]">USDC</span>
          </p>
        </div>
        <div className="rounded-xl bg-[var(--surface-muted)] px-4 py-3">
          <p className="text-xs text-[var(--muted)] uppercase tracking-widest font-medium mb-0.5">
            Claimable
          </p>
          <p className="text-lg font-semibold tabular-nums text-[var(--ink)] display">
            {formatUsdc(liveClaimable)}{' '}
            <span className="text-sm font-normal text-[var(--muted)]">USDC</span>
          </p>
        </div>
      </div>

      {showProgress && totalDeposited > 0n && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-[var(--muted)]">
            <span>{progressPct.toFixed(1)}% vested</span>
            <span className="tabular-nums">{formatUsdc(claimedRaw)} claimed</span>
          </div>
          <div className="h-1.5 rounded-full bg-[var(--surface-muted)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-none"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
