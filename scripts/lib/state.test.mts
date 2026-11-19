import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advance,
  canTransition,
  clearPending,
  initialState,
  loadState,
  markSubmitted,
  recordIntent,
  requireStage,
  saveState,
  STAGES,
} from "./state.mts";

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});
function tmpStatePath(): string {
  const d = mkdtempSync(join(tmpdir(), "peach-state-"));
  tmpDirs.push(d);
  return join(d, "peach-e2e.json");
}

describe("FSM enum (D-254-11)", () => {
  test("all stages present, linear order first", () => {
    const linear = [
      "INIT",
      "PROVISIONED",
      "QUOTED",
      "SWAP_SUBMITTED",
      "SWAP_VERIFIED",
      "APPROVE_SUBMITTED",
      "APPROVED",
      "DEPOSIT_SUBMITTED",
      "DEPOSITED",
    ];
    for (const s of linear) expect(STAGES).toContain(s);
    for (const s of ["REQUOTE_REQUIRED", "TX_OUTCOME_UNKNOWN", "ABORTED"])
      expect(STAGES).toContain(s);
    expect(STAGES[0]).toBe("INIT");
  });

  test("initialState is INIT with no pending", () => {
    const s = initialState();
    expect(s.stage).toBe("INIT");
    expect(Object.keys(s.pending)).toHaveLength(0);
  });
});

describe("transitions", () => {
  test("INIT -> PROVISIONED allowed; INIT -> SWAP_SUBMITTED rejected", () => {
    expect(canTransition("INIT", "PROVISIONED")).toBe(true);
    expect(canTransition("INIT", "SWAP_SUBMITTED")).toBe(false);
  });

  test("advance appends history and moves stage", () => {
    let s = initialState();
    s = advance(s, "PROVISIONED", "vault 0xabc");
    expect(s.stage).toBe("PROVISIONED");
    expect(s.history[s.history.length - 1]?.note).toContain("0xabc");
  });

  test("advance rejects illegal jump", () => {
    const s = initialState();
    expect(() => advance(s, "DEPOSITED")).toThrow(/transition/i);
  });

  test("aborted is reachable from any stage, never re-enters", () => {
    let s = initialState();
    s = advance(s, "ABORTED", "boom");
    expect(() => advance(s, "PROVISIONED")).toThrow();
  });
});

describe("persistence", () => {
  test("save/load roundtrip; file mode 0600", () => {
    const p = tmpStatePath();
    let s = initialState();
    s = advance(s, "PROVISIONED", "test");
    s.vault = "0x00000000000000000000000000000000000000aa";
    saveState(s, p);
    const loaded = loadState(p);
    expect(loaded.stage).toBe("PROVISIONED");
    expect(loaded.vault).toBe("0x00000000000000000000000000000000000000aa");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("loadState on missing file returns INIT", () => {
    expect(loadState(join(tmpdir(), "nope-254.json")).stage).toBe("INIT");
  });
});

describe("pending tx-intents (D-254-12)", () => {
  const intent = {
    step: "provision" as const,
    sender: "0x9264365408D363E7f142828f063077d7ab7C41d9" as `0x${string}`,
    nonce: 7,
    params: { owner: "0x9264", agentId: "254" },
    createdAt: new Date(0).toISOString(),
  };

  test("recordIntent -> markSubmitted -> clearPending lifecycle", () => {
    let s = initialState();
    s = recordIntent(s, intent);
    expect(s.pending.provision?.intent).toEqual(intent);
    expect(s.pending.provision?.txHash).toBeUndefined();
    s = markSubmitted(s, "provision", "0xdead");
    expect(s.pending.provision?.txHash).toBe("0xdead");
    s = clearPending(s, "provision");
    expect(s.pending.provision).toBeUndefined();
    expect(s.intents[s.intents.length - 1]?.nonce).toBe(7);
  });
});

describe("requireStage", () => {
  test("passes at/above required, throws below", () => {
    let s = initialState();
    expect(() => requireStage(s, "PROVISIONED")).toThrow(/PROVISIONED/);
    s = advance(s, "PROVISIONED");
    expect(requireStage(s, "PROVISIONED")).toBe(s);
    expect(() => requireStage(s, "QUOTED")).toThrow(/QUOTED/);
  });
});
