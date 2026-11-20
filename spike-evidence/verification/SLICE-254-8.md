# SLICE-254-8 — Independent verification report

**Update 2026-11-20 ~13:45 EET — deviation CLOSED**: a genuine
model-family verifier run did happen after the subagent quota failure —
Hermes agent + `nvidia/nemotron-3.5-lightning:free` via OpenRouter
executed this same checklist read-only and returned **PASS**. Full
report: `SLICE-254-8-hermes-nemotron.md`. Residual note: a second
family (Luna) never ran — single independent run + 6-round audit.

**Original deviation note**: the slice calls for 2–3 verifier runs on
different model families via background subagents (Cloud Devin was
already unavailable on org quota). Both subagent launches —
`mmf-verifier-luna` (GPT-6 Luna High) and `mmf-verifier-nemotron`
(Nemotron 3.5 Lightning High) — failed with "weekly usage quota
exhausted" on 2026-11-20.

**Independent verification achieved**:
1. Six-round Arc Studio audit (`epic254-audit-confirm*`) — an external
   model ran the real code against a 76-case stubbed-chain harness and
   issued **PASS** (0 Critical / 0 High) at round 6.
2. Hermes + Nemotron 3.5 Lightning — independent checklist re-run,
   PASS (`SLICE-254-8-hermes-nemotron.md`).
3. This self-verification checklist — re-run claims, not trusted output.

## Self-verification results (2026-11-20)

| # | Claim | Result |
|---|---|---|
| 1 | `bun test scripts/lib/` = 71 pass / 0 fail | **CONFIRMED** (161 expect) |
| 2 | `peach-e2e status` env gate OK testnet+mainnet | **CONFIRMED** (all checks OK) |
| 3 | On-chain receipts (via `scripts/verify-evidence.mts`) | **CONFIRMED** |
|   | swap `0x4e2669…39006` | success, from `0x9264…41d9`, block 73170323, to router `0x5ff5…0607` |
|   | deposit `0xa91b38…c7b51` | success, from `0x9264…41d9`, block 73170342, to vault `0x1ed6…26ae` |
|   | earlier drill swap `0x7587…6b60` | success, block 73167891, to router |
|   | earlier drill deposit `0xf29c…6651` | success, block 73167910, to vault |
| 4 | Journal `state/peach-e2e.json` | **CONFIRMED**: stage=DEPOSITED, `pending` empty, all intents carry txHash; `params.raw` = `0x02f8…` signed-tx bytes (368–5110 chars — tx envelopes, not key material) |
| 5 | `spike-evidence/` secret scan | **CONFIRMED clean**: no fields named key/secret/priv holding values; "raw" in sweep artifacts = API request payload only; transcripts carry no raw params; 64-hex values only in txHash/requestId fields |

## Money-rule spot audit (self, skeptical pass over tx/resume/e2e/state)

- `submitGuarded` journaled hash+raw+stage BEFORE broadcast — verified in
  code and by the live drill transcript.
- `never-sent` only via `consumingBlock` block-body proof (archive nonce
  crossing + tx in body); every transport error → `unknown`/`in-flight` →
  throw, never clear.
- `abandon` requires named-not-found probes ×2 ≥1 block + latest==pending
  ==intent nonce; `reuseNonce` pin prevents double-landing by construction.
- `liveMoneyIntentReason` re-probes dead flags via block-body — no
  stale-flag trust.
- No hole found in this pass; the six-round audit reached the same
  conclusion after progressively harder attacks.

## Honest statement of residual risk

One model-family verifier run completed (Nemotron 3.5 Lightning via
Hermes/OpenRouter) and confirmed every checklist item including a
skeptical source-level money-rule audit — see
`SLICE-254-8-hermes-nemotron.md`. The Luna-family run remains **open**
(org quota); the Arc Studio auditor is independent of the author but is
the same class of reviewer that produced the fixes it verified, so a
second fresh-family pass is still flagged for Randy review in 254-6.
The on-chain and test evidence above is independently reproducible
(`bun scripts/verify-evidence.mts`, `bun test scripts/lib/`).
