/**
 * swap-rescue.mts — gas bootstrap: LiFi GasZip USDC(Arc) -> native ETH(Base),
 * then CCTP the stuck 5 USDC Base -> Arc.
 *
 * Modes:
 *   quote        — read-only LiFi quotes for 0.5/1/2 USDC
 *   gaszip <amt> — MAINNET GasZip refuel (needs --yes; amt in USDC, e.g. 0.5)
 *   testnet-cctp — Base Sepolia -> Arc Testnet CCTP dry-run (needs --yes)
 *   cctp         — MAINNET CCTP 5 USDC Base -> Arc (needs --yes)
 *
 * Run from agent-budget-vault (has @circle-fin/* + viem):
 *   bun --env-file ../contracts/.env --env-file ../hackathon/server/.env scripts/swap-rescue.mts quote
 */
import {
  createPublicClient, createWalletClient, http, parseAbi, pad,
  parseUnits, defineChain, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";

const mode = process.argv[2] ?? "quote";
const yes = process.argv.includes("--yes");

const BURNER = "0x3bF7bf14c839AC615F87cDeDe344dF01B9cFb89f" as const;
const OPERATOR = "0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d" as const;
const ARC_MAINNET = defineChain({
  id: 5042, name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.drpc.mainnet.arc.io"] } },
});
const ARC_TESTNET = defineChain({
  id: 5042002, name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
});

const USDC_ARC = "0x3600000000000000000000000000000000000000" as Address;
const NATIVE_PLACEHOLDER = "0x0000000000000000000000000000000000000000" as Address;

const CCTP_MAIN = {
  tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address,
  messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Address,
  usdcSource: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address, // Base
  arcDomain: 26,
};
const CCTP_TEST = {
  // Base Sepolia V2 testnet (Circle canonical, same on all EVM testnets)
  tokenMessengerSrc: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Address,
  messageTransmitterDst: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" as Address, // Arc testnet
  usdcSource: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address, // USDC on Base Sepolia
  arcDomain: 26,
};

function key(env: string): `0x${string}` {
  const k = process.env[env];
  if (!k) throw new Error(`missing env ${env}`);
  return (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`;
}
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...a);

// --- evidence log: append JSONL events to docs/SWAP/logs/events.jsonl ---
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const RUN_ID = process.env.RESCUE_RUN_ID ?? `run-${Date.now()}`;
const T0 = Date.now();
const LOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/SWAP/logs");
mkdirSync(LOG_DIR, { recursive: true });
function ev(event: string, data: Record<string, unknown> = {}) {
  const rec = { run: RUN_ID, t: new Date().toISOString(), elapsed_s: +((Date.now() - T0) / 1000).toFixed(1), event, ...data };
  appendFileSync(`${LOG_DIR}/events.jsonl`, JSON.stringify(rec) + "\n");
  log(`·ev ${event}`, JSON.stringify(data));
}

async function lifiQuote(amountUsdc: string) {
  const fromAmount = parseUnits(amountUsdc, 6).toString();
  const url = `https://li.quest/v1/quote?fromChain=5042&toChain=8453&fromToken=${USDC_ARC}&toToken=${NATIVE_PLACEHOLDER}&fromAmount=${fromAmount}&fromAddress=${OPERATOR}&toAddress=${BURNER}`;
  ev("lifi_quote_request", { amountUsdc });
  const r = await fetch(url);
  if (!r.ok) throw new Error(`lifi ${r.status}: ${await r.text()}`);
  return r.json() as Promise<{
    tool: string;
    estimate: { toAmount: string; toAmountMin: string; executionDuration: number };
    transactionRequest: { to: Address; data: Hex; value: string; gasLimit?: string; gasPrice?: string };
  }>;
}

async function quote() {
  for (const amt of ["0.5", "1", "2"]) {
    const q = await lifiQuote(amt);
    log(`${amt} USDC -> ${Number(q.estimate.toAmount) / 1e18} ETH (min ${Number(q.estimate.toAmountMin) / 1e18}) tool=${q.tool} duration=${q.estimate.executionDuration}s`);
  }
}


async function relayQuote(amountUsdc: string): Promise<{
  steps: { id: string; items: { data: { to: Address; data: Hex; value?: string; chainId: number; gas?: string } }[] }[];
  details: { currencyOut: { amount: string; minimumAmount: string } };
}> {
  const amount = BigInt(Math.round(parseFloat(amountUsdc) * 1e6)); // ERC-20 USDC 6 decimals on Arc
  ev("relay_quote_request", { amountUsdc });
  const r = await fetch("https://api.relay.link/quote", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: OPERATOR, originChainId: 5042, destinationChainId: 8453,
      originCurrency: USDC_ARC, destinationCurrency: NATIVE_PLACEHOLDER,
      amount: amount.toString(), tradeType: "EXACT_INPUT", recipient: BURNER,
    }),
  });
  const j = await r.json() as { message?: string } & Record<string, unknown>;
  if ((j as { message?: string }).message) throw new Error(`relay: ${(j as { message?: string }).message}`);
  return j as never;
}

async function relay() {
  const amount = process.argv[3] ?? "0.19";
  const q = await relayQuote(amount);
  const out = Number(q.details.currencyOut.amount) / 1e18;
  const outMin = Number(q.details.currencyOut.minimumAmount) / 1e18;
  log(`relay quote: ${amount} USDC -> ${out} ETH (min ${outMin})`);
  for (const s of q.steps) log(`step ${s.id}: to=${s.items[0].data.to} gas=${s.items[0].data.gas}`);
  if (!yes) { log("dry-run — pass --yes to send"); return; }
  const acct = privateKeyToAccount(key("ARC_OPERATOR_KEY"));
  const pub = createPublicClient({ chain: ARC_MAINNET, transport: http() });
  const wal = createWalletClient({ account: acct, chain: ARC_MAINNET, transport: http() });
  for (const step of q.steps) {
    for (const item of step.items) {
      const d = item.data;
      ev("relay_step_send", { step: step.id, to: d.to });
      const tx = await wal.sendTransaction({ to: d.to, data: d.data, value: d.value ? BigInt(d.value) : 0n });
      log(`${step.id} tx:`, tx, `https://explorer.arc.io/tx/${tx}`);
      const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
      log(`${step.id} status:`, rcpt.status);
      if (rcpt.status !== "success") throw new Error(`${step.id} failed`);
      ev("relay_step_mined", { step: step.id, tx, status: rcpt.status });
    }
  }
  // poll burner ETH on Base
  const pubBase = createPublicClient({ chain: base, transport: http() });
  for (let i = 0; i < 60; i++) {
    const bal = await pubBase.getBalance({ address: BURNER });
    if (bal > 0n) { log(`ETH arrived on Base: ${Number(bal) / 1e18}`); ev("relay_eth_arrived", { wei: bal.toString() }); return; }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  log("ETH not arrived in 10min — check relay status by requestId");
}

async function gaszip() {
  const amount = process.argv[3] ?? "0.5";
  const q = await lifiQuote(amount);
  log(`quote: ${amount} USDC -> ${Number(q.estimate.toAmount) / 1e18} ETH (min ${Number(q.estimate.toAmountMin) / 1e18}) tool=${q.tool}`);
  log(`txRequest: to=${q.transactionRequest.to} value=${q.transactionRequest.value} data=${q.transactionRequest.data.slice(0, 42)}…`);
  if (!yes) { log("dry-run — pass --yes to send"); return; }
  const acct = privateKeyToAccount(key("ARC_OPERATOR_KEY"));
  const pub = createPublicClient({ chain: ARC_MAINNET, transport: http() });
  const wal = createWalletClient({ account: acct, chain: ARC_MAINNET, transport: http() });
  ev("gaszip_send", { to: q.transactionRequest.to, value: q.transactionRequest.value });
  const tx = await wal.sendTransaction({
    to: q.transactionRequest.to,
    data: q.transactionRequest.data,
    value: BigInt(q.transactionRequest.value),
    gas: q.transactionRequest.gasLimit ? BigInt(q.transactionRequest.gasLimit) : undefined,
  });
  log("Arc tx:", tx, `https://explorer.arc.io/tx/${tx}`);
  const rcpt = await pub.waitForTransactionReceipt({ hash: tx });
  log("Arc receipt status:", rcpt.status);
  ev("gaszip_arced", { tx, status: rcpt.status });
  // persist tx for LiFi status tracking
  const fs = await import("node:fs");
  fs.writeFileSync(new URL("./gaszip-tx.json", import.meta.url), JSON.stringify({ tx, amount, quote: q.estimate }, null, 2));
  // poll burner ETH on Base
  const pubBase = createPublicClient({ chain: base, transport: http() });
  for (let i = 0; i < 60; i++) {
    const bal = await pubBase.getBalance({ address: BURNER });
    if (bal > 0n) { log(`ETH arrived on Base: ${Number(bal) / 1e18}`); ev("gaszip_eth_arrived", { wei: bal.toString() }); return; }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  log("ETH not arrived in 10min — check https://li.quest/v1/status?bridge=gaszip&fromChain=5042&toChain=8453&txHash=" + tx);
}

const ERC20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const TM = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64)",
]);
const MT = parseAbi(["function receiveMessage(bytes message, bytes attestation) returns (bool)"]);
async function pollIris(api: string, srcDomain: number, txHash: string): Promise<{ msg: Hex; att: Hex }> {
  for (let i = 0; i < 120; i++) {
    const r = await fetch(`${api}/v2/messages/${srcDomain}?transactionHash=${txHash}`);
    const j = await r.json() as { messages?: { status?: string; attestation?: string | null; message?: string | null }[] };
    const m = j.messages?.[0];
    if (m?.message && m.attestation && m.attestation !== "PENDING") {
      return { msg: m.message as Hex, att: m.attestation as Hex };
    }
    if (i % 6 === 0) { log(`iris status: ${m?.status ?? r.status}`); ev("iris_poll", { status: m?.status ?? r.status }); }
    await new Promise((r2) => setTimeout(r2, 10_000));
  }
  throw new Error("attestation timeout");
}

async function runCctp(opts: {
  name: string; srcChain: typeof base | typeof baseSepolia; srcRpc: string;
  dstChain: typeof ARC_MAINNET | typeof ARC_TESTNET; dstRpc: string;
  usdc: Address; tokenMessenger: Address; messageTransmitter: Address;
  srcKeyEnv: string; dstKeyEnv: string; amount: string; recipient: Address;
  attestationApi: string; srcDomain: number;
}) {
  const srcAcct = privateKeyToAccount(key(opts.srcKeyEnv));
  const dstAcct = privateKeyToAccount(key(opts.dstKeyEnv));
  const pubSrc = createPublicClient({ chain: opts.srcChain, transport: http(opts.srcRpc) });
  const pubDst = createPublicClient({ chain: opts.dstChain, transport: http(opts.dstRpc) });
  const walSrc = createWalletClient({ account: srcAcct, chain: opts.srcChain, transport: http(opts.srcRpc) });
  const walDst = createWalletClient({ account: dstAcct, chain: opts.dstChain, transport: http(opts.dstRpc) });
  const amount = parseUnits(opts.amount, 6);
  const bal = await pubSrc.readContract({ address: opts.usdc, abi: ERC20, functionName: "balanceOf", args: [srcAcct.address] });
  log(`[${opts.name}] src ${srcAcct.address}: ${Number(bal) / 1e6} USDC`);
  ev("cctp_start", { net: opts.name, src: srcAcct.address, usdcBal: bal.toString(), amount: opts.amount });
  const allowance = await pubSrc.readContract({ address: opts.usdc, abi: ERC20, functionName: "allowance", args: [srcAcct.address, opts.tokenMessenger] });
  if (allowance < amount) {
    const tx = await walSrc.writeContract({ address: opts.usdc, abi: ERC20, functionName: "approve", args: [opts.tokenMessenger, amount] });
    log("approve tx:", tx); ev("cctp_approve_sent", { tx }); await pubSrc.waitForTransactionReceipt({ hash: tx }); ev("cctp_approve_mined", { tx });
  }
  const mintRecipient = pad(opts.recipient, { size: 32 });
  const burnTx = await walSrc.writeContract({
    address: opts.tokenMessenger, abi: TM, functionName: "depositForBurn",
    args: [amount, 26, mintRecipient, opts.usdc, pad("0x0000000000000000000000000000000000000000", { size: 32 }), 0n, 2000],
  });
  log("burn tx:", burnTx); ev("cctp_burn_sent", { tx: burnTx });
  await pubSrc.waitForTransactionReceipt({ hash: burnTx });
  ev("cctp_burn_mined", { tx: burnTx });
  log("polling iris /v2/messages for attestation…");
  const { msg, att } = await pollIris(opts.attestationApi, opts.srcDomain, burnTx);
  log("attestation received — minting on dst");
  ev("cctp_attested", { tx: burnTx });
  const mintTx = await walDst.writeContract({ address: opts.messageTransmitter, abi: MT, functionName: "receiveMessage", args: [msg, att] });
  log("mint tx:", mintTx);
  const r2 = await pubDst.waitForTransactionReceipt({ hash: mintTx });
  log("mint confirmed, status:", r2.status);
}

async function testnetCctp() {
  if (!yes) { log("dry-run — pass --yes to run real testnet CCTP"); return; }
  await runCctp({
    name: "testnet", srcChain: baseSepolia, srcRpc: "https://sepolia.base.org",
    dstChain: ARC_TESTNET, dstRpc: "https://rpc.testnet.arc.io",
    usdc: CCTP_TEST.usdcSource, tokenMessenger: CCTP_TEST.tokenMessengerSrc,
    messageTransmitter: CCTP_TEST.messageTransmitterDst,
    srcKeyEnv: "ARC_OPERATOR_KEY", dstKeyEnv: "ARC_OPS_KEY",
    amount: "0.01", recipient: OPERATOR,
    attestationApi: "https://iris-api-sandbox.circle.com", srcDomain: 6,
  });
}

async function mainnetCctp() {
  const acct = privateKeyToAccount(key("GEC_INTEROP_PRIVATE_KEY"));
  const pubBase = createPublicClient({ chain: base, transport: http() });
  const ethBal = await pubBase.getBalance({ address: acct.address });
  const bal = await pubBase.readContract({ address: CCTP_MAIN.usdcSource, abi: ERC20, functionName: "balanceOf", args: [acct.address] });
  log(`burner: ${Number(bal) / 1e6} USDC, ${Number(ethBal) / 1e18} ETH on Base`);
  if (ethBal === 0n) { log("NO ETH on Base — run gaszip first"); return; }
  if (!yes) { log("dry-run — pass --yes to execute REAL CCTP"); return; }
  await runCctp({
    name: "mainnet", srcChain: base, srcRpc: "https://mainnet.base.org",
    dstChain: ARC_MAINNET, dstRpc: "https://rpc.drpc.mainnet.arc.io",
    usdc: CCTP_MAIN.usdcSource, tokenMessenger: CCTP_MAIN.tokenMessenger,
    messageTransmitter: CCTP_MAIN.messageTransmitter,
    srcKeyEnv: "GEC_INTEROP_PRIVATE_KEY", dstKeyEnv: "ARC_OPERATOR_KEY",
    amount: "5", recipient: OPERATOR,
    attestationApi: "https://iris-api.circle.com", srcDomain: 6,
  });
}

async function resume() {
  // resume a burn already submitted: swap-rescue.mts resume <burnTxHash> <testnet|mainnet> [--yes]
  const burnTx = process.argv[3];
  const net = process.argv[4] ?? "testnet";
  if (!/^0x[0-9a-fA-F]{64}$/.test(burnTx ?? "")) throw new Error("usage: resume <burnTxHash> <testnet|mainnet> [--yes]");
  const cfg = net === "mainnet"
    ? { api: "https://iris-api.circle.com", domain: 6, dst: ARC_MAINNET, dstRpc: "https://rpc.drpc.mainnet.arc.io", mt: CCTP_MAIN.messageTransmitter, keyEnv: "ARC_OPERATOR_KEY" }
    : { api: "https://iris-api-sandbox.circle.com", domain: 6, dst: ARC_TESTNET, dstRpc: "https://rpc.testnet.arc.io", mt: CCTP_TEST.messageTransmitterDst, keyEnv: "ARC_OPS_KEY" };
  ev("resume_start", { burnTx, net });
  const { msg, att } = await pollIris(cfg.api, cfg.domain, burnTx);
  log("attestation received"); ev("cctp_attested", { tx: burnTx });
  if (!yes) { log("dry-run — pass --yes to mint on dst"); return; }
  const dstAcct = privateKeyToAccount(key(process.env.DST_KEY_ENV ?? cfg.keyEnv));
  const pubDst = createPublicClient({ chain: cfg.dst, transport: http(cfg.dstRpc) });
  const walDst = createWalletClient({ account: dstAcct, chain: cfg.dst, transport: http(cfg.dstRpc) });
  const mintTx = await walDst.writeContract({ address: cfg.mt, abi: MT, functionName: "receiveMessage", args: [msg, att] });
  log("mint tx:", mintTx); ev("cctp_mint_sent", { tx: mintTx });
  const r2 = await pubDst.waitForTransactionReceipt({ hash: mintTx });
  log("mint confirmed, status:", r2.status);
  ev("cctp_minted", { tx: mintTx, status: r2.status });
}

const fns = { quote, relay, gaszip, "testnet-cctp": testnetCctp, cctp: mainnetCctp, resume } as const;
if (!(mode in fns)) { console.error("modes: quote | gaszip <amt> [--yes] | testnet-cctp [--yes] | cctp [--yes] | resume <burnTx> <net> [--yes]"); process.exit(1); }
fns[mode as keyof typeof fns]().catch((e) => { console.error(e); process.exit(1); });
