/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arc, arcTestnet } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
// VITE_ARC_RPC_URL / VITE_ARC_TESTNET_RPC_URL override the default chain RPC
// (official rpc.*.arc.io is geo-blocked by Cloudflare in some regions —
// Blockdaemon mirrors work worldwide)
const arcRpc = import.meta.env.VITE_ARC_RPC_URL ?? arc.rpcUrls.default.http[0]
const arcTestnetRpc =
  import.meta.env.VITE_ARC_TESTNET_RPC_URL ??
  arcTestnet.rpcUrls.default.http[0]

registerChain(arcTestnet.id, arcTestnetRpc)
registerChain(arc.id, arcRpc)

// Put the configured target chain first — wagmi uses chains[0] as the
// default chain for wallet connection prompts (e.g. ConnectKit asks the
// wallet to switch to it). Without this, mainnet mode still prompted
// users to switch to Arc Testnet.
const targetIsMainnet = Number(import.meta.env.VITE_CHAIN_ID) === arc.id
const configuredChains = targetIsMainnet
  ? [arc, arcTestnet, mainnet]
  : [arcTestnet, arc, mainnet]

export const config = createConfig({
  chains: configuredChains as [typeof arcTestnet, typeof arc, typeof mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http(arcTestnetRpc),
    [arc.id]: http(arcRpc),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
