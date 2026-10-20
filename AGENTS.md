# Agent Allowance

> Built with Arc Studio - money-powered apps in minutes

Onchain budget vaults for AI agents — linear USDC streaming with payee allowlists, per-tx caps, operator slot, and ERC-8004-style agent identity reference.

## Deployed Contracts (Arc Testnet, chainId 5042002)

| Contract | Address |
|---|---|
| BudgetVaultFactory | 0x0f36cdda646bad0e8e65c48b2ee7304dfca84d25 |

Explorer: https://explorer.testnet.arc.io/address/0x0f36cdda646bad0e8e65c48b2ee7304dfca84d25

USDC on Arc Testnet: 0x3600000000000000000000000000000000000000

---

## What This App Does

[Brief description of what the app does and its primary use case]

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/`, unit tests in `contracts/test/*.t.sol`. Build with `bun run contracts:build` (`forge build`), test with `bun run contracts:test` (`forge test`).
- Wallet: injected (MetaMask, etc.)
- Chain: Arc Testnet (Chain ID: 5042002, imported from `viem/chains`)
- Token: USDC (6 decimals) (Address: 0x3600000000000000000000000000000000000000, Chain: Arc Testnet)
- Toasts: Sonner

## Key Files

- `src/App.tsx` - Main application logic
- `src/components/` - UI components
- `src/config.ts` - wagmi config (chains, connectors, transports)

## To Run

```bash
bun install
bun run dev
```
