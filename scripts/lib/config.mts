import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TokenScope = "e2e" | "probe";
export interface TokenConfig {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  scope: TokenScope;
}
export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  factory: `0x${string}`;
  router: `0x${string}`;
  vaultDepositToken: `0x${string}`;
  apiBaseUrl: string;
  tokens: TokenConfig[];
}
export interface SpikeConfig {
  chains: Record<"testnet" | "mainnet", ChainConfig>;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CONFIG_PATH = resolve(REPO_ROOT, "config/peach-spike.json");
export const EVIDENCE_DIR = resolve(REPO_ROOT, "spike-evidence");

const ADDR = /^0x[0-9a-fA-F]{40}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function needAddr(v: unknown, label: string): `0x${string}` {
  if (typeof v !== "string" || !ADDR.test(v)) {
    throw new Error(`config: ${label} must be a 0x-prefixed 20-byte address`);
  }
  return v as `0x${string}`;
}

function needStr(v: unknown, label: string): string {
  if (typeof v !== "string" || v === "") throw new Error(`config: ${label} must be a non-empty string`);
  return v;
}

function needInt(v: unknown, label: string): number {
  if (!Number.isInteger(v)) throw new Error(`config: ${label} must be an integer`);
  return v as number;
}

function validateChain(raw: unknown, label: string): ChainConfig {
  if (!isObj(raw)) throw new Error(`config: chains.${label} must be an object`);
  const tokens = raw.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error(`config: chains.${label}.tokens must be a non-empty array`);
  }
  const out: ChainConfig = {
    chainId: needInt(raw.chainId, `${label}.chainId`),
    name: needStr(raw.name, `${label}.name`),
    rpcUrl: needStr(raw.rpcUrl, `${label}.rpcUrl`),
    explorerUrl: needStr(raw.explorerUrl, `${label}.explorerUrl`),
    factory: needAddr(raw.factory, `${label}.factory`),
    router: needAddr(raw.router, `${label}.router`),
    vaultDepositToken: needAddr(raw.vaultDepositToken, `${label}.vaultDepositToken`),
    apiBaseUrl: needStr(raw.apiBaseUrl, `${label}.apiBaseUrl`),
    tokens: tokens.map((t, i) => {
      if (!isObj(t)) throw new Error(`config: ${label}.tokens[${i}] must be an object`);
      const scope = t.scope;
      if (scope !== "e2e" && scope !== "probe") {
        throw new Error(`config: ${label}.tokens[${i}].scope must be "e2e"|"probe"`);
      }
      return {
        symbol: needStr(t.symbol, `${label}.tokens[${i}].symbol`),
        address: needAddr(t.address, `${label}.tokens[${i}].address`),
        decimals: needInt(t.decimals, `${label}.tokens[${i}].decimals`),
        scope,
      };
    }),
  };
  return out;
}

export function validateSpikeConfig(raw: unknown): SpikeConfig {
  if (!isObj(raw) || !isObj(raw.chains)) throw new Error("config: missing chains object");
  for (const label of ["testnet", "mainnet"] as const) {
    if (!(label in raw.chains)) throw new Error(`config: missing chains.${label}`);
  }
  return {
    chains: {
      testnet: validateChain(raw.chains.testnet, "testnet"),
      mainnet: validateChain(raw.chains.mainnet, "mainnet"),
    },
  };
}

export function loadSpikeConfig(path = CONFIG_PATH): SpikeConfig {
  return validateSpikeConfig(JSON.parse(readFileSync(path, "utf8")));
}
