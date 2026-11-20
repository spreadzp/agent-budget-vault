import type { Account, Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") throw new Error(`missing required env ${name}`);
  return v;
}

export function accountFromKey(raw: string): Account {
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("invalid secp256k1 private key format (value not shown)");
  }
  try {
    return privateKeyToAccount(hex);
  } catch {
    throw new Error("invalid secp256k1 private key (value not shown)");
  }
}

export function accountFromEnv(envName = "PRIVATE_KEY"): Account {
  return accountFromKey(requiredEnv(envName));
}

export function signerFromKey(raw: string): { address: Address } {
  return { address: accountFromKey(raw).address };
}

export function signerFromEnv(envName = "PRIVATE_KEY"): { address: Address } {
  return { address: accountFromEnv(envName).address };
}
