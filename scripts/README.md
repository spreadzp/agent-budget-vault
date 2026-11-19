# EPIC-254 Peach spike — `peach-e2e.mts`

Safety-first testnet spike: EURC → Peach Arc Aggregator → USDC → BudgetVault.

## Commands

- `status` — env gate: chainId/factory/token metadata/SDK/signer (both nets)
- `provision` — create/adopt the single testnet vault (idempotent via `vaultOf[agent]`)
- `sweep` — mainnet read-only quote sweep (EURC ×3 sizes, cirBTC probe)
- `e2e` — guided happy path: quote → checks → approve → swap → verify → approve → deposit
- `e2e --drill` — same, but exits right after swap broadcast (crash-window drill)
- `resume` — reconcile persisted intents by on-chain truth, finish the run
- `neg <expired-quote|insufficient-eurc|wrong-chain>` — abort-evidence generators

## Crash window (D-254-12)

Every financial tx follows `submitGuarded` (`lib/tx.mts`):

1. `recordIntent({step, sender, nonce, params})` → `state/peach-e2e.json`
   **persisted BEFORE broadcast** — the file is the journal, not memory.
2. Broadcast → `markSubmitted(step, txHash)` → persisted immediately.
3. Receipt → pending cleared, FSM advances.

If the process dies between (1) and (3), the pending entry with its
`txHash` survives. `resume` reconciles it via `getTransactionReceipt` —
mined → adopt outcome and continue; missing → in-flight, **resend is
forbidden** until the outcome is known; reverted → cleared, re-run allowed.

`git`-ignored: `state/` (journal), `.env` (key). Committed:
`spike-evidence/` (transcripts, never secrets).
