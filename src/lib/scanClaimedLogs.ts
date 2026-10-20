/**
 * scanClaimedLogs — chunked, backwards eth_getLogs scan for Claimed events.
 *
 * Arc Testnet rejects ranges > ~9 000 blocks with -32012.
 * We scan backwards in 4 000-block windows (safe margin), up to MAX_CHUNKS
 * windows per vault, and merge results.
 *
 * Progress is surfaced via an optional `onProgress` callback so callers can
 * show "Scanning blocks X..Y" in their UI without freezing.
 */

import { parseAbiItem, type PublicClient } from 'viem';

const CHUNK = 4_000n;          // blocks per getLogs window
const MAX_CHUNKS = 12;         // hard cap ≈ 48 000 blocks per vault (~13 h on 1 s/block)

const CLAIMED_EVENT = parseAbiItem(
  'event Claimed(address indexed caller, address indexed payee, uint256 amount)',
);

export interface ClaimedLog {
  caller: `0x${string}`;
  payee:  `0x${string}`;
  amount: bigint;
  txHash: `0x${string}`;
  blockNumber: bigint;
  vault:  `0x${string}`;
}

export interface ScanProgress {
  /** Which vault (address) we are scanning right now */
  vault: `0x${string}`;
  /** Lower block of the current window */
  fromBlock: bigint;
  /** Upper block of the current window */
  toBlock: bigint;
  /** The head block at scan start */
  headBlock: bigint;
}

export interface ScanOptions {
  /** Only return events where payee matches (checksummed or lower). Omit for all payees. */
  payeeFilter?: `0x${string}`;
  /** Only return events where caller matches. Omit for all callers. */
  callerFilter?: `0x${string}`;
  /**
   * Earliest block to scan back to per vault (e.g. the vault's deploy block).
   * Defaults to 0n — the helper will still stop at MAX_CHUNKS anyway.
   */
  earliestBlock?: bigint;
  /** Called before every getLogs chunk. Use to drive progress UI. */
  onProgress?: (p: ScanProgress) => void;
}

export interface ScanResult {
  logs: ClaimedLog[];
  /** How many vaults produced at least one RPC error and were skipped. */
  failedCount: number;
  /**
   * true when at least one vault hit the MAX_CHUNKS cap before reaching
   * block 0 (or earliestBlock). Results are a partial window; earlier events
   * may be missing.
   */
  truncated: boolean;
  /** The lowest block actually scanned across all vaults. */
  earliestScanned: bigint;
}

/** Internal per-vault scan result, carries the truncated flag separately. */
interface VaultScanResult {
  logs: ClaimedLog[];
  truncated: boolean;
  earliestScanned: bigint;
}

/**
 * Scan one vault address for Claimed events, walking backwards in chunks.
 * Resolves to the logs found (may be empty) or throws if the very first
 * chunk fails (so the caller can count it as failed).
 */
async function scanOneVault(
  client: PublicClient,
  vault: `0x${string}`,
  headBlock: bigint,
  opts: ScanOptions,
): Promise<VaultScanResult> {
  const earliest = opts.earliestBlock ?? 0n;
  const results: ClaimedLog[] = [];
  let toBlock = headBlock;
  let chunks = 0;
  let lastFromBlock = headBlock;

  while (chunks < MAX_CHUNKS) {
    const fromBlock = toBlock > CHUNK ? toBlock - CHUNK : 0n;
    const clampedFrom = fromBlock < earliest ? earliest : fromBlock;
    lastFromBlock = clampedFrom;

    opts.onProgress?.({ vault, fromBlock: clampedFrom, toBlock, headBlock });

    const args: Record<string, `0x${string}`> = {};
    if (opts.payeeFilter)  args['payee']  = opts.payeeFilter;
    if (opts.callerFilter) args['caller'] = opts.callerFilter;

    // eslint-disable-next-line no-await-in-loop -- sequential chunked scan
    const logs = await client.getLogs({
      address: vault,
      event: CLAIMED_EVENT,
      ...(Object.keys(args).length ? { args } : {}),
      fromBlock: clampedFrom,
      toBlock,
    });

    for (const l of logs) {
      results.push({
        caller:      l.args.caller as `0x${string}`,
        payee:       l.args.payee  as `0x${string}`,
        amount:      l.args.amount as bigint,
        txHash:      l.transactionHash,
        blockNumber: l.blockNumber ?? 0n,
        vault,
      });
    }

    chunks++;

    // Natural stop: reached the earliest target block
    if (clampedFrom <= earliest || toBlock < CHUNK) {
      return { logs: results, truncated: false, earliestScanned: clampedFrom };
    }

    toBlock = clampedFrom - 1n;
  }

  // Exited via chunk cap — results are partial
  return { logs: results, truncated: true, earliestScanned: lastFromBlock };
}

/**
 * Scan one or more vaults for Claimed events.
 * Vaults are scanned sequentially to avoid hammering the RPC.
 */
export async function scanClaimedLogs(
  client: PublicClient,
  vaults: `0x${string}`[],
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const headBlock = await client.getBlockNumber();
  const all: ClaimedLog[] = [];
  let failedCount = 0;
  let truncated = false;
  let earliestScanned = headBlock;

  for (const vault of vaults) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential to stay under rate limits
      const res = await scanOneVault(client, vault, headBlock, opts);
      all.push(...res.logs);
      if (res.truncated) truncated = true;
      if (res.earliestScanned < earliestScanned) earliestScanned = res.earliestScanned;
    } catch {
      failedCount++;
    }
  }

  // Sort newest-first
  all.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1));

  return { logs: all, failedCount, truncated, earliestScanned };
}
