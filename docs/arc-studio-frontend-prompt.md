# Arc Studio Frontend Turn — Three-Actor Demo (SLICE-202-3)

Prompt given to the existing Arc Studio session `202-agent-budget-vault`
(the app this repo was generated from). The baseline front already has a
role-switcher, OwnerPanel, AgentPanel, VendorPanel and a VestedTicker.
This turn closes the remaining demo-flow gaps.

---

You are continuing work on the Agent Allowance frontend. The contracts were
hardened since generation — the attached `contracts/BudgetVault.sol`,
`contracts/BudgetVaultFactory.sol` and rebuilt `contracts/out/` artifacts are
the CURRENT ABI source of truth (`streamed` getter no longer exists;
`cancel()` is now `nonReentrant`; `deposit(EXTEND)` on an expired vault
restarts the stream instead of reverting).

Improve the three-actor demo UX on the existing dark-theme page. Do NOT
rewrite the design system — keep the card/tailwind style and the
RoleSwitcher layout.

## 1. Vault discovery (replaces manual address pasting)

OwnerPanel and AgentPanel currently require pasting a vault address.
Replace with automatic discovery:

- Add a `useVaultDiscovery` hook (src/hooks/) that reads the factory:
  - `factory.vaults(uint256 i)` iterated to `factory.vaultCount()`, then
    `vault.policy()` per vault, OR `factory.vaultOf(address)` for a known
    agent — prefer `vaultOf` for Agent view, vault-list scan for Owner view
    (filter `policy.owner === connected address`).
- OwnerPanel: "My Vaults" dropdown/list with status badge
  (active / paused / cancelled / expired) selecting `vaultAddr` for all
  controls below. Keep manual-input as collapsed "advanced" fallback.
- AgentPanel: auto-resolve the connected wallet's vault via
  `factory.vaultOf(address)`; show "no vault yet" empty state instead of
  the address input. Keep advanced manual input collapsed too.
- After `createVault` succeeds, refresh discovery and auto-select the new
  vault (read `VaultCreated` event from the receipt or poll vaultOf).

## 2. AgentPanel: payee select + claim history

- Replace the payee text input with a `<select>` of `policy.payees`
  (labelled with truncated address + optional name field later — plain
  address is fine). Remove the allowlist yes/no hint — the select IS the
  allowlist.
- Add "My claims" card: fetch `Claimed` events for the selected vault
  where `caller == agent` (same bounded getLogs pattern as VendorPanel,
  last ~10k blocks), newest first — amount, payee, block, explorer link.

## 3. VendorPanel: scan across all factory vaults

- Current UI requires a specific vault address. Change to: read
  `factory.vaultCount()` → iterate `vaults(i)` → `getLogs(Claimed)` per
  vault filtered `payee == connected address` (or a manual payee input if
  wallet not connected), merge and sort by blockNumber desc.
- Show per-payment: amount USDC, source vault (truncated, explorer link),
  block, tx link. Keep the existing single-vault search as an "advanced"
  collapsible section.

## 4. Live numbers everywhere

- VestedTicker already exists in AgentPanel — reuse it in OwnerPanel for
  the selected vault (vested ticking, claimable, % progress bar of
  `vested/totalDeposited`).
- Poll `policy()` every ~10s (refetchInterval) so pause/cancel/deposit by
  another tab reflects quickly; the ticker itself stays client-side
  interpolation.

## 5. Small correctness items

- USDC everywhere formatted via `formatUsdc` (6 decimals) — verify no raw
  `bigint.toString()` leaks into the UI.
- Every tx hash → `TxHashBadge`/`buildTxExplorerUrl` link.
- Deposit mode select: show human labels "Extend duration" (0) and
  "Raise rate" (1), plus a hint that EXTEND on an expired vault restarts
  the stream from now.
- `setOperator(0x0)` labelled "Disable operator" when entered.

## Constraints

- Contract addresses stay env-driven (`VITE_FACTORY_ADDRESS`), no
  hardcoded addresses beyond chain constants.
- No new deps beyond what's in package.json (wagmi/viem/connectkit).
- Keep `bun run build` clean.

---

## Follow-up turn (getLogs chunking fix)

Bug fix on the existing Agent Allowance frontend (continue in the same
codebase).

PROBLEM: `eth_getLogs` on https://rpc.testnet.arc.io reverts with
`-32012 requested range too large` when the block range exceeds roughly
9,000 blocks (verified: 10,000 fails, 5,000 succeeds). Three call sites
currently request `blockNumber - 10000n` in one shot and silently swallow
the revert via `.catch(() => [])`, so:

- VendorPanel "Scan all vaults" → always renders "0 payments found"
  even though Claimed events exist onchain (verified via cast).
- VendorPanel "Advanced: search one vault" → same failure.
- AgentPanel "My claims" history → same failure.

FIX (required for all three call sites):
1. Chunk every getLogs scan into windows of at most 4,000 blocks
   (safe margin under the RPC cap) and merge results.
2. Paginate backwards until `fromBlock` reaches the vault's creation
   block when it is known, otherwise until `fromBlock` hits 0 — with a
   hard cap of 12 chunks (~48k blocks) per vault to bound latency.
3. Extract a shared helper — e.g. `src/hooks/useClaimedLogs.ts` or a
   plain function `scanClaimedLogs(client, vaults, payeeFilter)` in a
   lib file — used by all three call sites. Do not copy-paste the loop
   three times.
4. Surface real errors instead of swallowing: keep the per-vault
   `.catch` but collect failures into a `failedCount` shown as a small
   warning line ("N vaults could not be scanned") rather than silent [].
   A hard RPC error message like "requested range too large" must never
   reach the user.
5. While scanning more than one chunk, show "Scanning blocks
   X..Y of Z" progress so multi-chunk scans don't look frozen.

CONSTRAINTS: same as before — no new deps, keep `bun run typecheck` clean,
keep the dark-theme card UI unchanged, keep env-driven addresses.
Verify by scanning the existing vault set: one vault
(0x392650B0d268b6370863c2f7147D96c585e09634) has a Claimed event to payee
0x9a664574282b61d31f5A4f22DE63c8Ad248e95A5 within the last few hundred
blocks — the scan must find it.
