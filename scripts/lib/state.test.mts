import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
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
    for (const s of linear) expect(STAGES as readonly string[]).toContain(s);
    for (const s of ["REQUOTE_REQUIRED", "TX_OUTCOME_UNKNOWN", "ABORTED"])
      expect(STAGES as readonly string[]).toContain(s);
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

  test("aborted reachable from any stage; retry allowed only to PROVISIONED", () => {
    let s = initialState();
    s = advance(s, "ABORTED", "boom");
    s = advance(s, "PROVISIONED", "retry after abort");
    expect(s.stage).toBe("PROVISIONED");
    s = advance(s, "ABORTED", "boom2");
    expect(() => advance(s, "DEPOSITED")).toThrow();
    expect(() => advance(s, "INIT")).toThrow();
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

  // audit M4: malformed files fail closed instead of silently resetting
  test("loadState rejects malformed stage", () => {
    const p = tmpStatePath();
    writeFileSync(p, JSON.stringify({ stage: "BOGUS" }));
    expect(() => loadState(p)).toThrow(/bad stage/);
  });

  test("loadState rejects malformed pending entry", () => {
    const p = tmpStatePath();
    writeFileSync(p, JSON.stringify({ stage: "DEPOSITED", pending: { swap: 5 } }));
    expect(() => loadState(p)).toThrow(/malformed pending/);
  });

  // audit C2: CAS version counter — a stale in-memory copy can't overwrite
  test("saveState CAS conflict on out-of-sync writer", () => {
    const p = tmpStatePath();
    const a = initialState();
    saveState(a, p); // a.version -> 1
    const b = loadState(p); // b.version == 1
    saveState(b, p); // b.version -> 2
    expect(() => saveState(a, p)).toThrow(/CAS conflict/);
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
    // audit H1/H2: the journal keeps the broadcast hash for the ABORTED guard
    expect(s.intents[s.intents.length - 1]?.txHash).toBe("0xdead");
  });
});

describe("acquireLock (audit C2)", () => {
  function lockPath(): string {
    const d = mkdtempSync(join(tmpdir(), "peach-lock-"));
    tmpDirs.push(d);
    return join(d, "peach-e2e.lock");
  }

  test("second acquire fails while held; release frees", () => {
    const p = lockPath();
    const rel = acquireLock(p);
    expect(() => acquireLock(p)).toThrow(/lock held/);
    rel();
    const rel2 = acquireLock(p);
    rel2();
  });

  // audit N-M1: a freshly-created lock file is treated as HELD even with a
  // dead/empty pid — the creator's pid write may still be in flight.
  test("fresh lock file (dead pid, <2s) is treated as held", () => {
    const p = lockPath();
    writeFileSync(p, "999999999\n");
    expect(() => acquireLock(p)).toThrow(/lock held/);
  });

  test("stale lock (dead pid, aged >2s) is reclaimed", () => {
    const p = lockPath();
    writeFileSync(p, "999999999\n"); // implausible live pid
    const old = new Date(Date.now() - 10_000);
    utimesSync(p, old, old); // age past the freshness window (N-M1)
    const rel = acquireLock(p);
    rel();
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
