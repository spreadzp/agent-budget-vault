# EPIC-254 — Peach DEX integration spike: evidence pack

**Scope**: prove on Arc Testnet that 5 EURC converts to USDC through the
Peach Arc Aggregator and lands in the correct `BudgetVault`, with an
unreplayable FSM journal — plus a read-only mainnet route sweep.
No `contracts/` or UI `src/` changes; everything lives in `scripts/`,
`config/`, `spike-evidence/`.

**Branch**: `spike/epic-254-peach` · **SDK**: `@masterpeach/arc-aggregator-sdk@1.2.1`
· **Runtime**: bun 1.3.14 + viem

## Result in one line

Testnet EURC→USDC swap + vault deposit executed end-to-end and **twice
recovered live after a post-broadcast kill** with zero resends;
six-round Arc Studio audit ended **0 Critical / 0 High**; independent
Nemotron-family verification **PASS**.

## How to reproduce

```bash
cp .env.example .env   # ARC_TESTNET_PRIVATE_KEY=<testnet key>
bun install
bun scripts/peach-e2e.mts status            # env gate: chain/SDK/tokens/signer
bun scripts/peach-e2e.mts sweep             # mainnet read-only quotes
bun scripts/peach-e2e.mts provision         # idempotent vault create
bun scripts/peach-e2e.mts e2e               # full EURC→USDC→deposit flow
bun scripts/peach-e2e.mts e2e --drill       # crash after swap broadcast
bun scripts/peach-e2e.mts resume            # adopt journaled tx, no resend
bun scripts/verify-evidence.mts             # re-check all txHash claims
bun test scripts/lib/                       # 71 unit tests
```

Journal: `state/peach-e2e.json` (gitignored, 0600). All tx mutating
commands take a process lockfile.

## On-chain proof (Arc Testnet, chainId 5042002)

| Step | Tx | Explorer |
|---|---|---|
| swap 5 EURC→USDC (drill) | `0x4e2669ae26291a4d6bfc37f8f3e7fdaec5440eec7f858180f1398ec5f2339006` | https://explorer.testnet.arc.io/tx/0x4e2669ae26291a4d6bfc37f8f3e7fdaec5440eec7f858180f1398ec5f2339006 |
| vault.deposit | `0xa91b386fc8a2d2736302a90c63bae47fe93089314b4a715f9c2292538dbc7b51` | https://explorer.testnet.arc.io/tx/0xa91b386fc8a2d2736302a90c63bae47fe93089314b4a715f9c2292538dbc7b51 |
| earlier drill swap | `0x758710f6d45427d7c3c9ed89e113bf3670bc76b6ddb2f493ba6eb82c27f36b60` | https://explorer.testnet.arc.io/tx/0x758710f6d45427d7c3c9ed89e113bf3670bc76b6ddb2f493ba6eb82c27f36b60 |
| earlier drill deposit | `0xf29c17ccedc07aa12c4eeaa4398cb721b926b99528568614742519f7a3c76651` | https://explorer.testnet.arc.io/tx/0xf29c17ccedc07aa12c4eeaa4398cb721b926b99528568614742519f7a3c76651 |

Vault (created this spike): `0x1ed696afe807…26ae` — see
`provision.json`. Signer: `0x9264365408D363E7f142828f063077d7ab7C41d9`
(key in `.env`, never committed).

## Evidence index

- `sweep/eurc.json` — mainnet read-only: EURC 5/25/100/500 ×3 runs,
  price ≈ **1.0970** (flat, −0.0003% deviation), median latency 799 ms.
- `sweep/cirbtc.json` — cirBTC probe ~0.0000812→0.001624 BTC,
  implies ~$61.6k/BTC, latency 714 ms.
- `e2e/transcript.json`, `e2e/resume-transcript.json` — live drill:
  crash after broadcast → same txHash adopted, 0 resends.
- `negative/` — insufficient-eurc, wrong-chain, expired-quote artifacts.
- `provision.json`, `env-gate.json`, `metadata.json`.
- `verification/SLICE-254-8.md` + `SLICE-254-8-hermes-nemotron.md`.
- `decision.md` — GO/NO-GO rationale.
- Audit history: `docs/EPICS/254-peach-dex-integration/reviews/REVIEW-FINDINGS.md`.

## Known limitations (all documented for Randy)

- Peach router mismatch: status advertises `0x5FF5…0607`, `swapAllowance()`
  (V2) returns unadvertised `0xfcf7…0663` — pre-sign checklist aborts on it;
  e2e passed via V1 `swap()` (advertised router).
- Arc USDC is the gas token — gas is charged on `0x3600…` with no Transfer
  event; verifier subtracts `gasUsed×effectiveGasPrice`.
- Testnet EURC/USDC price is synthetic (~3.1–3.6 vs mainnet 1.097).
- `quote_ts` is milliseconds (not seconds as docs imply) — normalization
  applied; without it stale quotes pass freshness checks.
- `deviation_ratio` absent from testnet EURC→USDC quotes — treated as
  "not reported", other drift bounds still enforced.
- ~18 USDC residue from an early aborted swap sits in the signer wallet.
- Second model-family verifier run (Luna) blocked by org quota — open.
