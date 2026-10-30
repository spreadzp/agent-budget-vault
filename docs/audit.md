# Audit — BudgetVault (SLICE-202-2)

External adversarial review via Arc Studio (session `202-audit-vault-2`,
app `2a9b1211-5360-41e5-addc-384542cb6293`), 2026-10-20.

**Verdict: REQUEST CHANGES → all Critical/High fixed and re-verified
(46/46 forge tests green).**

Scope: `contracts/BudgetVault.sol`, `contracts/BudgetVaultFactory.sol`.

## Manual review findings (pre-audit, fixed in commit 76c8f9b)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| F1 | High | First `deposit` with `amount < 30 days` in token units → `rate = 0` → funds never vest (locked until `cancel`) | `require(rate > 0, "AmountTooSmall")` |
| F2 | Medium | `EXTEND`: `endTime += amount / rate` floors → `amount % rate` dust never vests | ceil division `(amount + rate - 1) / rate` |
| F3 | Medium | `EXTEND` on expired vault extended stale `endTime` → new funds vest instantly | see H-1 below |
| F4 | Medium | `vaultOf[agent]` silently overwritten by second `createVault` | `require(vaultOf[agent] == 0, "VaultExists")` |
| F5 | Low | No zero-address guards in constructor/factory | `require != address(0)` |
| F6 | Nit | `removePayee` emitted `PayeeRemoved` for non-listed address | emit inside `if` |

## Arc Studio audit findings → resolution

| # | Severity | Finding | Resolution |
|---|----------|---------|-----------|
| C-1 | Critical | `cancel()`: silent skip `if (balanceOf >= unvested)` can lock unvested forever when `rate=0` corrupts `_vestedAt` | Removed guard — `safeTransfer` reverts loudly; root cause closed by C-2 fix |
| C-2 | Critical | `RAISE_RATE`: `rate = (totalDeposited - claimed) / remaining` can floor to 0 → vesting frozen permanently | ceil division + `require(rate > 0, "RateTooLow")` |
| C-3 | Critical | `cancel()` missing `nonReentrant`; post-cancel claim needs documented intent | Added `nonReentrant`; post-cancel claim kept BY DESIGN (vested stays claimable), intent comment added |
| H-1 | High | Expired vault cannot be re-funded — both modes reverted | `EXTEND` on expired vault now restarts the stream: `startTime` re-anchored to keep `vested()` continuous, new deposit vests over fresh window from now |
| H-2 | High | Post-cancel `claimable()` "double-spend" claim | Not exploitable — `vested()` freezes at `cancelTime`, `claimable = vested - claimed` is strictly bounded; documented |
| H-3 | High | `RAISE_RATE` non-deterministic result vs first-deposit `amount / 30 days` | Documented; ceil division removes residue risk |
| M-1 | Medium | `streamed`/`_syncStreamed` dead bookkeeping (~20k gas, misleading) | Removed |
| M-2 | Medium | `setOperator(0)` silently disables operator | Documented as intentional disable semantics |
| M-3 | Medium | `perTxCap` is per-transaction, not a rate limiter — repeat claims bypass | Documented: cap limits single tx size only |
| M-4 | Medium | `cancel()` pays `owner` field, not `msg.sender` | Equivalent (`onlyOwner`); `transferOwnership` intentionally absent |
| M-5 | Medium | `vaults[]` unbounded array | Accepted: off-chain indexed getter only; no on-chain iteration consumer |
| M-6 | Medium | Ceil-div consistency first-deposit vs EXTEND | Verified consistent post-fix |

## Invariants (contract properties that must always hold)

Added per `.windsurf/workflows/contract-security-testing.md` §1. Every
mutating function/branch must preserve all applicable invariants —
see matrix rule §2 of that workflow.

- **INV-1 Monotonicity**: `vested(t2) >= vested(t1)` for `t2 > t1` (same contract state).
- **INV-2 Bounded**: `vested() <= totalDeposited` always.
- **INV-3 Deposit continuity**: `deposit()` (any mode) must not change
  `vested(now)` or `claimable(now)` — no instant unlock on top-up.
- **INV-4 Claim bookkeeping**: `claimable() = max(0, vested - claimed)`;
  `claimed` only increases.
- **INV-5 Authorization**: `claim()` only by agent/operator, only to
  allowlisted payees, only within `claimable` (and `perTxCap` when set).
- **INV-6 Cancel split**: `cancel()` pays owner exactly
  `totalDeposited - vested(cancelTime)`; `vested()` freezes after.
- **INV-7 Conservation**: `token.balanceOf(vault) == totalDeposited - sum(claims)`.

## External reports (post-audit)

| # | Severity | Finding | Resolution |
|---|----------|---------|-----------|
| H-4 | High | `RAISE_RATE` applies the new rate retroactively: `rate` recomputed over remaining time but `startTime` left unchanged → `vested = rate * elapsed` jumps at deposit; unclaimed case can unlock the whole balance in the same block; `cancel()` then under-returns unvested to owner | Re-anchor `startTime` (same pattern as EXTEND-expired): `startTime = now - vestedNow/newRate` computed with the old rate, capped by pre-deposit `totalDeposited`. PoC regression tests added. Reported by KupiaSec via email, 2026-10-30 (`docs/PROPOSITIONS/AUDIT/3010.md`) |

## Test coverage

50 forge tests (2 suites): vesting linearity, claim auth (agent/operator/
nobody), allowlist, perTxCap, pause/unpause, cancel split + exact remainder
after partial claim, post-cancel claimability, EXTEND restart continuity,
RAISE_RATE ceil + H-4 vested-continuity (PoC from KupiaSec report:
claimed/unclaimed/cancel-under-return + stateful fuzz invariant),
zero-addr guards, duplicate-agent revert, removePayee events.
