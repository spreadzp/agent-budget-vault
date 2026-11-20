// FSM per D-254-11 + persistence to state/peach-e2e.json (gitignored, 0600).
// state.json is a projection, not the truth — transitions require on-chain
// preconditions enforced by the command modules, never by this file alone.
//
// Audit hardening (254-7): exclusive lockfile (pid + stale detection),
// unique tmp names, CAS version counter, completed intents keep txHash,
// loadState validates shape and fails closed on malformed files.
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, renameSync, unlinkSync, writeFileSync, fdatasyncSync, fsyncSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LINEAR_STAGES = [
  "INIT",
  "PROVISIONED",
  "QUOTED",
  "SWAP_SUBMITTED",
  "SWAP_VERIFIED",
  "APPROVE_SUBMITTED",
  "APPROVED",
  "DEPOSIT_SUBMITTED",
  "DEPOSITED",
] as const;
export const SIDE_STAGES = ["REQUOTE_REQUIRED", "TX_OUTCOME_UNKNOWN", "ABORTED"] as const;
export const STAGES = [...LINEAR_STAGES, ...SIDE_STAGES] as const;
export type Stage = (typeof STAGES)[number];
export type TxStep = "provision" | "eurc_approve" | "swap" | "approve" | "deposit";

export interface TxIntent {
  step: TxStep;
  sender: `0x${string}`;
  nonce: number;
  params: Record<string, unknown>;
  createdAt: string;
  txHash?: `0x${string}`; // set when the intent was actually broadcast/adopted
}
export interface PendingTx {
  intent: TxIntent;
  txHash?: `0x${string}`;
  submittedAt?: string;
}
export interface SpikeState {
  version: number; // CAS counter — saveState refuses to overwrite a newer file
  stage: Stage;
  vault?: `0x${string}`;
  usdcReceived?: string;
  pending: Partial<Record<TxStep, PendingTx>>;
  intents: TxIntent[]; // completed/cleared intents; txHash set if broadcast
  history: { stage: Stage; at: string; note?: string }[];
}

export const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../state");
export const STATE_PATH = resolve(STATE_DIR, "peach-e2e.json");
const LOCK_PATH = resolve(STATE_DIR, "peach-e2e.lock");

export function initialState(): SpikeState {
  return { version: 0, stage: "INIT", pending: {}, intents: [], history: [] };
}

const LINEAR_NEXT: Partial<Record<Stage, Stage>> = Object.fromEntries(
  LINEAR_STAGES.slice(0, -1).map((s, i) => [s, LINEAR_STAGES[i + 1]]),
);
const SUBMITTED = new Set<Stage>(["SWAP_SUBMITTED", "APPROVE_SUBMITTED", "DEPOSIT_SUBMITTED"]);

export function canTransition(from: Stage, to: Stage): boolean {
  if (to === "ABORTED") return from !== "ABORTED" && from !== "DEPOSITED";
  if (from === "ABORTED") return to === "PROVISIONED"; // guarded by caller: no prior swap/deposit txHash
  if (from === "DEPOSITED") return false;
  if (LINEAR_NEXT[from] === to) return true;
  if (SUBMITTED.has(from) && to === "TX_OUTCOME_UNKNOWN") return true;
  if (from === "TX_OUTCOME_UNKNOWN") {
    return SUBMITTED.has(to) || ["SWAP_VERIFIED", "APPROVED", "DEPOSITED"].includes(to);
  }
  if (to === "REQUOTE_REQUIRED") return from === "QUOTED" || from === "SWAP_SUBMITTED" || from === "SWAP_VERIFIED";
  if (from === "REQUOTE_REQUIRED") return to === "QUOTED";
  return false;
}

export function advance(state: SpikeState, to: Stage, note?: string): SpikeState {
  if (!canTransition(state.stage, to)) {
    throw new Error(`illegal FSM transition ${state.stage} -> ${to}`);
  }
  return {
    ...state,
    stage: to,
    history: [...state.history, { stage: to, at: new Date().toISOString(), ...(note ? { note } : {}) }],
  };
}

export function recordIntent(state: SpikeState, intent: TxIntent): SpikeState {
  if (state.pending[intent.step]?.txHash) {
    throw new Error(`replay guard: ${intent.step} already submitted as ${state.pending[intent.step]!.txHash}`);
  }
  if (state.pending[intent.step]) {
    throw new Error(`replay guard: ${intent.step} intent already recorded without txHash`);
  }
  return { ...state, pending: { ...state.pending, [intent.step]: { intent } } };
}

export function markSubmitted(state: SpikeState, step: TxStep, txHash: `0x${string}`): SpikeState {
  const p = state.pending[step];
  if (!p) throw new Error(`no pending intent for ${step}`);
  if (p.txHash) throw new Error(`replay guard: ${step} already has txHash ${p.txHash}`);
  return {
    ...state,
    pending: { ...state.pending, [step]: { ...p, txHash, submittedAt: new Date().toISOString() } },
  };
}

export function clearPending(state: SpikeState, step: TxStep): SpikeState {
  const p = state.pending[step];
  if (!p) return state;
  const pending = { ...state.pending };
  delete pending[step];
  const completed: TxIntent = p.txHash ? { ...p.intent, txHash: p.txHash } : p.intent;
  return { ...state, pending, intents: [...state.intents, completed] };
}

const RANK = new Map(LINEAR_STAGES.map((s, i) => [s, i]));
export function requireStage(state: SpikeState, min: (typeof LINEAR_STAGES)[number]): SpikeState {
  const have = RANK.get(state.stage as (typeof LINEAR_STAGES)[number]);
  if (have === undefined) {
    throw new Error(`state is '${state.stage}' (non-linear) — resolve before requiring ${min}`);
  }
  if (have < RANK.get(min)!) {
    throw new Error(`requires stage ${min}, current ${state.stage}`);
  }
  return state;
}

// ---------- persistence (validated, CAS, fsync, lockfile) ----------

function validateState(raw: unknown): SpikeState {
  if (typeof raw !== "object" || raw === null) throw new Error("state file: not an object");
  const s = raw as Record<string, unknown>;
  if (typeof s.stage !== "string" || !(STAGES as readonly string[]).includes(s.stage)) {
    throw new Error(`state file: bad stage ${String(s.stage)}`);
  }
  if (s.vault !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(String(s.vault))) {
    throw new Error("state file: bad vault address");
  }
  const pending = (s.pending ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(pending)) {
    if (typeof v !== "object" || v === null || typeof (v as PendingTx).intent !== "object") {
      throw new Error(`state file: malformed pending.${k}`);
    }
  }
  if (!Array.isArray(s.intents ?? []) || !Array.isArray(s.history ?? [])) {
    throw new Error("state file: intents/history not arrays");
  }
  return { ...initialState(), ...s, version: Number(s.version ?? 0) } as SpikeState;
}

export function loadState(path = STATE_PATH): SpikeState {
  if (!existsSync(path)) return initialState();
  return validateState(JSON.parse(readFileSync(path, "utf8")));
}

export function saveState(state: SpikeState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const onDisk = existsSync(path) ? Number((JSON.parse(readFileSync(path, "utf8")) as { version?: number }).version ?? 0) : -1;
  if (onDisk >= 0 && state.version !== onDisk) {
    throw new Error(`state CAS conflict: disk version ${onDisk} != in-memory ${state.version}`);
  }
  const next = { ...state, version: state.version + 1 };
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dd = openSync(dirname(path), "r");
    fsyncSync(dd);
    closeSync(dd);
  } catch {
    /* dir fsync unsupported on some FS — non-fatal */
  }
  state.version = next.version;
}

/**
 * Exclusive command lock: creates state/peach-e2e.lock containing our pid.
 * Stale lock (dead pid) is reclaimed; live lock → fail closed. Returns a
 * release function deleting the file iff it still holds our pid.
 */
export function acquireLock(path = LOCK_PATH): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        const pid = Number(readFileSync(path, "utf8").trim());
        if (pid > 0) {
          process.kill(pid, 0);
          stale = false;
        } else stale = true;
      } catch (err) {
        stale = (err as NodeJS.ErrnoException).code === "ESRCH" || (err as NodeJS.ErrnoException).code === "ENOENT";
      }
      if (!stale) {
        throw new Error(`state lock held by live pid ${readFileSync(path, "utf8").trim()} — another peach-e2e is running`);
      }
      unlinkSync(path); // reclaim stale lock, retry once
    }
  }
  throw new Error("state lock could not be acquired");
}
