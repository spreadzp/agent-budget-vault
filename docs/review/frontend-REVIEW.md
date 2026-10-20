# Review Findings — agent-allowance-frontend (EPIC-202 / SLICE-202-3)

## Scope
`src/App.tsx`, `src/config.ts`, `src/contracts.ts`, `src/hooks/useVaultDiscovery.ts`, `src/lib/scanClaimedLogs.ts`, `src/components/OwnerPanel.tsx`, `src/components/AgentPanel.tsx`, `src/components/VendorPanel.tsx`, `src/components/VestedTicker.tsx`, `src/components/RoleSwitcher.tsx`

## Verdict

**REQUEST CHANGES**

Every `writeContract` call hard-codes `chainId: ARC_TESTNET_CHAIN_ID` in the wagmi call options, which is the correct mitigation for most wrong-network attacks, but the approve→deposit two-step has a stale-allowance race that can leave an exact-amount approval sitting on-chain permanently if the deposit reverts. Additionally, the event-log scan silently truncates history past MAX\_CHUNKS and presents partial results as a complete count with no caveat, which is a material display inaccuracy for the vendor and agent audit trail. These two items alone block approval; the remaining findings are Medium or lower.

---

## Critical

_No findings at Critical severity. No private-key inputs, no VITE\_\* secret exposure, and all write paths check the chain before signing._

---

## High

### H-1 — Stale USDC allowance after failed deposit (OwnerPanel.tsx)

**File:line:** `src/components/OwnerPanel.tsx:87–105` (fireDeposit / useEffect approval chain)

**Evidence:**
```ts
// approve fires first; deposit fires when approvalDone === true
React.useEffect(() => {
  if (approvalDone && pendingDepositRef.current) {
    fireDeposit();
  }
}, [approvalDone, fireDeposit]);

// fireDeposit:
writeContract({
  address: pd.vault as `0x${string}`,
  functionName: 'deposit',
  args: [pd.amt, pd.mode],
  chainId: ARC_TESTNET_CHAIN_ID,
});
```
`approvalDone` is derived from `useWaitForTransactionReceipt({ hash: lastHash })`. `lastHash` is set by `onSuccess` on **any** writeContract call, not just the approve. If a prior unrelated tx sets `lastHash` before a new approve, `approvalDone` may fire against the wrong hash. More concretely: approve succeeds → deposit reverts (vault paused, rate=0, amount > claimable, or any contract revert) → the UI shows an error toast and clears `pendingDepositRef`, but the ERC-20 allowance of `parsed.raw` units remains on the vault contract indefinitely. A future deposit call (or a malicious contract that obtained vault-operator status) can spend it.

**Scope:** Exact-amount approve means the vault can only pull exactly that amount, so direct loss requires the vault itself to be compromised. However, for any scenario where the vault is later cancelled and the USDC contract is the real-USDC contract on mainnet, the owner's wallet has an open allowance to an abandoned contract. The `lastHash` mux issue can also cause `fireDeposit` to be called twice if another write completes while `pendingDepositRef` is still populated.

**Exploit scenario:**
1. Owner clicks "Approve & Deposit 500 USDC". Approve tx confirmed (lastHash = approve hash). Deposit tx submitted but reverts.
2. UI shows error. `pendingDepositRef.current` is nulled by `fireDeposit()` before the revert is observed (the null happens synchronously on the fireDeposit call, before the tx result is known).
3. Allowance of 500 USDC remains on the vault. Owner never gets an "allowance still open, please revoke" notice.
4. In a cancelled-vault flow where vault contract ownership or upgrade is possible, the allowance can be drained later.

**Fix:** After deposit `onError`, issue a follow-up `approve(vault, 0)` revocation. Alternatively, switch to a `permit`-based flow (EIP-2612) so the approval is atomic with the deposit. At minimum, track the approval hash separately from `lastHash` so `approvalDone` cannot be triggered by an unrelated write.

---

### H-2 — Silent MAX\_CHUNKS history truncation presented as complete results (scanClaimedLogs.ts + AgentPanel.tsx + VendorPanel.tsx)

**File:line:** `src/lib/scanClaimedLogs.ts:15, 77` and `src/components/AgentPanel.tsx:258–261`, `src/components/VendorPanel.tsx:148–158`

**Evidence:**
```ts
// scanClaimedLogs.ts
const MAX_CHUNKS = 12;   // hard cap ≈ 48 000 blocks per vault (~13 h on 1 s/block)
// loop exits silently when chunks === MAX_CHUNKS without any flag
while (chunks < MAX_CHUNKS) { ... chunks++; }
return results;          // returns whatever was found; no "truncated" signal
```
```tsx
// AgentPanel.tsx — after scan:
{!claimsLoading && claims.length === 0 && claimsFailed === 0 && (
  <p className="text-xs text-[var(--muted)]">No claims found in recent history.</p>
)}
// "recent history" caveat exists, but when claims.length > 0 the header shows:
<span>Total: {formatUsdc(claims.reduce(...))} USDC</span>
// presented as the complete total, not as a 48k-block window total
```
```tsx
// VendorPanel.tsx:
<h3>{events.length} payment{...} found</h3>
<span>{formatUsdc(total)} USDC total</span>
// no indication that this may be a partial window
```

**Exploit scenario:**
- Arc Testnet running at ~1 block/s: 48 000 blocks ≈ 13 hours. Any vault older than 13 hours will have its earliest claims silently dropped.
- An agent disputes "I only received 200 USDC total" when the real on-chain total is 800 USDC; the UI corroborates the wrong figure because it only scanned the last 13 hours.
- A vendor runs the "Scan all" cross-vault scan on a long-running deployment; the UI says "3 payments, 150 USDC total" which a counterparty can use to argue non-payment when 14 earlier payments exist beyond the window.
- `ScanResult` never sets a `truncated` boolean, so callers cannot distinguish "scanned everything" from "hit the chunk cap."

**Fix:** Add `truncated: boolean` to `ScanResult` (set it when `chunks === MAX_CHUNKS && clampedFrom > earliest`). Surface a warning in both panels: "Scan limited to last 48 000 blocks — some older history may be missing." The "Total" display should be labelled "Total (last ~13 h)" when truncation occurred.

---

## Medium

### M-1 — No `isAddress` validation before `writeContract` on raw text inputs (OwnerPanel.tsx, VendorPanel.tsx)

**File:line:** `src/components/OwnerPanel.tsx:131–148` (handleCreateVault), `OwnerPanel.tsx:151–162` (vaultAction), `VendorPanel.tsx:72` (doSingleSearch)

**Evidence:**
```ts
// handleCreateVault — agentAddr passes straight through:
writeContract({
  args: [address!, agentAddr as `0x${string}`, ...],
});

// vaultAction — addPayee, removePayee, setOperator all use raw text:
const vaultAction = (fn: string, args: unknown[]) => {
  writeContract({ address: vaultAddr as `0x${string}`, ... args });
};

// VendorPanel doSingleSearch only checks startsWith('0x'):
if (!singleVault || !singleVault.startsWith('0x')) { setSingleError('Enter a valid vault address'); return; }
```

**Impact:**
- A 40-hex-character but **not** EIP-55-checksummed address is passed verbatim to the contract; viem accepts it and signs. The checksum gap is acceptable but the missing-length / non-hex characters are not: pasting a truncated or non-hex address (`0x1234`) causes a viem encode error that is caught by the outer `try/catch` and shown as a truncated toast — not as a user-understandable "invalid address" message.
- Zero address (`0x000…`) is accepted as agent/operator without warning. Setting the operator to zero is intentional (disable), but setting the **agent** to zero at vault creation locks out all agent-side claims forever. The field shows no inline warning for zero-address agent.
- `vaultAddr` in the Advanced manual override is typed `string` throughout and cast with `as \`0x${string}\`` with no length or hex check. A non-address string passed to `address:` in `writeContract` will produce an opaque internal viem error rather than a friendly message.

**Fix:** Import `isAddress` from viem and guard each address input before submitting. Warn explicitly when the agent address is `0x000…`. For the vault manual-override, validate before storing into state.

---

### M-2 — Wrong-network approve targets mainnet USDC if `USDC.address` resolves on a different chain (OwnerPanel.tsx)

**File:line:** `src/components/OwnerPanel.tsx:18, 119`

**Evidence:**
```ts
const USDC = getUsdc(ARC_TESTNET_CHAIN_ID)!;   // module-level constant, always Arc Testnet USDC
// ...
writeContract({
  address: USDC.address as `0x${string}`,
  abi: erc20Abi,
  functionName: 'approve',
  chainId: ARC_TESTNET_CHAIN_ID,   // ← chain override present
});
```
The `chainId` override on the approve call is correct and will cause the wallet to prompt for a chain switch if the wallet is on mainnet. However, `USDC.address` is the Arc Testnet USDC contract. If the wallet is on mainnet and the user accepts the chain switch mid-flow (after approve was submitted but before deposit), the two-step flow can land the approve on one chain and the deposit attempt on another. `switchIfNeeded` exits early if the chain is wrong, so a wallet already on mainnet would switch, resubmit, and the `pendingDepositRef` would still hold the vault address from before the switch — and that vault address does not exist on mainnet.

**Impact:** Not a direct fund-loss path because mainnet USDC at the Arc Testnet vault address would just revert (no code at that address on mainnet). However the user experience is a confusing silent revert, and H-1's stale-allowance problem applies here too since `switchChain` returns `true` before the approval fires.

**Fix:** Move the chain guard to disable the "Approve & Deposit" button entirely (not just check at click time), so the user cannot start the two-step flow while on the wrong chain. The current pattern of switching and returning immediately means the second call within the same click handler is silently dropped.

---

### M-3 — VestedTicker local clock diverges from contract `vestedRaw` after pauses/cancels (VestedTicker.tsx)

**File:line:** `src/components/VestedTicker.tsx:52–63`

**Evidence:**
```ts
let liveVested = vestedRaw;
if (rate > 0n && startTime > 0n) {
  const effectiveEnd = cancelled && cancelTime ? cancelTime : endTime;
  const ts = clamp(now, startTime, effectiveEnd);
  if (ts > startTime) {
    const elapsed = ts - startTime;
    const accrued = rate * elapsed;
    liveVested = clamp(accrued, 0n, totalDeposited);
  }
}
```
**Three divergence scenarios:**

1. **Paused vault:** `paused` is not a prop; the ticker keeps ticking even when the vault is paused. The contract freezes vesting at pause time, but the UI continues to show an increasing "Claimable" number. An agent sees "85 USDC claimable", attempts to claim, and the tx reverts ("vault paused"). This is a misleading display finding.

2. **`cancelTime` not passed from callers:** Both `OwnerPanel` and `AgentPanel` call `<VestedTicker>` without `cancelTime` prop. When the vault is cancelled, `effectiveEnd` falls back to `endTime` (the original stream end), so the ticker still interpolates forward until `endTime` passes rather than freezing at the actual cancel moment. A cancelled vault with 6 months remaining will show growing claimable values that the contract will not honour.

3. **`totalDeposited` prop is `policy.vested + policy.claimable`:** This is the remaining claimable balance at the last read, not the total ever deposited. After claims, this sum shrinks, so the `progressPct` denominator shrinks too, causing the progress bar to jump backward (e.g., 70% → 90%) after a successful claim, which reads as a regression rather than progress.

**Fix:**
- Add `paused: boolean` prop; return `vestedRaw` without ticking when `paused`.
- Thread `cancelTime` from `policy` to the VestedTicker call sites, or derive it inside the component from `cancelled + rate + vestedRaw`.
- Change the `totalDeposited` prop to represent the total amount ever deposited (sum of all deposits) rather than the current balance.

---

### M-4 — Agent claim history filters by `caller`, not `payee`, silently hiding operator-submitted claims (AgentPanel.tsx)

**File:line:** `src/components/AgentPanel.tsx:75–85`

**Evidence:**
```ts
const { logs, failedCount } = await scanClaimedLogs(
  client,
  [vaultAddr as `0x${string}`],
  {
    callerFilter: address,   // ← agent's address as the caller filter
    ...
  },
);
```
The `Claimed` event is defined as:
```ts
'event Claimed(address indexed caller, address indexed payee, uint256 amount)'
```
If the vault has an **operator** who submits claims on behalf of the agent (the operator calls `claim(amount, payee)` and `msg.sender` = operator), those events are emitted with `caller = operator`, not `caller = agent`. The agent panel therefore shows 0 claims in its "My Claims" history even though funds were disbursed. This also means the "Total" USDC figure shown is understated.

**Exploit scenario (misleading display, not a fund loss):** An operator drains 10 000 USDC via claims over several weeks. The agent checks their claims history and sees 0 USDC — they conclude nothing has been paid and re-negotiate or re-submit, when in fact funds have left the vault.

**Fix:** Either scan without `callerFilter` (show all claims from the vault) and visually distinguish caller = agent vs caller = operator, or add a second parallel scan for `callerFilter = operator` and merge. The section header should be "Vault Claim History" not "My Claims" unless the filter is intentionally restricted to agent-self-calls.

---

### M-5 — `Number(policy.rate) / 1e6` float division on a BigInt rate field (AgentPanel.tsx)

**File:line:** `src/components/AgentPanel.tsx:194`

**Evidence:**
```ts
['Rate/s', activePolicy.rate > 0n ? `${(Number(activePolicy.rate) / 1e6).toFixed(8)} USDC` : '—'],
```
`Number()` on a BigInt is only safe up to 2^53 − 1. For a rate expressed in 6-decimal USDC: 2^53 / 10^6 ≈ 9 × 10^9 USDC/second. That is an enormous rate and not practically reachable on testnet, but on mainnet a vault configured with a rate above ~9 billion USDC/s would silently lose precision and display the wrong rate. More practically, this is the only place in the codebase that uses `Number()` on a USDC bigint rather than `formatUsdc` — it should use the canonical formatter for consistency.

**Fix:** Replace with `formatUsdc(activePolicy.rate) + ' USDC/s'` (using the existing `formatUsdc` which handles 6-decimal BigInt correctly), or use `formatAmount` from `@/onchain-money`.

---

## Nits / Suggestions

### N-1 — `refetchInterval: 10_000` pollers have no cleanup / visibility guard

**File:line:** `src/hooks/useVaultDiscovery.ts:63, 112, 159, 184`

`useReadContract`/`useReadContracts` with `refetchInterval` runs regardless of tab visibility. Wagmi's TanStack Query integration does apply document visibility by default, but with `refetchInterval` set the queries will also refetch on focus return. For the owner panel with many vaults, this can generate a burst of N vault policy reads every time the user alt-tabs back. Not a bug, but worth noting for production deployments with 100+ vaults.

---

### N-2 — `key={i}` on claim/event list items (AgentPanel.tsx, VendorPanel.tsx)

**File:line:** `src/components/AgentPanel.tsx:265`, `src/components/VendorPanel.tsx:161, 227`

Using the array index as `key` means React cannot track list identity across re-renders (e.g., after a re-scan that returns a different subset). Use `${ev.txHash}-${ev.vault}-${ev.blockNumber}` as the key for stable identity.

---

### N-3 — `setTimeout(() => refetchVaults(), 4000)` is a fire-and-forget heuristic (OwnerPanel.tsx)

**File:line:** `src/components/OwnerPanel.tsx:78–80`

A 4-second delay assumes the tx will be confirmed within 4 seconds on Arc Testnet. On a loaded chain or mainnet this may refetch before the tx is mined, showing stale state. The existing `useWaitForTransactionReceipt` hook is already wired — trigger `refetchVaults` in `isSuccess` from that hook instead.

---

### N-4 — `fmtAddr` truncates to 8+4 characters, hiding checksum information (all panels)

**File:line:** e.g. `src/components/OwnerPanel.tsx:30`

All panels use `${a.slice(0, 8)}…${a.slice(-4)}` which includes the `0x` prefix in the 8 chars, leaving only 6 hex chars of the address visible — not the standard 6+4 that most UIs use. This is a nit but increases the chance that two similar addresses are displayed identically after truncation (prefix collision). Consider `0x${a.slice(2, 6)}…${a.slice(-4)}` (6 address chars + 4 suffix) or display the full checksummed address on hover/title.

---

### N-5 — Manual vault override bypasses ownership check (OwnerPanel.tsx, AgentPanel.tsx)

**File:line:** `src/components/OwnerPanel.tsx:48–49`, `src/components/AgentPanel.tsx:33–34`

```ts
const vaultAddr = showAdvanced && manualVault ? manualVault : selectedVault;
```
The manual vault address is used for all write operations without verifying that the connected wallet is actually the owner (OwnerPanel) or the agent (AgentPanel) of that vault. A user can paste any vault address and attempt owner-only calls; the contract will revert, but the UX presents no warning. For OwnerPanel especially, this means the "Deposit USDC", "Pause", "Cancel" sections appear and are clickable for any pasted vault address, including one the user does not own.

**Suggested fix:** After a manual vault address is entered, run a read of `policy.owner` and compare to `address`. Display an inline warning if they do not match.

---

### N-6 — `VendorPanel` validation only checks `startsWith('0x')` (VendorPanel.tsx:72)

**File:line:** `src/components/VendorPanel.tsx:72`

```ts
if (!singleVault || !singleVault.startsWith('0x')) {
  setSingleError('Enter a valid vault address'); return;
}
```
A 3-character string `"0x1"` passes this check and is passed to `scanClaimedLogs`, which will attempt `client.getLogs({ address: "0x1", ... })`. Viem will encode this to a padded address and the RPC call will return an empty result without an error, making the UI silently appear to have scanned a valid vault. Use `isAddress(singleVault)` from viem.

---

### N-7 — Explorer links always point to Arc Testnet regardless of connected chain (all panels)

**File:line:** `src/components/OwnerPanel.tsx:285–292`, `src/components/AgentPanel.tsx:272–278`, `src/components/VendorPanel.tsx:167–171, 182–185`

```ts
href={buildAddressExplorerUrl(ARC_TESTNET_CHAIN_ID, selectedVault)}
href={buildTxExplorerUrl(ARC_TESTNET_CHAIN_ID, c.txHash)}
```
`ARC_TESTNET_CHAIN_ID` is hardcoded into every explorer link. If a future build targets mainnet (Arc mainnet is also in `src/config.ts`), all explorer links would still point to the testnet explorer. Since the current config has mainnet only for ENS, this is a nit today but will become a bug if mainnet is activated. Replace the hardcoded chain ID with the `chainId` from `useAccount()` where the call is wallet-connected.

---

### N-8 — `agentId` input accepts negative numbers and non-integers (OwnerPanel.tsx)

**File:line:** `src/components/OwnerPanel.tsx:197`, `src/components/OwnerPanel.tsx:142`

```tsx
<input type="number" placeholder="0" value={agentId} onChange={e => setAgentId(e.target.value)} />
// ...
args: [ ..., BigInt(agentId), ... ]
```
`BigInt('-1')` will throw a RangeError in some environments (negative values invalid for uint256). `BigInt('1.5')` throws a SyntaxError. Neither is caught before the `writeContract` call; the error surfaces only in the wallet popup or as a viem error. Add `min="0"` to the input and parse with `parseInt`/`Math.floor` before calling `BigInt()`.

---

## Verified-good

1. **Chain guard on every write path.** All `writeContract` calls in OwnerPanel and AgentPanel pass `chainId: ARC_TESTNET_CHAIN_ID` and call `switchIfNeeded()` before signing, preventing mainnet txns from being silently signed against testnet contract addresses. This is the correct wagmi v2 pattern.

2. **Exact-amount USDC approval.** The `approve` call passes `parsed.raw` (the exact deposit amount) rather than `MaxUint256`. This is best-practice ERC-20 hygiene and limits the blast radius of any vault compromise.

3. **`parseAmount` / `formatUsdc` used throughout.** All USDC amount conversions use the canonical `@/onchain-money` module — no hand-rolled `* 1e6` or `parseUnits(x, 6)` literals exist in the reviewed files.

4. **Chunked backwards scan with progress reporting.** `scanClaimedLogs` correctly handles Arc Testnet's ~9 000-block getLogs limit by using 4 000-block windows, surfaces RPC errors per-vault via `failedCount`, and provides a progress callback so the UI can show block ranges rather than a spinner. The backwards scanning direction (newest first) ensures the most recent events are always captured even if the history cap is hit.

5. **No secrets in the bundle.** `VITE_FACTORY_ADDRESS` is the only `VITE_*` variable in scope and it is a public contract address — appropriate for Vite's `import.meta.env` exposure. No private keys, entity secrets, or API keys appear in any reviewed file.

6. **Vendor panel is read-only without wallet.** `App.tsx:70` renders `VendorPanel` regardless of wallet connection state (`{(role === 'vendor') && <VendorPanel />}`) while OwnerPanel and AgentPanel require `isConnected`. This is the correct design — a vendor should be able to look up payment history without connecting a wallet.

7. **`rel="noopener noreferrer"` on all external links.** Every `<a target="_blank">` in the reviewed files carries both attributes, preventing reverse tabnapping.

8. **VestedTicker interval cleanup.** `useEffect` returns `() => clearInterval(id)` correctly, preventing a timer leak on unmount.

9. **`usePublicClient({ chainId: ARC_TESTNET_CHAIN_ID })`** in AgentPanel and VendorPanel pins the public client to Arc Testnet for getLogs calls, preventing the client from being undefined or pointing to the wrong chain when the wallet is on mainnet.

10. **`switchIfNeeded` returns a boolean and callers bail early.** The guard pattern `if (switchIfNeeded()) return;` prevents the rest of the write handler from running when a chain switch is initiated, avoiding a double-submit scenario.
