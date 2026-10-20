import React from 'react';
import { ExternalLink } from 'lucide-react';
import { buildTxExplorerUrl } from '@/onchain-facts';
import { ARC_TESTNET_CHAIN_ID } from '../contracts';

interface Props {
  hash?: `0x${string}`;
}

export function TxHashBadge({ hash }: Props) {
  if (!hash) return null;
  const short = `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  const url = buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, hash);
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--border)] hover:border-[var(--border-strong)] transition-colors"
    >
      {short}
      <ExternalLink size={10} />
    </a>
  );
}
