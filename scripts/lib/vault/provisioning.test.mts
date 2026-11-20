import { describe, expect, test } from "bun:test";
import {
  buildProvisionParams,
  evaluateVaultPolicy,
} from "./provisioning.mts";

const SIGNER = "0x9264365408D363E7f142828f063077d7ab7C41d9" as `0x${string}`;
const USDC = "0x3600000000000000000000000000000000000000" as `0x${string}`;

function policy(over: Partial<Parameters<typeof evaluateVaultPolicy>[0]> = {}) {
  return {
    owner: SIGNER,
    agent: SIGNER,
    operator: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    agentId: 254n,
    registry: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    token: USDC,
    rate: 0n,
    startTime: 0n,
    endTime: 0n,
    perTxCap: 0n,
    paused: false,
    cancelled: false,
    vested: 0n,
    claimed: 0n,
    claimable: 0n,
    payees: [],
    ...over,
  };
}

describe("buildProvisionParams", () => {
  test("owner=agent=signer, registry/operator zero, agentId marker", () => {
    const p = buildProvisionParams(SIGNER);
    expect(p.owner).toBe(SIGNER);
    expect(p.agent).toBe(SIGNER);
    expect(p.registry).toBe("0x0000000000000000000000000000000000000000");
    expect(p.operator).toBe("0x0000000000000000000000000000000000000000");
    expect(p.agentId).toBe(254n);
  });
});

describe("evaluateVaultPolicy", () => {
  test("ok when owner/token/cancelled all good", () => {
    const r = evaluateVaultPolicy(policy(), { owner: SIGNER, token: USDC });
    expect(r.ok).toBe(true);
    expect(r.failures).toHaveLength(0);
  });

  test("owner mismatch fails", () => {
    const r = evaluateVaultPolicy(policy(), {
      owner: "0x00000000000000000000000000000000000000bb",
      token: USDC,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/owner/);
  });

  test("token mismatch fails", () => {
    const r = evaluateVaultPolicy(policy(), {
      owner: SIGNER,
      token: "0x00000000000000000000000000000000000000cc",
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/token/);
  });

  test("non-empty payees fails", () => {
    const r = evaluateVaultPolicy(
      policy({ payees: ["0x00000000000000000000000000000000000000aa" as `0x${string}`] }),
      { owner: SIGNER, token: USDC },
    );
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/payees/);
  });

  test("non-zero perTxCap fails", () => {
    const r = evaluateVaultPolicy(policy({ perTxCap: 1000n }), { owner: SIGNER, token: USDC });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/perTxCap/);
  });

  test("cancelled vault fails", () => {
    const r = evaluateVaultPolicy(policy({ cancelled: true }), {
      owner: SIGNER,
      token: USDC,
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/cancelled/i);
  });
});
