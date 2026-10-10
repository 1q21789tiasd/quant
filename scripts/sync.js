#!/usr/bin/env node
'use strict';
// Daily AFTER-THE-FACT, 8-hour-delayed paper research. NOT live trading.
const fs=require('node:fs'),path=require('node:path');
const {Massive}=require('../massive');
const {nyTime,nySessions}=require('../market');
const {backtest}=require('../strategy');
const {replay}=require('../engine');
function completeCashSessions(bars){
  const days=nySessions(bars),out=[];
  for(const [day,g] of days){
    if(Array.from({length:390},(_,i)=>g.has(i+570)).every(Boolean))
      out.push(...[...g].sort((a,b)=>a[0]-b[0]).map(([minute,b])=>b));
  }
  return out.sort((a,b)=>a.t-b.t);
}
function write(file,obj){const dir=path.dirname(file);fs.mkdirSync(dir,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(obj,null,2),{mode:0o600});fs.renameSync(tmp,file)}
async function sync(){
  const contract=process.env.MASSIVE_CONTRACT;
  if(!contract)throw Error('Set explicit MASSIVE_CONTRACT=NQZ6 (verify current volume/roll first)');
  const days=Number(process.env.LOOKBACK_DAYS||14);
  if(!Number.isInteger(days)||days<2||days>30)throw Error('LOOKBACK_DAYS must be 2..30');
  const end=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const start=new Date(Date.parse(end+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
  const all=await new Massive().bars(contract,start,end),bars=completeCashSessions(all);
  if(!bars.length)throw Error('No complete cash sessions: provider may have gaps, contract may be wrong or still delayed');
  const riskUsd=Number(process.env.PAPER_RISK_USD||15),usdIls=Number(process.env.USD_ILS_RATE||0);
  const research=backtest(bars,{riskUsd});
  const results=replay(bars,{riskUsd,usdIls});
  const stamp={source:'Massive CME Futures 8-hour historical; AFTER-THE-FACT REPLAY ONLY',contract,generatedAt:new Date().toISOString(),completeDays:research.stats.completeSessions};
  write(path.join(__dirname,'..','data','last-replay.json'),{...results,...stamp,mode:'HISTORICAL_REPLAY'});
  write(path.join(__dirname,'..','data','last-backtest.json'),{...research,...stamp});
  console.log(JSON.stringify({...stamp,latestPaperBalanceUsd:results.balanceUsd,trades:results.trades,
    netUsd:results.netUsd,netIls:results.netIls,warning:'These are delayed retrospective simulations, NOT real-time executed trades.'},null,2));
}
if(require.main===module)sync().catch(err=>{console.error(err.message);process.exitCode=1});
module.exports={completeCashSessions};
