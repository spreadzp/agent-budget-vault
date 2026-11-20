## Summary

Reproducible spike proving 5 EURC converts to USDC via the **Peach Arc
Aggregator** and lands in the correct `BudgetVault` - with a crash-safe,
unreplayable FSM journal. Read-only mainnet route sweep included. No
`contracts/` or `src/` changes - scripts/config/evidence only.

**Decision: CONDITIONAL GO** - see `spike-evidence/decision.md`.

## What ran (all live on Arc Testnet)

- Full happy path: EURC approve -> swap -> provenance-verify -> USDC
  approve -> `vault.deposit` -> **DEPOSITED**
- Post-persist crash drill x3: killed after swap broadcast -> `resume`
  adopted the **same txHash**, zero resends
- Negative cases: insufficient-eurc, wrong-chain, expired-quote - all
  abort pre-sign
- Mainnet sweep (read-only): EURC 5/25/100/500 x3 -> price ~**1.097**,
  median latency 799 ms; cirBTC probe ~$61.6k
- Testnet txs: swap `0x4e2669...39006`, deposit `0xa91b38...c7b51`
  (+ pairs `0x7587...6b60`/`0xf29c...6651`,
  `0x6d6a83...1355`/`0x04c485...beb3`)

## Gates

- Arc Studio audit: 6 rounds, final **PASS (0 Critical / 0 High)**;
  Randy re-check closed the last High (calldata now word-pinned)
- Independent verification: Nemotron 3.5 Lightning checklist run
  **PASS** (`spike-evidence/verification/`)
- `bun test scripts/lib/` = 80 pass / 0 fail
- Reproduce: `bun scripts/verify-evidence.mts` -> all claims check out

## Open questions for Peach team (letter in `spike-evidence/randy-letter.md`)

1. Router mismatch: status advertises `0x5FF5...0607`,
   `swapAllowance()` (V2) returns unadvertised `0xfcf781...0663`
   (different ERC1967 impl)
2. `quote_ts` units - API returns ms
3. `deviation_ratio` absent on testnet EURC->USDC
4. cirBTC testnet + findRoutes path-amount quirks
5. Is the `0x02fcde22` calldata layout stable across router upgrades?

## Limitations

- Testnet EURC/USDC price is synthetic and unstable (3.10 -> 1.94);
  cite mainnet ~1.097 only
- Residual USDC from an early pre-journaling swap sits in the signer
  wallet (documented finding)
- Second model-family verifier (Luna) blocked by org quota - open
  residual
