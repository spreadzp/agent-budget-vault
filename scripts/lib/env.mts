import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
  return v;
}

export function signerFromKey(raw: string): { address: Address } {
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  try {
    return { address: privateKeyToAccount(hex).address };
  } catch {
    throw new Error("invalid secp256k1 private key (value not shown)");
  }
}

export function signerFromEnv(envName = "PRIVATE_KEY"): { address: Address } {
  return signerFromKey(requiredEnv(envName));
}
