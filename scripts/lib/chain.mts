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
  "function vaultOf(address agent) view returns (address)",
  "function createVault(address owner, address agent, uint256 agentId, address registry, address operator) returns (address)",
]);

export const VAULT_POLICY_ABI = parseAbi([
  "function policy() view returns ((address owner,address agent,address operator,uint256 agentId,address registry,address token,uint256 rate,uint256 startTime,uint256 endTime,uint256 perTxCap,bool paused,bool cancelled,uint256 vested,uint256 claimed,uint256 claimable,address[] payees))",
]);

export interface VaultPolicy {
  owner: `0x${string}`;
  agent: `0x${string}`;
  operator: `0x${string}`;
  agentId: bigint;
  registry: `0x${string}`;
  token: `0x${string}`;
  rate: bigint;
  startTime: bigint;
  endTime: bigint;
  perTxCap: bigint;
  paused: boolean;
  cancelled: boolean;
  vested: bigint;
  claimed: bigint;
  claimable: bigint;
  payees: `0x${string}`[];
}

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
