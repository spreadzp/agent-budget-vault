// FSM per D-254-11 + persistence to state/peach-e2e.json (gitignored, 0600).
// state.json is a projection, not the truth — transitions require on-chain
// preconditions enforced by the command modules, never by this file alone.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
}
export interface PendingTx {
  intent: TxIntent;
  txHash?: `0x${string}`;
  submittedAt?: string;
}
export interface SpikeState {
  stage: Stage;
  vault?: `0x${string}`;
  usdcReceived?: string; // verified post-swap USDC amount for deposit (resume aid)
  pending: Partial<Record<TxStep, PendingTx>>;
  intents: TxIntent[];
  history: { stage: Stage; at: string; note?: string }[];
}

export const STATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../state");
export const STATE_PATH = resolve(STATE_DIR, "peach-e2e.json");

export function initialState(): SpikeState {
  return { stage: "INIT", pending: {}, intents: [], history: [] };
}

const LINEAR_NEXT: Partial<Record<Stage, Stage>> = Object.fromEntries(
  LINEAR_STAGES.slice(0, -1).map((s, i) => [s, LINEAR_STAGES[i + 1]]),
);
const SUBMITTED = new Set<Stage>(["SWAP_SUBMITTED", "APPROVE_SUBMITTED", "DEPOSIT_SUBMITTED"]);

export function canTransition(from: Stage, to: Stage): boolean {
  if (to === "ABORTED") return from !== "ABORTED" && from !== "DEPOSITED";
  if (from === "ABORTED") return to === "PROVISIONED"; // retry: vault is still provisioned
  if (from === "DEPOSITED") return false;
  if (LINEAR_NEXT[from] === to) return true;
  if (SUBMITTED.has(from) && to === "TX_OUTCOME_UNKNOWN") return true;
  if (from === "TX_OUTCOME_UNKNOWN") {
    // reconcile: back to a SUBMITTED marker, on to its completion, or abort
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
  return { ...state, pending, intents: [...state.intents, p.intent] };
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

export function loadState(path = STATE_PATH): SpikeState {
  if (!existsSync(path)) return initialState();
  const raw = JSON.parse(readFileSync(path, "utf8")) as SpikeState;
  return { ...initialState(), ...raw, pending: raw.pending ?? {}, intents: raw.intents ?? [], history: raw.history ?? [] };
}

export function saveState(state: SpikeState, path = STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
