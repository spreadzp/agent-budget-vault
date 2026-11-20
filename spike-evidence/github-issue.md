**Title:** EPIC-254 findings: Peach router V1/V2 mismatch, quote_ts units, deviation_ratio absent, calldata layout question

During the EPIC-254 spike (EURC->USDC->BudgetVault on Arc Testnet,
branch `spike/epic-254-peach`, decision CONDITIONAL GO) we hit several
Peach/Arc-side oddities. Opening this so they don't live only in a chat.

## Findings

1. **Router mismatch V1 vs V2.** `getStatus()` advertises
   `execution_router_address = 0x5FF56925140D6f5912C8Ca6593f2C3BC28190607`
   while `swapAllowance()` (V2) returns
   `contracts.execution_router = 0xfcf781866ae8933ade0b4bd056bb02525fd90663`
   - not listed in status. Both are ERC1967 proxies with DIFFERENT
   implementations (`0x42de8fdf...0060` vs `0xe7c034f6...eac5`), no admin
   slot. Is `0xfcf781...` legitimate, and why isn't it advertised?

2. **quote_ts units.** API returns `quoteTs` in milliseconds
   (1795124478146); anything reading it as seconds treats stale quotes
   as fresh forever. Please pin the unit in docs/types.

3. **deviation_ratio absent.** Not returned at all on testnet
   EURC->USDC quotes. Expected, or API gap?

4. **USDC-as-gas on Arc.** Gas charged on `0x3600...` (6 dec) + a second
   Transfer event on `0xffff...fffe` (18 dec). Breaks naive
   provenance verification; worth a docs note.

5. **Calldata layout stability.** We pin selector `0x02fcde22`
   (76 words: w2 chainId, w3 router, w4-6 signer, w7-8 tokenIn/Out,
   w11 amountIn, w12 amountOutMin, w13 expectOut, w19 deadline,
   w26-29 path echo) and fail closed on any change. Is the layout
   stable across router upgrades?

6. **findRoutes quirk.** Path amounts sometimes don't sum to top-level
   `amount_in`/`amount_out`. Expected?

## Evidence

- Full pack: `spike-evidence/` on `spike/epic-254-peach`
  (README index, decision.md, sweep JSON, transcripts, verification)
- Live testnet txs: swap `0x4e2669ae26291a4d6bfc37f8f3e7fdaec5440eec7f858180f1398ec5f2339006`,
  deposit `0xa91b386fc8a2d2736302a90c63bae47fe93089314b4a715f9c2292538dbc7b51`
  (+2 more pairs)
- Letter with questions: `spike-evidence/randy-letter.md`
