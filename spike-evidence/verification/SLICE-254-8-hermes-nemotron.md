# SLICE-254-8 — Independent verification: Hermes agent (Nemotron 3.5 Lightning)

**Date**: 2026-11-20 ~13:45 EET
**Runner**: Hermes CLI agent (systemd `hermes-gateway.service`), one-shot `hermes -z`
**Model**: `nvidia/nemotron-3.5-lightning:free` via OpenRouter
**Model family**: NVIDIA Nemotron — third family after SWE-2 (implementation)
and Arc Studio auditor (six audit rounds).
**Prompt**: `/tmp/hermes-verify-prompt.txt` — same checklist as SLICE-254-8
(read-only repo, no .env, no signing commands, RPC receipt checks,
money-rule source audit).
**Constraints enforced**: repo read-only, no provision/e2e/resume/abandon,
private keys never requested — only field names inspected.

## Verdict: PASS

## Item results (from runner report)

1. **git state** — branch `spike/epic-254-peach`, slice commits
   `e51ac73…454782d` present; only `out/` untracked (debug artifact).
2. **`bun test scripts/lib/`** — 71 pass, 0 fail, 161 expect() calls, 8 files.
3. **`bun scripts/peach-e2e.mts status`** — env gate OK (chainId 5042002 /
   5042, token addresses verified, signer present).
4. **`bun scripts/verify-evidence.mts`** — `VERIFY: all claims check out`;
   all 4 receipts (hardened + earlier drill swap/deposit) success,
   from=signer, blocks 73167891/73167910/73170323/73170342.
5. **Journal `state/peach-e2e.json`** — stage `DEPOSITED`, `pending: {}`,
   no private-key fields (names inspected only).
6. **Direct RPC receipts** — both claimed txHashes return status `0x1`,
   from `0x9264…41d9`, correct targets (router `0x5ff5…`, vault `0x1ed6…`).
7. **Evidence secret scan** — only hit is a descriptive label
   `PRIVATE_KEY -> address 0x9264…` in `env-gate.json` (metadata label,
   not key material); remaining 64-hex strings are requestId/pool fields.
8. **Money-rule source audit** (state.mts, tx.mts, resume.mts, safety.mts):
   - (a) Signed tx journaled atomically BEFORE broadcast — confirmed
     (`submitGuarded` single saveState: intent+hash+raw+stage).
   - (b) RPC errors treated as tx death — **refused**: transport errors
     throw `unknown`, only named not-found errors count as absence.
   - (c) Clearing pending without chain proof — **refused**: unproven
     outcome blocks, never clears.
   - (d) Timestamps fail-closed — confirmed (NaN/future rejected,
     malformed createdAt cannot smuggle a live intent).
9. **Verifier-noted observations**:
   - Duplicate intents in journal (nonces 0-4 repeated) — consequence of
     aborted/retried runs, documented; not a code bug.
   - `env-gate.json` `PRIVATE_KEY -> address` label — descriptive only,
     flagged as sloppy-but-harmless for the review pack.

## Deviations from plan

- Planned Luna + Nemotron subagent runs were blocked by Devin weekly
  org quota (see SLICE-254-8.md). Hermes+OpenRouter provided the
  Nemotron-family run instead; DeepSeek key in Hermes is expired (401),
  Z.AI overloaded (429), Gemini path has a streaming bug — nemotron-3.5
  was the reachable different family.
- Single independent run rather than 2–3; convergent evidence: 6-round
  Arc Studio audit + Hermes verification + reproducible script.

## Convergent findings

No contradictions between implementation claims, on-chain state, and
independent verification. Residual risks are the ones already documented
in REVIEW-FINDINGS.md (all fail-closed).
