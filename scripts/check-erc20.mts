import { createPublicClient, http, parseAbi } from "viem";
const pub=createPublicClient({chain:{id:5042,rpcUrls:{default:{http:["https://rpc.drpc.mainnet.arc.io"]}}} as never,transport:http()});
const USDC="0x3600000000000000000000000000000000000000" as const;
const ab=parseAbi(["function balanceOf(address) view returns (uint256)","function decimals() view returns (uint8)"]);
const OP="0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d";
const dec=await pub.readContract({address:USDC,abi:ab,functionName:"decimals"}).catch(()=>"ERR");
console.log("decimals:",dec);
const b=await pub.readContract({address:USDC,abi:ab,functionName:"balanceOf",args:[OP]}).catch((e:Error)=>{console.log("balOf err:",e.message.slice(0,80));return 0n});
console.log("OPERATOR erc20 USDC:",(Number(b)/1e6).toFixed(6));
