const USDC="0x3600000000000000000000000000000000000000", NAT="0x0000000000000000000000000000000000000000";
const OP="0xcdd23d104AA4C10DE65F4DD0571eDfeC0458699d", BU="0x3bF7bf14c839AC615F87cDeDe344dF01B9cFb89f";
for (const amt of ["0.3","0.35","0.4","0.45"]) {
  const wei=BigInt(Math.round(parseFloat(amt)*1e18));
  const u=`https://li.quest/v1/quote?fromChain=5042&toChain=8453&fromToken=${USDC}&toToken=${NAT}&fromAmount=${wei}&fromAddress=${OP}&toAddress=${BU}`;
  const r=await fetch(u); const q=await r.json();
  if (q.estimate) console.log(amt,"USDC ->",(Number(q.estimate.toAmount)/1e18).toFixed(6),"ETH tool="+q.tool,"dur="+q.estimate.executionDuration+"s");
  else console.log(amt,"-> ERR",(q.message||"?").slice(0,60));
}
