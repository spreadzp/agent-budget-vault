# EPIC-254 Decision — CONDITIONAL GO

**Date**: 2026-11-20 · **Branch**: `spike/epic-254-peach` · **Commit**: e551437

## Decision

**CONDITIONAL GO** — the Peach Arc Aggregator is usable for the
agent-budget-vault EURC→USDC flow on Arc, subject to the conditions and
production notes below.

## Methodology

- Read-only mainnet sweep: EURC 5/25/100/500 ×3 runs + cirBTC probe
  (`sweep/*.json`, chainId 5042, no signatures).
- Live testnet execution: full approve→swap→verify→approve→deposit into
  a real BudgetVault; crash-recovery drilled twice post-broadcast.
- Safety gate: six-round Arc Studio audit → 0 Critical / 0 High
  (`reviews/REVIEW-FINDINGS.md`, rounds N..N6 with dispositions).
- Independent verification: Nemotron 3.5 Lightning checklist run PASS
  (`verification/SLICE-254-8-hermes-nemotron.md`); reproducible via
  `bun scripts/verify-evidence.mts` + `bun test scripts/lib/` (71 tests).

## Sweep summary (mainnet, 2026-11-19)

| Pair | Sizes | Price | Latency (med) | Notes |
|---|---|---|---|---|
| EURC→USDC | 5/25/100/500 ×3 | **1.0970 → 1.0968** (monotonic ↓ with size) | 799 ms | stable, ~−0.03% across 100× size range |
| cirBTC→USDC | ~0.0000812–0.001624 | implies ~$61.6k/BTC | 714 ms | probe only; thin testnet liquidity |

EURC/USDC pricing tracks EUR≈USD as expected; slippage vs size is tiny.
Testnet price (~3.1) is synthetic — do NOT quote it externally.

## Fee / slippage policy recommended by results

- `slippageBps=50` used throughout; testnet fills met `amountOutMin`.
- Quotes expire ~110 s — enforce deadline at signing time (we now treat
  `quote_ts` as ms; see findings).
- `deviation_ratio` may be absent — handle "not reported" explicitly
  rather than defaulting to 0.

## Conditions (must be resolved before production reliance)

1. **Router mismatch (primary open question for Randy/Peach)**:
   `getStatus()` advertises execution router `0x5FF569…0607` but
   `swapAllowance()` (V2) returns `0xfcf781…0663`, which is NOT in
   status. Production must either get an authoritative router list or
   continue pinning the status-advertised router (V1 path used here).
2. **`quote_ts` semantics** — API returns ms, docs/context suggest s.
   Confirm and pin the unit; wrong unit silently disables freshness
   checks.
3. **`deviation_ratio` availability** — absent on testnet EURC→USDC.
   Confirm whether absence is expected or an API gap.
4. Second independent verifier family (Luna) still blocked by org quota —
   recommended but not blocking given the 6-round audit + Nemotron pass.

## Production notes

- Keep the journaled-tx architecture verbatim: atomic
  hash+raw+stage-before-broadcast, outcome consumption at any stage,
  block-body proof before declaring a tx dead. This is what survived six
  audit rounds.
- USDC-on-Arc is gas: always reconcile `gasUsed×effectiveGasPrice`
  against balance deltas; never diff Transfer events alone.
- Cap per-swap size at tested range (≤500 EURC) until deeper-liquidity
  probe data exists; add a fresh sweep before raising.
- Keep `reuseNonce` pinning + two-probe abandon — they are what make
  operator recovery safe under RPC flakiness.
