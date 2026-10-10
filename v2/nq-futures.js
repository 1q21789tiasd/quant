'use strict';
// RESEARCH-ONLY futures position-risk calculations. No brokerage integration.
const CONTRACTS=Object.freeze({
  NQ:Object.freeze({symbol:'CME_MINI:NQ1!',pointValueUsd:20,tickSize:0.25,tickValueUsd:5}),
  MNQ:Object.freeze({symbol:'CME_MINI:MNQ1!',pointValueUsd:2,tickSize:0.25,tickValueUsd:0.5})
});
function finitePositive(n,label){
  if(!Number.isFinite(n)||n<=0)throw new RangeError(label+' must be positive and finite');
}
function tickAligned(n,tick){
  return Math.abs(n/tick-Math.round(n/tick))<1e-7;
}
// Risk includes BOTH entry and exit slippage plus all estimated round-trip commission.
// Stops may fill worse than modeled, so this is an estimate NOT a guarantee.
function riskEstimate({contract='NQ',entry,stop,contracts=1,slippageTicksPerSide=1,commissionRoundTripUsd=0}={}){
  const spec=CONTRACTS[contract];
  if(!spec)throw new RangeError('Only NQ and MNQ futures supported');
  finitePositive(entry,'entry');finitePositive(stop,'stop');
  if(!tickAligned(entry,spec.tickSize)||!tickAligned(stop,spec.tickSize)||entry===stop)throw new RangeError('Entry/stop must differ and be aligned to CME 0.25-point tick');
  if(!Number.isInteger(contracts)||contracts<1)throw new RangeError('contracts must be a positive integer');
  if(!Number.isFinite(slippageTicksPerSide)||slippageTicksPerSide<0 || !Number.isFinite(commissionRoundTripUsd)||commissionRoundTripUsd<0)throw new RangeError('Slippage and commission must be nonnegative');
  const stopDistancePoints=Math.abs(entry-stop);
  const perContractUsd=stopDistancePoints*spec.pointValueUsd+
    2*slippageTicksPerSide*spec.tickValueUsd+commissionRoundTripUsd;
  return {contract,requestedChartSymbol:spec.symbol,contracts,stopDistancePoints,
    estimatedLossUsd:perContractUsd*contracts,perContractUsd,
    warning:'Gap/fast-market fills can exceed estimated losses; real trades need a dated contract and broker quotes.'};
}
function contractsWithinBudget({riskBudgetUsd,...opts}){
  finitePositive(riskBudgetUsd,'riskBudgetUsd');
  const single=riskEstimate({...opts,contracts:1});
  return {...single,riskBudgetUsd,maxWholeContracts:Math.floor(riskBudgetUsd/single.perContractUsd)};
}
function assertTimelyChart({sourceStatus,barTime,now=Date.now(),maxAgeMs=90000}){
  if(/\b(delayed|market closed|closed)\b/i.test(sourceStatus||''))throw new Error('TradingView chart is delayed/closed; no automated entry allowed');
  const ts=Date.parse(barTime);
  if(!Number.isFinite(ts)||ts>now||now-ts>maxAgeMs)throw new Error('No independently timestamped fresh exchange bar; no automated entry allowed');
  return true;
}
module.exports={CONTRACTS,riskEstimate,contractsWithinBudget,assertTimelyChart};
