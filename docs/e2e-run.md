# E2E Dry-Run — Arc Testnet (SLICE-202-4, 2026-10-20)

Chain: Arc Testnet (chainId 5042002), USDC gas + stream asset
(`0x3600000000000000000000000000000000000000`, 6 decimals).
Factory: `0x0f36cdda646bad0e8e65c48b2ee7304dfca84d25`
(deployed in SLICE-202-1; see `deployments/arc-testnet.json`).

## Actors

| Role | Address | Key source |
|------|---------|-----------|
| Owner | `0xB42fCD7Fe2008f39c9c034772C960cD88C5f23b0` | test wallet |
| Agent | `0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d` | deployer wallet |
| Vendor | `0x9a664574282b61d31f5A4f22DE63c8Ad248e95A5` | payout wallet |

Note: factory enforces one vault per agent (`vaultOf`), so the demo
vault uses a different agent than the SLICE-202-3 seed vault
(`0x392650…9634`, agent = owner, cancelled).

## Vault

`0x1eFbDB636211f2Ecc3295c01C77000633E957DEa`
(owner `0xB42f…23b0`, agent `0xcdd2…99d`, agentId 2,
registry/operator = zero)

## Steps (all confirmed onchain, status 0x1 unless noted)

| # | Step | Tx |
|---|------|----|
| 1 | `createVault(owner, agent, 2, 0, 0)` | [0x138958…cebc](https://explorer.testnet.arc.io/tx/0x138958fa0f5ebe73e5c996040c25d0119ff54bba1fdad7bcb66f19efcad2cebc) |
| 2 | USDC `approve(vault, 5.184)` | [0x4db02f…0130](https://explorer.testnet.arc.io/tx/0x4db02fb16719c9f5b2b49bd5aa6b478628aa105c0bb81357454c51976e840130) |
| 3 | `deposit(5.184 USDC)` — rate derived = 2 units/s, ~30d stream | [0x5b44e2…6c35](https://explorer.testnet.arc.io/tx/0x5b44e2e356621f0610c65762e16d6699bcbd4ac33b9ead2390d0e4b355046c35) |
| 4 | `addPayee(vendor)` | [0x23c529…246b](https://explorer.testnet.arc.io/tx/0x23c5295fa196ce3e61e450ad2dad3ce8c7371496345b3867c3ded6151d8d246b) |
| 5 | `pause()` | [0x237da8…942c](https://explorer.testnet.arc.io/tx/0x237da85ccf06e2c7fdeadbae1cb964dc345027464791ddca84a22d6c8ef2942c) |
| 6 | `claim(50, vendor)` by agent **while paused → expected revert** `Error("Paused")` (gas-estimation revert, tx never mined) | sim-only |
| 7 | `unpause()` | [0x8a7c8b…1147](https://explorer.testnet.arc.io/tx/0x8a7c8b0fe920c95ed32e00743e9f00daa5b0de514afef9b6f4be7f751c691147) |
| 8 | `claim(100, vendor)` — reverted, vested < 100 at that moment (rate 2 u/s, ~40 s elapsed ⇒ claim must be ≤ vested) | — |
| 9 | USDC `approve` + `deposit(1.0 USDC, EXTEND)` top-up | [0x85da50…f906](https://explorer.testnet.arc.io/tx/0x85da50012a60d3615b0ce2effd5a2779fcb43a6cdbc537a43aad0dadb602f906) / [0x7bfc2d…ac32](https://explorer.testnet.arc.io/tx/0x7bfc2dc2b84e1e5078e30846b283cdbf2cb0f9e8ef1044548a8dfc890f61ac32) |
| 10 | `cancel()` — owner balance 12.4466 → 18.6281 USDC (**+6.18 unvested refund**; total deposited 6.184, vested ~0.0004) | [0xe99598…735e](https://explorer.testnet.arc.io/tx/0xe9959870bca9afd85bd41345c9bf7b3d6f249c7b9bdda9d05cb467854bdb735e) |
| 11 | `claim(52, vendor)` by agent **post-cancel** → vendor bal 100 → **152** (+52 units); claimable → 0. Confirms vested stays claimable after cancel | [0x3bd0c6…c8c7](https://explorer.testnet.arc.io/tx/0x3bd0c63d8f7e2fb311ef5180cbf068e8950930417c25d5ba963ac42f2ca2c8c7) |

## Verified semantics

- **Pause blocks claims**: `claim` reverts with `Paused` while paused
  (step 6). Confirmed via gas-estimation revert.
- **Claim authority**: only `agent` or `operator` can claim; here agent
  (`0xcdd2…99d`) signed steps 6/8/11.
- **Cancel split**: unvested (~6.18 USDC) refunded to owner atomically;
  vested remainder (52 units) stayed claimable — claimed post-cancel
  in step 11.
- **EXTEND top-up** works on a live stream (step 9).
- **One vault per agent** enforced by factory (`VaultExists` on re-create).
- **getLogs range**: Arc testnet RPC rejects `eth_getLogs` ranges
  >~9 000 blocks (`-32012 requested range too large`); the frontend
  scans in 4 000-block chunks (see `src/lib/scanClaimedLogs.ts`).

## Demo config note

First-deposit stream rate is derived as `amount / 30 days`, so a
short-window demo should either (a) use a small deposit so vested
grows slowly and stays legible on video, or (b) fund the vault ~30–60
min before recording so `vested` is visibly non-trivial. Claim
amounts must be ≤ `claimable()` — step 8 shows the revert otherwise.
