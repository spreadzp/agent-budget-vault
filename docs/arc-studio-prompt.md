Build a self-contained project "agent-budget-vault" (product name: Agent Allowance) and deploy it to Arc testnet.

Deliverables: Solidity contracts + deploy scripts + a single-page three-actor demo frontend + README + forge tests.

## Contracts

`BudgetVaultFactory.sol` — `createVault(owner, agent, agentId, registry, operator)` deploys a new `BudgetVault` per agent and emits VaultCreated with all params and the vault address. Keep a `vaults[]` / `vaultOf[agent]` registry for the frontend to enumerate.

`BudgetVault.sol` — per-agent USDC allowance vault with linear vesting (Sablier Lockup semantics):

Storage: `owner`, `agent`, `operator`, `agentId` (uint256, ERC-8004-style reference, storage-only — NOT a claim-time gate), `registry` (address), `token` (ERC-20, USDC), `rate` (token units per second), `startTime`, `endTime`, `streamed`, `claimed`, `paused`, `perTxCap`, `payees` (owner-managed allowlist).

Write functions:
- `deposit(amount, mode)` [owner only] — top-up. mode=EXTEND prolongs `endTime` keeping `rate`; mode=RAISE_RATE raises `rate` keeping `endTime`. Pull tokens via transferFrom.
- `claim(amount, payee)` [callable by `agent` OR `operator`] — reverts if `paused`, if `payee` not in allowlist, if `amount > vested()-claimed`, or `amount > perTxCap`. Checks → effects → transfer directly to `payee` (agent never holds funds).
- `addPayee/removePayee`, `setOperator`, `setPerTxCap` [owner only].
- `pause()/unpause()` [owner only] — blocks `claim` only (not deposit/cancel).
- `cancel()` [owner only] — after cancel, the still-vested remainder stays claimable by agent/operator; the unvested portion is returned to `owner`. Cancel must NOT freeze vested funds.

Views: `vested()` (min(rate*elapsed, total) semantics vs streamed bookkeeping — pick a consistent model), `claimable()`, `schedule()`, `isPayee(addr)`, `policy()` returning a full struct for the frontend (owner, agent, operator, agentId, registry, token, rate, startTime, endTime, perTxCap, paused, cancelled, vested, claimed, claimable, payees[]).

Events on EVERY write op (VaultCreated, Deposited, Claimed, PayeeAdded, PayeeRemoved, OperatorSet, PerTxCapSet, Paused, Unpaused, Cancelled).

USDC token address must come from deploy config/env — do NOT hardcode; document the env var name in README. Solidity ^0.8.24, OpenZeppelin contracts allowed.

## Forge tests

Cover: vesting accrual over time, claim by agent and by operator, perTxCap revert, non-allowlisted payee revert, pause blocks claim, cancel returns unvested to owner while vested stays claimable, deposit EXTEND vs RAISE_RATE behavior, onlyOwner reverts.

## Deploy scripts

Script(s) that deploy Factory (and optionally a demo vault) to Arc testnet (chainId 5042002) with network parameterized so mainnet (chainId 5042) is a config switch.

## Frontend

One page, role switcher with three roles:
- Owner: create vault (via factory), deposit/top-up, manage payee allowlist, set perTxCap, set operator, pause/unpause, cancel.
- Agent: view vested/claimable + schedule, claim(amount, payee) to a whitelisted payee.
- Vendor: view incoming payments for a payee address (claim event log).

Wallet connect, network badge (Arc testnet), contract addresses, last tx hash, live vested/claimable ticking display. Clean minimal UI.

## README

Product framing: "Agent Allowance — onchain budget for AI agents, enforced by the contract". Document architecture (factory → vault-per-agent), the seam for a future orchestrator (operator slot = SignedIntent push payments, agentId = ERC-8004-style identity reference), setup/deploy/env instructions, and testnet contract addresses after deploy.

Deploy contracts to Arc testnet and run the forge tests. Report deployed addresses and explorer links.
