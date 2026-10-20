import { useState } from 'react';
import { ConnectKitButton } from 'connectkit';
import { useAccount } from 'wagmi';
import { Bot } from 'lucide-react';
import { ARC_CHAIN_ID } from './contracts';
import { requireChain } from './onchain-facts';
import { RoleSwitcher, Role } from './components/RoleSwitcher';
import { NetworkBadge } from './components/NetworkBadge';
import { OwnerPanel } from './components/OwnerPanel';
import { AgentPanel } from './components/AgentPanel';
import { VendorPanel } from './components/VendorPanel';

const CHAIN_NAME = requireChain(ARC_CHAIN_ID).name;

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: 'Create vaults, fund them with USDC, manage payees, set limits, pause or cancel streams.',
  agent: 'View your vested budget, check the schedule, and claim USDC to an approved payee.',
  vendor: 'Look up incoming USDC payments for a payee address across any vault.',
};

export default function App() {
  const { isConnected } = useAccount();
  const [role, setRole] = useState<Role>('owner');

  return (
    <div className="min-h-dvh" style={{ background: 'var(--bg-gradient)' }}>
      {/* Header */}
      <header className="sticky top-0 z-20 backdrop-blur-md border-b border-[var(--border)] bg-[var(--surface-strong)]">
        <div className="max-w-lg mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-[var(--accent)] flex items-center justify-center shrink-0">
              <Bot size={16} className="text-white" />
            </div>
            <div>
              <h1 className="text-sm font-semibold display text-[var(--ink)] leading-tight">
                Agent Allowance
              </h1>
              <p className="text-xs text-[var(--muted)] leading-tight">Onchain budget for AI agents</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NetworkBadge />
            <ConnectKitButton />
          </div>
        </div>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-5 pb-16">
        {/* Role switcher */}
        <div className="space-y-2">
          <RoleSwitcher role={role} onChange={setRole} />
          <p className="text-xs text-[var(--muted)] px-1">{ROLE_DESCRIPTIONS[role]}</p>
        </div>

        {/* Connect prompt */}
        {!isConnected && (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-[var(--surface-muted)] flex items-center justify-center mx-auto">
              <Bot size={24} className="text-[var(--muted)]" />
            </div>
            <p className="text-sm font-medium text-[var(--ink)]">Connect your wallet</p>
            <p className="text-xs text-[var(--muted)] max-w-xs mx-auto">
              Connect to {CHAIN_NAME} to create or interact with agent budget vaults.
            </p>
            <div className="flex justify-center pt-1">
              <ConnectKitButton label="Connect Wallet" />
            </div>
          </div>
        )}

        {/* Role panels */}
        {isConnected && role === 'owner' && <OwnerPanel />}
        {isConnected && role === 'agent' && <AgentPanel />}
        {(role === 'vendor') && <VendorPanel />}

        {/* Info footer */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2">
          <p className="text-xs font-semibold text-[var(--ink)]">How it works</p>
          <ol className="text-xs text-[var(--muted)] space-y-1 list-decimal list-inside">
            <li>Owner creates a vault via the factory, deposits USDC, adds payees.</li>
            <li>USDC vests linearly over the stream duration (Sablier-style).</li>
            <li>Agent or operator calls <code className="mono bg-[var(--surface-muted)] px-1 rounded">claim(amount, payee)</code> to route to an approved address.</li>
            <li>Owner can pause, adjust limits, top-up, or cancel at any time.</li>
          </ol>
        </div>
      </main>
    </div>
  );
}
