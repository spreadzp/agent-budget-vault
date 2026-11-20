import { createPublicClient, http } from "viem";
const arc={id:5042,rpcUrls:{default:{http:["https://rpc.drpc.mainnet.arc.io"]}}} as never;
const pub=createPublicClient({chain:arc,transport:http()});
const ws:[string,string][]=[["OPERATOR","0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d"],["ARC_OPS","0xc9fA59e889c25b7f0b9494ed5c6bC62fe7EcCC56"],["VENUE","0x67d43A4065Dd69165061062B3128EDA50f1F7C96"],["EVAL","0xEAF85d8c4a0baF0d73B32FfFB7E57976B5572ba2"],["DEMO","0x8C644ea1Fc47d9185F5eEfb84bE23F7394C6e0d8"],["BURNER","0x3bF7bf14c839AC615F87cDeDe344dF01B9cFb89f"]];
for (const [n,a] of ws) {
  const b=await pub.getBalance({address:a as `0x${string}`});
  console.log(n, a.slice(0,10), (Number(b)/1e18).toFixed(6), "USDC");
}
