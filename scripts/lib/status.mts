import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_ABI, publicClientFor, readTokenMeta } from "./chain.mts";
import { EVIDENCE_DIR, type SpikeConfig } from "./config.mts";
import { signerFromEnv } from "./env.mts";
import { apiClientFor, SDK_VERSION } from "./peach/client.mts";

export interface EnvCheck {
  name: string;
  chain: string;
  ok: boolean;
  detail: string;
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}

export async function runStatus(cfg: SpikeConfig): Promise<{ ok: boolean; checks: EnvCheck[] }> {
  const checks: EnvCheck[] = [];
  const push = (name: string, chain: string, ok: boolean, detail: string) =>
    checks.push({ name, chain, ok, detail });

  for (const [key, c] of Object.entries(cfg.chains)) {
    const client = publicClientFor(c);

    try {
      const id = await client.getChainId();
      push("chainId", key, id === c.chainId, `rpc=${c.rpcUrl} chainId=${id} expected=${c.chainId}`);
    } catch (e) {
      push("chainId", key, false, `rpc ${c.rpcUrl} unreachable: ${errMsg(e)}`);
      continue;
    }

    try {
      const [count, token] = await Promise.all([
        client.readContract({ address: c.factory, abi: FACTORY_ABI, functionName: "vaultCount" }),
        client.readContract({ address: c.factory, abi: FACTORY_ABI, functionName: "token" }),
      ]);
      const okTok = token.toLowerCase() === c.vaultDepositToken.toLowerCase();
      push(
        "factory",
        key,
        okTok,
        `factory=${c.factory} vaultCount=${count} token=${token}${okTok ? "" : ` MISMATCH expected=${c.vaultDepositToken}`}`,
      );
    } catch (e) {
      push("factory", key, false, `factory ${c.factory} call failed: ${errMsg(e)}`);
    }

    for (const t of c.tokens) {
      try {
        const meta = await readTokenMeta(client, t.address);
        const ok =
          meta.decimals === t.decimals &&
          meta.symbol.toLowerCase() === t.symbol.toLowerCase();
        push(
          `token ${t.symbol}`,
          key,
          ok,
          `addr=${t.address} onchain symbol=${meta.symbol} decimals=${meta.decimals}` +
            `${ok ? "" : ` expected ${t.symbol}/${t.decimals}`} scope=${t.scope}`,
        );
      } catch (e) {
        push(`token ${t.symbol}`, key, false, `${t.address}: ${errMsg(e)}`);
      }
    }

    try {
      const st = await apiClientFor(c).getStatus();
      const apiRouter = st.arc_router?.execution_router_address ?? "";
      const okRouter = apiRouter.toLowerCase() === c.router.toLowerCase();
      push(
        "sdk getStatus",
        key,
        okRouter,
        `${c.apiBaseUrl} providers=${st.providers?.length ?? "?"} execRouter=${apiRouter}` +
          `${okRouter ? "" : ` MISMATCH config=${c.router}`}`,
      );
    } catch (e) {
      push("sdk getStatus", key, false, `${c.apiBaseUrl}: ${errMsg(e)}`);
    }
  }

  try {
    const s = signerFromEnv("PRIVATE_KEY");
    push("signer", "env", true, `PRIVATE_KEY -> address ${s.address}`);
  } catch (e) {
    push("signer", "env", false, errMsg(e));
  }

  return { ok: checks.every((c) => c.ok), checks };
}

export function writeEvidence(result: { ok: boolean; checks: EnvCheck[] }): {
  metadataPath: string;
  gatePath: string;
} {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const gitCommit = (() => {
    try {
      return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })();
  const bunVersion = (globalThis as { Bun?: { version: string } }).Bun?.version ?? process.version;
  const generatedAt = new Date().toISOString();

  const metadataPath = join(EVIDENCE_DIR, "metadata.json");
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        generatedAt,
        sdk: { name: "@masterpeach/arc-aggregator-sdk", version: SDK_VERSION },
        gitCommit,
        bunVersion,
      },
      null,
      2,
    )}\n`,
  );

  const gatePath = join(EVIDENCE_DIR, "env-gate.json");
  writeFileSync(
    gatePath,
    `${JSON.stringify({ generatedAt, slice: "254-1", ok: result.ok, checks: result.checks }, null, 2)}\n`,
  );
  return { metadataPath, gatePath };
}
