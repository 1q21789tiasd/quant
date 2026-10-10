'use strict';
// Strict local paper simulator, never brokerage order execution.
const fmt=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function ny(ts){const p=Object.fromEntries(fmt.formatToParts(new Date(ts)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return {day:p.year+'-'+p.month+'-'+p.day,minute:Number(p.hour)*60+Number(p.minute)};}
function openingRange(bars,day){
  const table=new Map(bars.filter(b=>ny(b.t).day===day).map(b=>[ny(b.t).minute,b]));
  const sample=Array.from({length:30},(_,i)=>table.get(570+i));
  if(sample.some(x=>!x))return null;
  return {high:Math.max(...sample.map(x=>x.h)),low:Math.min(...sample.map(x=>x.l))};
}
const DEFAULT={initialUsd:600,riskUsd:4,maxDailyLossUsd:12,maxExposureFraction:0.65,slippageBps:3,feePerSideUsd:0.05};
function createLedger(options={}){
  const opt={...DEFAULT,...options};
  if(![opt.initialUsd,opt.riskUsd,opt.maxDailyLossUsd,opt.maxExposureFraction,opt.slippageBps,opt.feePerSideUsd].every(Number.isFinite)||
    opt.initialUsd<=0||opt.riskUsd<=0||opt.maxDailyLossUsd<=0||opt.maxExposureFraction<=0||opt.maxExposureFraction>1||opt.slippageBps<0||opt.feePerSideUsd<0)throw new Error('Invalid risk options');
  return {version:2,opt,balanceUsd:opt.initialUsd,position:null,trades:[],lastBar:{},dayTrades:{},events:[]};
}
function closePosition(s,b,raw,reason){
  const p=s.position,sign=p.side==='BUY'?1:-1;
  const fill=raw*(1-sign*s.opt.slippageBps/10000);
  const gross=(fill-p.entry)*sign*p.qty;
  const net=gross-2*s.opt.feePerSideUsd;
  s.balanceUsd+=net;
  const trade={...p,exitAt:b.t,exitPrice:fill,exitReason:reason,grossUsd:gross,netUsd:net,balanceAfterUsd:s.balanceUsd};
  s.trades.push(trade);
  s.events.push({type:'CLOSE',symbol:p.symbol,at:b.t,reason,netUsd:Number(net.toFixed(4))});
  s.position=null;
}
function step(s,symbol,b,range,{canEnter=false,closeMinute=960}={}) {
  const prior=s.lastBar[symbol];if(prior&&b.t<=prior)return false;
  const {day,minute}=ny(b.t);s.lastBar[symbol]=b.t;
  let p=s.position;
  if(p&&p.symbol===symbol){
    const buy=p.side==='BUY';
    if(p.day!==day)closePosition(s,b,b.o,'OVERNIGHT_GAP');
    else if(p.pendingExit)closePosition(s,b,b.o,'FAILED_CONFIRMATION');
    else if(buy?b.l<=p.stop:b.h>=p.stop)closePosition(s,b,buy?Math.min(p.stop,b.o):Math.max(p.stop,b.o),'STOP');
    else if(buy?b.h>=p.target:b.l<=p.target)closePosition(s,b,p.target,'TARGET');
    else if(minute>=Math.min(955,closeMinute-5))closePosition(s,b,b.c,'END_SESSION');
    else if((minute+1)%15===0&&Math.floor((minute-570)/15)===Math.floor((p.entryMinute-570)/15)&&!(buy?b.c>p.rangeHigh:b.c<p.rangeLow))p.pendingExit=true;
  }
  if(!canEnter||s.position||!range||range.high<=range.low||minute<600||minute>=Math.min(930,closeMinute-30)||s.dayTrades[day])return false;
  const dayNet=s.trades.filter(t=>t.day===day).reduce((sum,t)=>sum+t.netUsd,0);
  if(dayNet<=-s.opt.maxDailyLossUsd||s.balanceUsd<=1)return false;
  const long=b.h>=range.high,short=b.l<=range.low;
  if(!long||short)return false; // Long-only; no short borrow/margin assumptions.
  const raw=Math.max(range.high,b.o), entry=raw*(1+s.opt.slippageBps/10000),stop=range.low;
  const riskPerShare=entry-stop+stop*s.opt.slippageBps/10000;
  const riskAvailable=s.opt.riskUsd-2*s.opt.feePerSideUsd;
  const qty=Math.min(riskAvailable/riskPerShare,s.balanceUsd*s.opt.maxExposureFraction/entry);
  if(!(qty>0.000001)||!Number.isFinite(qty))return false;
  const target=raw+(raw-stop);
  s.position={symbol,day,side:'BUY',entryAt:b.t,entryMinute:minute,entry,stop,target,qty,rangeHigh:range.high,rangeLow:range.low,pendingExit:false};
  s.dayTrades[day]=1;s.events.push({type:'OPEN',at:b.t,symbol,entry,stop,target,qty});
  // Unknown intrabar path: pessimistically assume protective stop first, even on entry bar.
  if(b.l<=stop)closePosition(s,b,Math.min(stop,b.o),'ENTRY_BAR_STOP');
  return true;
}
module.exports={ny,openingRange,createLedger,step};
