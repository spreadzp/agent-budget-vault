import { ApiClient } from "@masterpeach/arc-aggregator-sdk";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainConfig } from "../config.mts";

function sdkVersion(): string {
  const entry = fileURLToPath(import.meta.resolve("@masterpeach/arc-aggregator-sdk"));
  const pkg = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

export const SDK_VERSION = sdkVersion();

/**
 * Narrow typed boundary to Peach (D-254-4). SDK builds quotes; on-chain
 * verification lives in verification.mts and never trusts the SDK alone.
 * Quote/swap surface is implemented in SLICE-254-3/4.
 */
export function apiClientFor(c: ChainConfig): ApiClient {
  return new ApiClient({ baseUrl: c.apiBaseUrl, chainId: c.chainId, timeout: 15_000 });
}
