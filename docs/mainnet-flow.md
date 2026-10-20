# Arc Mainnet E2E — SLICE-202-5

Real-USDC vault lifecycle on Arc mainnet (chainId 5042), executed 2026-10-20.

## Addresses

- **Chain**: Arc mainnet `5042` — RPC `https://rpc.mainnet.arc.io` (official is Cloudflare-geo-blocked for some IPs; Blockdaemon mirror `https://rpc.blockdaemon.mainnet.arc.io` used for this run)
- **Explorer**: `https://explorer.arc.io`
- **USDC**: `0x3600000000000000000000000000000000000000` (native gas asset, ERC-20 precompile, 6 decimals)
- **Factory**: `0x5D1a014e1FFE3b777F0946C2dd75A7d3aecdacA4`
- **Vault**: `0x2860258CAf3e21c65517233aBa1e876D16D4Ff52`
- **Owner**: `0xB42fCD7Fe2008f39c9c034772C960cD88C5f23b0` (dedicated demo owner key)
- **Agent**: `0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d` (deployer, `agentId=2`)
- **Payee (vendor)**: `0x9a664574282b61d31f5A4f22DE63c8Ad248e95A5` (project-controlled marketplace payout)

## Funding source

Sweep of 47 project keys × 7 chains + 39 deployed contracts found usable balances only on Arc mainnet. Consolidated onto the owner wallet (3 txs, all mined):

- `ARC_OPS_KEY` → owner 0.53 USDC — [`0x160b404d36e94c1a472c69f4945705264b79256b70623aa8a55ef8d2be50cd82`](https://explorer.arc.io/tx/0x160b404d36e94c1a472c69f4945705264b79256b70623aa8a55ef8d2be50cd82)
- `VENUE_PROVIDER_KEY` → owner 0.36 USDC — [`0xb1b174700347e56b1850e2af06275491a536e2716a9fe845811817b3112188f2`](https://explorer.arc.io/tx/0xb1b174700347e56b1850e2af06275491a536e2716a9fe845811817b3112188f2)
- `ARC_EVALUATOR_KEY` → owner 0.30 USDC — [`0xdd9a873026f749d070b30cdb9369e5f14efb62d119845f573fbe73437ea945a2`](https://explorer.arc.io/tx/0xdd9a873026f749d070b30cdb9369e5f14efb62d119845f573fbe73437ea945a2)

Plus a manual user top-up → owner reached 6.224 USDC before the run.

## Deployment txs

- Factory deploy — [`0x50e3f37b4b552e53ad91edb5f925fd5dfdae5d8c9a9514eb2bfebb316226b463`](https://explorer.arc.io/tx/0x50e3f37b4b552e53ad91edb5f925fd5dfdae5d8c9a9514eb2bfebb316226b463)
- Vault creation — [`0x8fb2a823dffe20a86d6fc779e5f6790f91784c4b0adb973c73437a050f38d6bf`](https://explorer.arc.io/tx/0x8fb2a823dffe20a86d6fc779e5f6790f91784c4b0adb973c73437a050f38d6bf)

## Lifecycle txs (owner unless noted)

1. **approve(3 USDC)** — [`0xfb313a05825556aa0b4773a47fb1f2cc1587a20edb835e65d7f1909156e0b1aa`](https://explorer.arc.io/tx/0xfb313a05825556aa0b4773a47fb1f2cc1587a20edb835e65d7f1909156e0b1aa)
2. **deposit(3 USDC, EXTEND)** — [`0xaf0b2dd109690824f7d573df2563eb83b49fe2cb901952fccd4c1e98119d5a56`](https://explorer.arc.io/tx/0xaf0b2dd109690824f7d573df2563eb83b49fe2cb901952fccd4c1e98119d5a56). First deposit sets `rate = 3_000_000 / 30d = 1` unit/sec; contract requires ≥ 2.592 USDC.
3. **addPayee(vendor)** — [`0x92a234f6c6ad1152bf64911a5aa0a312eacf8beb49c89189a85c6b7833073787`](https://explorer.arc.io/tx/0x92a234f6c6ad1152bf64911a5aa0a312eacf8beb49c89189a85c6b7833073787)
4. **setPerTxCap(1 USDC)** — [`0xc927d0ac15518b31a05855ab2a8de7100123b90f562bb9bf0e760990f1194a54`](https://explorer.arc.io/tx/0xc927d0ac15518b31a05855ab2a8de7100123b90f562bb9bf0e760990f1194a54)
5. **claim(55 units → vendor)** by agent — [`0xab1286328863f5ec4dbb9b040587114fc3966b40506dfc2feb5a85a375d9013d`](https://explorer.arc.io/tx/0xab1286328863f5ec4dbb9b040587114fc3966b40506dfc2feb5a85a375d9013d)

## Result

- Payee USDC (`balanceOf`): **99,020 → 99,075** (+55 units) ✅
- Stream active: `rate=1`, `paused=false`, `perTxCap=1_000_000`, vendor allowlisted.
- Frontend mainnet mode (`VITE_CHAIN_ID=5042`, `.env.mainnet`) verified: Vendor view shows 1 vault in registry.

## Safety checklist (per SLICE-202-5)

- Minimal funding: 3 USDC deposited (within $1–5 AC band, above 2.592 contract minimum).
- Dedicated demo owner wallet: `0xB42f…23b0` (PRIV_KEY in `hackathon/server/.env.deployer`, verified via sign+recover).
- Payee is project-controlled (`MARKETPLACE_PAYOUT` vendor).
- Per-tx cap 1 USDC < deposited 3 USDC.
- Exit plan: `cancel()` returns unvested funds to owner; vested remainder stays claimable.
