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

## Test coverage

46 forge tests (2 suites): vesting linearity, claim auth (agent/operator/
nobody), allowlist, perTxCap, pause/unpause, cancel split + exact remainder
after partial claim, post-cancel claimability, EXTEND restart continuity,
RAISE_RATE ceil, zero-addr guards, duplicate-agent revert, removePayee events.
