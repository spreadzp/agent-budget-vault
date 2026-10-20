# Agent Allowance

**Onchain budget for AI agents, enforced by the contract.**

Agent Allowance lets an owner (a human, a multisig, or an orchestrator contract) set a USDC spending stream for an AI agent — with linear vesting, per-transaction caps, an approved payee allowlist, and full pause/cancel controls. The agent never holds funds; every USDC payment flows directly from the vault to an approved vendor address on-chain.

---

## Architecture

```
BudgetVaultFactory  ──createVault()──►  BudgetVault  (one per agent)
     │                                       │
     │  vaults[]                             │  linear USDC vesting
     │  vaultOf[agent]                       │  claim(amount, payee) → vendor
     │                                       │
     └── registry for the demo frontend      └── owner / agent / operator slots
```

### Factory → Vault-per-agent

`BudgetVaultFactory` is a thin registry. Calling `createVault(owner, agent, agentId, registry, operator)` deploys a fresh `BudgetVault` for that agent, stores it in `vaults[]` and `vaultOf[agent]`, and emits `VaultCreated`.

The demo frontend enumerates vaults by calling `vaultOf[agentAddress]` or reading the indexed event log.

### BudgetVault

Each vault holds USDC on behalf of an agent and releases it linearly over time (Sablier Lockup semantics):

| Field | Role |
|---|---|
| `owner` | Creates the vault, deposits, manages payees, pauses/cancels |
| `agent` | Calls `claim(amount, payee)` to route budget to approved addresses |
| `operator` | Optional second caller that can also invoke `claim` (future orchestrator slot) |
| `agentId` | `uint256` — ERC-8004-style identity reference, stored for off-chain correlation; NOT a claim-time gate |
| `registry` | `address` — optional ERC-8004 registry address, stored for off-chain use |
| `token` | USDC (ERC-20), set by the factory from `USDC_TOKEN_ADDRESS` |
| `rate` | Token units per second (6-decimal USDC) |
| `startTime / endTime` | Stream window |
| `perTxCap` | Max USDC claimable in a single `claim` call (0 = no limit) |
| `payees[]` | Owner-managed allowlist; `claim` fails for any address not on it |

Vesting formula: `min(rate × elapsed, totalDeposited)`, where elapsed is capped at `endTime` (or `cancelTime` after a cancel).

**Cancel semantics:** on `cancel()`, the unvested remainder is returned to the owner immediately. Vested-but-unclaimed funds remain claimable by the agent/operator — vesting simply freezes at `cancelTime`.

### Seam for a Future Orchestrator

The `operator` slot is designed for a `SignedIntent` push-payment contract: instead of the agent calling `claim` directly, an orchestrator verifies a signed payment intent off-chain and routes it through the vault on the agent's behalf. Wire the orchestrator address in as `operator` via `setOperator()`.

`agentId` stores the agent's ERC-8004 registry token ID for off-chain resolution (identity card, service listing, x402 payment metadata) without putting any on-chain identity gate in the claim flow.

---

## Contracts (Arc Testnet)

| Contract | Address | Explorer |
|---|---|---|
| `BudgetVaultFactory` | `0x0f36cdda646bad0e8e65c48b2ee7304dfca84d25` | [View](https://explorer.testnet.arc.io/address/0x0f36cdda646bad0e8e65c48b2ee7304dfca84d25) |
| `BudgetVault` (impl) | deployed per agent via factory | — |

---

## Setup & Deploy

### Prerequisites

- [Bun](https://bun.sh) v1.x
- [Foundry](https://book.getfoundry.sh) (`forge`, `cast`)
- Arc Testnet USDC: `0x3600000000000000000000000000000000000000`

### Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `VITE_FACTORY_ADDRESS` | Deployed `BudgetVaultFactory` address (set after deploy) |
| `USDC_TOKEN_ADDRESS` | USDC ERC-20 on target chain (see values below) |
| `PRIVATE_KEY` | Deployer private key for forge-script self-deploy |

**USDC addresses:**
- Arc Testnet (chainId 5042002): `0x3600000000000000000000000000000000000000`
- Arc Mainnet (chainId 5042): `0x3600000000000000000000000000000000000000`

### Install & Dev

```bash
bun install
bun run dev          # http://localhost:5173
```

### Forge Tests

```bash
forge test --match-path "contracts/test/BudgetVault.t.sol" -v
# 33/33 pass (31 unit + 2 fuzz)
```

### Deploy (Forge Script — self-deploy)

```bash
# Arc Testnet
USDC_TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
PRIVATE_KEY=0x<your_key> \
forge script contracts/script/DeployAgentAllowance.s.sol \
  --rpc-url https://rpc.testnet.arc.io \
  --broadcast

# Arc Mainnet (use caution — real funds)
USDC_TOKEN_ADDRESS=0x3600000000000000000000000000000000000000 \
PRIVATE_KEY=0x<your_key> \
forge script contracts/script/DeployAgentAllowance.s.sol \
  --rpc-url https://rpc.mainnet.arc.io \
  --broadcast
```

After deploy, set `VITE_FACTORY_ADDRESS=<deployed address>` in `.env` and restart the dev server.

---

## Demo Frontend

The single-page app has three role views:

| Role | What you can do |
|---|---|
| **Owner** | Deploy a vault via the factory, deposit USDC (Approve + Deposit), manage payees, set the per-tx cap, set operator, pause/unpause, cancel the stream |
| **Agent** | Enter a vault address to see live-ticking vested/claimable amounts and the full schedule, then claim USDC to an approved payee |
| **Vendor** | Search a vault's `Claimed` event log by payee address to see incoming payments and total received |

Connect a wallet on Arc Testnet (get test USDC from the **Get test USDC** button in the Arc Studio sidebar), create a vault, fund it, and switch between role views to demo the full flow.

---

## Security Notes

- This is a demo/testnet deployment. Do not deploy to mainnet without a professional audit.
- The `onlyOwner` modifier is a simple address check; production use should consider `Ownable2Step` (two-step ownership transfer).
- Integer division in rate calculation means at stream end the vested amount may be `rate * duration` rather than exactly `totalDeposited` (up to a few USDC units dust — see test comments).
- The `cancel` path returns unvested tokens to `owner`; verify `token.balanceOf(address(this)) >= unvested` before transfer (already implemented).
