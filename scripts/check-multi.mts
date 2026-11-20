import { createPublicClient, http, parseAbi } from "viem";
const OP="0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d" as const;
const USDC:Record<string,`0x${string}`>={base:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",eth:"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",arb:"0xaf88d065e77c8cC2239327C5EDb3A432268e5831",op:"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",poly:"0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"};
const rpcs:Record<string,string>={base:"https://mainnet.base.org",eth:"https://eth.llamarpc.com",arb:"https://arb1.arbitrum.io/rpc",op:"https://mainnet.optimism.io",poly:"https://polygon-rpc.com"};
const ab=parseAbi(["function balanceOf(address) view returns (uint256)"]);
for (const [c,rpc] of Object.entries(rpcs)) {
  try {
    const pub=createPublicClient({chain:{id:1,rpcUrls:{default:{http:[rpc]}}} as never,transport:http()});
    const eth=await pub.getBalance({address:OP});
    let usdc=0n;
    try{ usdc=await pub.readContract({address:USDC[c],abi:ab,functionName:"balanceOf",args:[OP]});}catch{}
    console.log(c.padEnd(5),"ETH:",(Number(eth)/1e18).toFixed(6)," USDC:",(Number(usdc)/1e6).toFixed(2));
  } catch(e){ console.log(c,"ERR",(e as Error).message.slice(0,60)); }
}
