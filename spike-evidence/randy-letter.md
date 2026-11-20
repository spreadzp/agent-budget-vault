# Letter to Randy — EPIC-254 Peach spike results (v3)

Hi Randy — the Peach DEX integration spike (EPIC-254) is delivered for
review. Branch `spike/epic-254-peach` on `agent-budget-vault`, exact
commit `f528fd3` (code tree; docs-only commits on top). Draft PR:
https://github.com/spreadzp/agent-budget-vault/pull/new/spike/epic-254-peach
**Decision: CONDITIONAL GO** (`spike-evidence/decision.md`).

## What we proved (live, Arc Testnet 5042002)

- 5 EURC → **9.709 USDC** via the aggregator → deposit into a real
  BudgetVault: swap
  `0x4e2669ae26291a4d6bfc37f8f3e7fdaec5440eec7f858180f1398ec5f2339006`,
  deposit `0xa91b386fc8a2d2736302a90c63bae47fe93089314b4a715f9c2292538dbc7b51`.
  Two more executed runs: `0x7587…6b60`/`0xf29c…6651` and
  `0x6d6a83…1355`/`0x04c485…beb3`.
- Post-persist crash recovery drilled live: process killed after the
  journaled hash+stage were persisted → resume adopted the same txHash,
  zero resends.
- Audit: 0 Critical, and after a final re-check the last High-class
  residual (signed calldata not verified) is **fixed in `f528fd3`** —
  the pre-sign checklist now pins the `0x02fcde22` calldata layout word
  by word (see Q3). Full history: `docs/EPICS/254-peach-dex-integration/
  reviews/REVIEW-FINDINGS.md`.
- Independent verification PASS (a separate model family re-ran the
  checklist; `spike-evidence/verification/`). Reproducible claims:
  `bun scripts/verify-evidence.mts` confirms that the four cited txs
  succeeded on-chain and were sent by our signer; `bun test scripts/lib/`
  = 80 pass.
- Mainnet sweep (read-only, no signatures): EURC→USDC ≈ **1.097**
  across 5→500 EURC, median latency 799 ms; cirBTC probe ~$61.6k/BTC,
  714 ms.

## Bugs / oddities on the Peach/Arc side

1. **Router mismatch V1 vs V2** — `getStatus()` advertises
   `execution_router_address = 0x5FF56925140D6f5912C8Ca6593f2C3BC28190607`,
   but `swapAllowance()` (V2) returns
   `contracts.execution_router = 0xfcf781866ae8933ade0b4bd056bb02525fd90663`
   — NOT listed in status. Our pre-sign checklist aborted on it; the e2e
   passed via the legacy `swap()` V1 path (advertised router).
   Both are OpenZeppelin `ERC1967Proxy` contracts with DIFFERENT
   implementations (`0x5FF5…` → `0x42de8fdf…0060`, `0xfcf7…` →
   `0xe7c034f6…eac5`) and no admin slot, so upgrades go through the
   implementation. **Is `0xfcf781…0663` legitimate, and why isn't it
   advertised?**
2. **`quote_ts` units** — the API returns `quoteTs` in **milliseconds**
   (e.g. 1795124478146), while surrounding semantics read as seconds.
   A naive seconds-comparison makes stale quotes look fresh forever.
   Please confirm/pin the unit.
3. **`deviation_ratio` absent** on testnet EURC→USDC quotes — the field
   isn't returned at all. We treat it as "not reported" (never as 0).
   Expected or an API gap?
4. **USDC-as-gas on Arc** — gas is charged on `0x3600…` (6 dec) AND a
   second Transfer event is emitted on `0xffff…fffe` (18 dec).
   Provenance checkers must subtract `gasUsed×effectiveGasPrice`, not
   just diff USDC Transfer logs. Worth a docs note.
5. **Testnet EURC/USDC price is synthetic and unstable** — our five
   executed 5-EURC swaps returned 15.514, 13.484, 11.829, 10.460, 9.709
   USDC (3.10 → 1.94 per EURC, declining — consistent with our own
   price impact on a thin pool). Do not quote testnet prices externally;
   mainnet sweep shows ~1.097.

## Questions

1. **SDK**: confirm `@masterpeach/arc-aggregator-sdk@1.2.1` (npm) is the
   correct pinned artifact/registry.
2. **Router contract-call compat**: can `swap()` (or the V2 route) be
   called with `recipient = <zap contract>` for zap-in composition, or
   must we settle to the EOA and deposit in a second tx (current
   approach)?
3. **Quote semantics + calldata layout**: which of `expectAmountOut` /
   `amountOutMin` / `deviationRatio` does the router enforce on-chain,
   and how is price impact/fee embedded? Related: we now pin the signed
   calldata for selector `0x02fcde22` (76 words: w2 chainId, w3 router,
   w4-6 signer, w7-8 tokenIn/Out, w11 amountIn, w12 amountOutMin,
   w13 expectOut, w19 deadline, w26-29 path echo) — **is this layout
   stable across router upgrades?** If it changes, our checklist fails
   closed (refuses to sign) — safe, but a heads-up would help.
4. **cirBTC testnet + `findRoutes` quirks**: is there a testnet cirBTC
   deployment (mainnet `0x171A…dAA0`)? And `findRoutes` sometimes
   returns paths whose amounts don't sum to top-level
   `amount_in`/`amount_out` — expected?

## Residuals (honest)

- One earlier swap mined before its run aborted on a provenance check
  (that run predates hash-journaling, so its txHash is not in the
  journal); the received USDC sits in the signer wallet `0x9264…41d9`
  as residue — accounted for as a finding, not hidden.
- Evidence index: `spike-evidence/README.md`.
