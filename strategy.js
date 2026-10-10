'use strict';
const {nySessions}=require('./market');
const CONTRACT=Object.freeze({symbol:'CME_MINI:NQ1!',tickSize:0.25,pointValueUsd:20,tickValueUsd:5});
const DEFAULTS=Object.freeze({startingUsd:600,riskUsd:15,maxDailyLossUsd:30,slippageTicksPerSide:1,roundTripFeeUsd:5,maxContracts:1});
function params(input={}) {
  const o={...DEFAULTS,...input};
  for(const [key,min,max] of [['startingUsd',1,100000000],['riskUsd',1,1000000],['maxDailyLossUsd',1,1000000],['slippageTicksPerSide',0,20],['roundTripFeeUsd',0,1000]]) {
    if(typeof o[key]!=='number'||!Number.isFinite(o[key])||o[key]<min||o[key]>max) throw Error(`Invalid ${key} (${min}..${max})`);
  }
  if(!Number.isInteger(o.maxContracts)||o.maxContracts<1||o.maxContracts>20)throw Error('maxContracts must be 1..20');
  return o;
}
function riskFor({entry,stop,opts}) {
  const o=params(opts);
  return Math.abs(entry-stop)*CONTRACT.pointValueUsd+2*o.slippageTicksPerSide*CONTRACT.tickValueUsd+o.roundTripFeeUsd;
}
const roundTick = price=>Math.round(price*4)/4;
// Conservative: an unfavorable gap fills at the bar's open, not at the stop price.
function fillExit(trade,bar,type,o) {
  const adverse=o.slippageTicksPerSide*CONTRACT.tickSize, buy=trade.side==='BUY';
  let raw;
  if(type==='STOP')raw=buy?Math.min(bar.open,trade.stop):Math.max(bar.open,trade.stop);
  else if(type==='TARGET')raw=trade.target;
  else raw=bar.open;
  const exit=roundTick(raw+(buy?-adverse:adverse));
  const pnl=(exit-trade.entry)*(buy?1:-1)*CONTRACT.pointValueUsd*trade.contracts-o.roundTripFeeUsd*trade.contracts;
  return {...trade,exitAt:new Date(bar.t).toISOString(),exit,reason:type,pnlUsd:Math.round(pnl*100)/100};
}
function backtest(bars,rawOpts={}) {
  const o=params(rawOpts),sessions=nySessions(bars);
  let equity=o.startingUsd,peak=equity,drawdown=0;
  const trades=[],equityPoints=[{date:'Start',equity}],skips={incomplete:0,noSignal:0,risk:0,lossLimit:0,missingBars:0},daily=[];
  for(const [day,g] of [...sessions.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
    // Reject incomplete sessions, including current/in-progress and early-close dates.
    if(Array.from({length:390},(_,i)=>g.has(i+570)).some(x=>!x)) {skips.incomplete++;continue}
    const seq=Array.from({length:390},(_,i)=>g.get(570+i));
    const hi=Math.max(...seq.slice(0,30).map(x=>x.high));
    const lo=Math.min(...seq.slice(0,30).map(x=>x.low));
    let position=null,oneTrade=false,lastDaily=0;
    for(let i=30;i<390;i++) {
      const b=seq[i],minute=570+i;
      if(position){
        // ENTRY occurs at the open of the signal's next candle; protective checks use that candle.
        const stopHit=position.side==='BUY'?b.low<=position.stop:b.high>=position.stop;
        const targetHit=position.side==='BUY'?b.high>=position.target:b.low<=position.target;
        const atEnd=minute>=959;
        const at15mEnd=(minute+1)%15===0;
        let reason=null,exitBar=b;
        if(stopHit)reason='STOP';
        else if(targetHit)reason='TARGET';
        else if(position.exitOnNextBar)reason='FAILED_CONFIRMATION';
        else if(atEnd)reason='SESSION_CLOSE';
        if(reason==='FAILED_CONFIRMATION')exitBar={...b,open:b.open};
        if(reason){
          if(reason==='SESSION_CLOSE')exitBar={...b,open:b.close};
          const result=fillExit(position,exitBar,reason,o);
          trades.push(result);equity+=result.pnlUsd;lastDaily+=result.pnlUsd;
          peak=Math.max(peak,equity);drawdown=Math.max(drawdown,peak-equity);
          position=null;
          continue;
        }
        if(at15mEnd && Math.floor((minute-570)/15)===position.entryBlock &&
          !(position.side==='BUY'?b.close>hi:b.close<lo))position.exitOnNextBar=true;
        continue;
      }
      if(oneTrade || i>=120 || i>=389)continue; // opening-only 10:00–11:29 ET
      // Close-confirmed breakout means next candle OPEN entry. No lookahead.
      const signal=seq[i];
      const side=signal.close>hi?'BUY':signal.close<lo?'SELL':null;
      if(!side)continue;
      if(lastDaily<=-o.maxDailyLossUsd){skips.lossLimit++;break}
      const entryBar=seq[i+1];
      const distance=(entryBar.open-(side==='BUY'?lo:hi))*(side==='BUY'?1:-1);
      if(distance<=0)continue;
      const entry=roundTick(entryBar.open+(side==='BUY'?1:-1)*o.slippageTicksPerSide*CONTRACT.tickSize);
      const stop=side==='BUY'?lo:hi;
      const unitRisk=riskFor({entry,stop,opts:o});
      const qty=Math.min(o.maxContracts,Math.floor(o.riskUsd/unitRisk));
      if(qty<1){skips.risk++;continue}
      const target=roundTick(entry+(entry-stop)); // 1:1 R:R from actual entry.
      position={day,side,entryAt:new Date(entryBar.t).toISOString(),entry,stop,target,contracts:qty,entryBlock:Math.floor((i+1)/15),exitOnNextBar:false};
      oneTrade=true;
      // Advance to next bar; entry bar will be processed for SL/TP.
    }
    if(!oneTrade)skips.noSignal++;
    daily.push({day,netUsd:Math.round(lastDaily*100)/100});
    equityPoints.push({date:day,equity:Math.round(equity*100)/100});
  }
  const wins=trades.filter(x=>x.pnlUsd>0).length;
  const gains=trades.filter(x=>x.pnlUsd>0).reduce((s,x)=>s+x.pnlUsd,0);
  const losses=-trades.filter(x=>x.pnlUsd<0).reduce((s,x)=>s+x.pnlUsd,0);
  return {instrument:CONTRACT.symbol,mode:'HISTORICAL_RESEARCH_ONLY',settings:o,stats:{startingUsd:o.startingUsd,endingUsd:Math.round(equity*100)/100,netUsd:Math.round((equity-o.startingUsd)*100)/100,trades:trades.length,wins,winRate:trades.length?Math.round(wins/trades.length*10000)/100:null,maxDrawdownUsd:Math.round(drawdown*100)/100,profitFactor:losses>0?Math.round(gains/losses*100)/100:null,completeSessions:daily.length,skips},trades,daily,equityPoints,warning:'CSV backtest only. No real-time CME data, order routing, broker margin, funding or guaranteed fills. Complete 390-candle NY cash sessions required. Uses stop-priority when both SL and TP occur in the same minute.'};
}
module.exports={CONTRACT,DEFAULTS,params,riskFor,backtest};
