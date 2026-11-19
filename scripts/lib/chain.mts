import {
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import type { ChainConfig } from "./config.mts";

export const ERC20_META_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export const FACTORY_ABI = parseAbi([
  "function vaultCount() view returns (uint256)",
  "function token() view returns (address)",
]);

export function chainOf(c: ChainConfig) {
  return defineChain({
    id: c.chainId,
    name: c.name,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [c.rpcUrl] } },
  });
}

export function publicClientFor(c: ChainConfig): PublicClient {
  return createPublicClient({ chain: chainOf(c), transport: http(c.rpcUrl, { timeout: 15_000 }) });
}

export async function readTokenMeta(
  client: PublicClient,
  address: Address,
): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: ERC20_META_ABI, functionName: "symbol" }),
    client.readContract({ address, abi: ERC20_META_ABI, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}
