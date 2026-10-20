import React from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { ARC_TESTNET_CHAIN_ID } from '../contracts';
import { requireChain } from '@/onchain-facts';

const arcTestnet = requireChain(ARC_TESTNET_CHAIN_ID);

export function NetworkBadge() {
  const { chainId, isConnected } = useAccount();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) return null;

  const isCorrect = chainId === ARC_TESTNET_CHAIN_ID;

  if (isCorrect) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        Arc Testnet
      </span>
    );
  }

  return (
    <button
      onClick={() => switchChain({ chainId: ARC_TESTNET_CHAIN_ID })}
      disabled={isPending}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      {isPending ? 'Switching…' : `Switch to ${arcTestnet.name}`}
    </button>
  );
}
