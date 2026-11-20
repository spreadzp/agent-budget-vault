import { createPublicClient, http, parseAbi } from "viem";
const arc={id:5042,rpcUrls:{default:{http:["https://rpc.drpc.mainnet.arc.io"]}}} as never;
const baseC={id:8453,rpcUrls:{default:{http:["https://mainnet.base.org"]}}} as never;
const pubA=createPublicClient({chain:arc,transport:http()});
const pubB=createPublicClient({chain:baseC,transport:http()});
const BU="0x3bF7bf14c839AC615F87cDeDe344dF01B9cFb89f" as const;
const USDC_BASE="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ab=parseAbi(["function balanceOf(address) view returns (uint256)"]);
const [arcBu,arcOp,baseEth,baseUsdc]=await Promise.all([
  pubA.getBalance({address:BU}), pubA.getBalance({address:"0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d"}),
  pubB.getBalance({address:BU}), pubB.readContract({address:USDC_BASE,abi:ab,functionName:"balanceOf",args:[BU]}).catch(()=>0n),
]);
console.log("burner Arc USDC(native):",(Number(arcBu)/1e18).toFixed(6));
console.log("operator Arc USDC:",(Number(arcOp)/1e18).toFixed(6));
console.log("burner Base ETH:",(Number(baseEth)/1e18).toFixed(9));
console.log("burner Base USDC:",(Number(baseUsdc)/1e6).toFixed(2));
