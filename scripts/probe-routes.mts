import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
const adapter = createViemAdapterFromPrivateKey({ privateKey: process.env.ARC_OPERATOR_KEY });
const kit = new AppKit();
const BURNER = "0x3bF7bf14c839AC615F87cDeDe344dF01B9cFb89f";
const cases = [
  { from:"Arc", to:"Base", tin:"USDC", tout:"NATIVE" },
  { from:"Arc", to:"Base", tin:"USDC", tout:"USDC" },
  { from:"Arc", to:"Base", tin:"USDC", tout:"ETH" },
  { from:"Arc", to:"Base", tin:"USDC", tout:"WETH" },
  { from:"Base", to:"Arc", tin:"USDC", tout:"USDC" },
  { from:"Arc", to:"Ethereum", tin:"USDC", tout:"NATIVE" },
  { from:"Arc", to:"Arbitrum", tin:"USDC", tout:"NATIVE" },
];
for (const c of cases) {
  try {
    const est = await kit.estimateSwap({
      from: { adapter, chain: c.from },
      tokenIn: c.tin, tokenOut: c.tout, amountIn: "1.00",
      to: { chain: c.to, recipientAddress: BURNER },
      config: { slippageBps: 200, allowanceStrategy: "approve" },
    });
    console.log(`${c.from}->${c.to} ${c.tin}->${c.tout}: OK out=${est.estimatedOutput?.amount} ${est.estimatedOutput?.token} provider=${est.route?.provider}`);
  } catch (e) {
    console.log(`${c.from}->${c.to} ${c.tin}->${c.tout}: FAIL ${e?.name || e?.code || String(e).slice(0,80)}`);
  }
}
