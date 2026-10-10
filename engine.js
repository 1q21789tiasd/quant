'use strict';
// Pure deterministic NQ/MNQ paper engine. No brokerage orders or fake data generation.
const {nyTime}=require('./market');
const MULTIPLIERS={NQ:20,MNQ:2};
const round2=x=>Math.round((x+Number.EPSILON)*100)/100;
const tick=x=>Math.round(x*4)/4;
const SETTINGS=Object.freeze({contract:'NQ',startingUsd:600,riskUsd:15,dailyLossUsd:30,
  maxContracts:1,feePerSideUsd:2.5,slippageTicks:1,stopRR:1,
  minRangePoints:2,maxRangePoints:500,usdIls:0,dailyTargetIls:50});
function settings(value={}) {
  const s={...SETTINGS,...value};
  if(!Object.hasOwn(MULTIPLIERS,s.contract))throw Error('Select futures multiplier NQ or MNQ; chart is NQ1!');
  for (const [key,min,max] of [['startingUsd',1,1e8],['riskUsd',1,1e6],['dailyLossUsd',1,1e6],
    ['maxContracts',1,30],['feePerSideUsd',0,100],['slippageTicks',0,20],
    ['stopRR',0.5,4],['minRangePoints',0.25,500],['maxRangePoints',1,2000],
    ['usdIls',0,10],['dailyTargetIls',1,10000]]) {
    if(typeof s[key]!=='number'||!Number.isFinite(s[key])||s[key]<min||s[key]>max)throw Error('Invalid setting: '+key);
  }
  if(!Number.isInteger(s.maxContracts)||s.minRangePoints>=s.maxRangePoints)throw Error('Invalid max contracts/range settings');
  return s;
}
function state(opts={}) {const s=settings(opts);return {version:3,settings:s,balanceUsd:s.startingUsd,
  lastBar:null,source:null,barsSeen:0,day:null,dayMinutes:{},range:null,haltDay:null,
  queued:null,position:null,closed:[],events:[],maxEquityUsd:s.startingUsd,maxDrawdownUsd:0,
  errors:[],lastPrice:null};}
function validBar(raw){
  const t=typeof raw.t==='number'?raw.t:Date.parse(raw.t||raw.timestamp||'');
  if(!Number.isSafeInteger(t)||t%60000!==0)throw Error('Bar requires an aligned ISO timestamp');
  const nums=['open','high','low','close'].map(k=>Number(raw[k]));
  if(nums.some(x=>!Number.isFinite(x)||x<=0||Math.abs(x*4-Math.round(x*4))>1e-7))throw Error('Invalid NQ quarter-point OHLC');
  const [open,high,low,close]=nums;
  if(low>Math.min(open,close)||high<Math.max(open,close)||high<low)throw Error('OHLC out of range');
  const volume=raw.volume==null?null:Number(raw.volume);
  if(volume!==null&&(!Number.isFinite(volume)||volume<0))throw Error('Invalid volume');
  return {t,open,high,low,close,volume};
}
function event(s,type,b,meta={}){s.events.push({type,at:new Date(b.t).toISOString(),...meta});if(s.events.length>500)s.events.shift()}
function close(s,b,raw,reason){
  const p=s.position;const direction=p.side==='BUY'?1:-1;
  const px=tick(raw-direction*s.settings.slippageTicks*0.25);
  const gross=(px-p.entry)*direction*MULTIPLIERS[s.settings.contract]*p.contracts;
  const net=round2(gross-2*s.settings.feePerSideUsd*p.contracts);
  const trade={...p,exitAt:new Date(b.t).toISOString(),exit:px,reason,pnlUsd:net};
  s.closed.push(trade);s.balanceUsd=round2(s.balanceUsd+net);
  s.maxEquityUsd=Math.max(s.maxEquityUsd,s.balanceUsd);
  s.maxDrawdownUsd=Math.max(s.maxDrawdownUsd,s.maxEquityUsd-s.balanceUsd);
  event(s,'CLOSE',b,{side:p.side,reason,pnlUsd:net});s.position=null;
  if(s.closed.filter(x=>x.day===s.day).reduce((a,x)=>a+x.pnlUsd,0)<=-s.settings.dailyLossUsd){s.haltDay=s.day;event(s,'DAILY_STOP',b)}
}
function enter(s,b){
  const pending=s.queued;s.queued=null;
  const direction=pending.side==='BUY'?1:-1;
  const entry=tick(b.open+direction*s.settings.slippageTicks*0.25);
  const stop=pending.side==='BUY'?pending.range.low:pending.range.high;
  const distance=direction*(entry-stop);
  if(distance<=0){event(s,'ENTRY_CANCEL',b,{reason:'price crossed stop'});return}
  const fee=2*s.settings.feePerSideUsd;
  const riskPer=distance*MULTIPLIERS[s.settings.contract]+
    s.settings.slippageTicks*0.25*MULTIPLIERS[s.settings.contract]+fee;
  const qty=Math.min(s.settings.maxContracts,Math.floor(s.settings.riskUsd/riskPer));
  if(qty<1){event(s,'RISK_REJECT',b,{estimatedRiskUsd:round2(riskPer),side:pending.side});return}
  const target=tick(entry+direction*distance*s.settings.stopRR);
  s.position={day:s.day,side:pending.side,entryAt:new Date(b.t).toISOString(),entry,stop,target,
    contracts:qty,estimatedRiskUsd:round2(qty*riskPer),entryBlock:Math.floor((nyTime(b.t).minute-570)/15),
    range:pending.range,confirmExit:false};
  event(s,'OPEN',b,{side:pending.side,entry,stop,target,contracts:qty});
}
function onBar(s,raw,{source='external',maxAgeMs=null,now=Date.now()}={}){
  const b=validBar(raw),clock=nyTime(b.t);
  if(maxAgeMs!==null&&(!Number.isFinite(maxAgeMs)||maxAgeMs<60000||b.t+60000>now+10000||now-(b.t+60000)>maxAgeMs))
    throw Error('Stale, future, or not-yet-closed bar: no automatic paper fill');
  if(s.lastBar!==null&&b.t<=s.lastBar)throw Error('Out-of-order or duplicate minute bar');
  const gap=s.lastBar===null?null:(b.t-s.lastBar)/60000;
  const prevClock=s.lastBar===null?null:nyTime(s.lastBar);
  const changed=s.day!==clock.day;
  if(changed){
    if(s.position){close(s,b,b.open,'OVERNIGHT_GAP')}
    s.day=clock.day;s.dayMinutes={};s.range=null;s.haltDay=null;s.queued=null;
    if(clock.minute>570&&clock.minute<960)s.haltDay=clock.day; // no mid-day bootstrapping
  }else if(gap!==null&&gap!==1&&prevClock?.day===clock.day&&prevClock.minute>=570&&prevClock.minute<960&&clock.minute>=570&&clock.minute<960){
    if(s.position)close(s,b,b.open,'MISSING_DATA_GAP');
    s.queued=null;s.haltDay=s.day;event(s,'DATA_GAP',b,{minutes:gap});
  }
  s.lastBar=b.t;s.lastPrice=b.close;s.source=source;s.barsSeen++;
  if(clock.minute<570||clock.minute>=960)return s;
  s.dayMinutes[clock.minute]=b;
  // Pending signal is executed on next bar OPEN, not the same bar CLOSE.
  if(s.queued){if(clock.minute-s.queued.signalMinute===1&&s.haltDay!==s.day)enter(s,b);else s.queued=null;}
  if(s.position){
    const p=s.position,buy=p.side==='BUY';
    // Next-open confirmation exit should occur BEFORE scanning that bar's high/low.
    if(p.confirmExit)close(s,b,b.open,'FAILED_CONFIRMATION');
    else if(buy?b.low<=p.stop:b.high>=p.stop)close(s,b,buy?Math.min(b.open,p.stop):Math.max(b.open,p.stop),'STOP');
    else if(buy?b.high>=p.target:b.low<=p.target)close(s,b,p.target,'TARGET');
    else if(clock.minute===959)close(s,b,b.close,'SESSION_CLOSE');
    else if((clock.minute+1-570)%15===0&&Math.floor((clock.minute-570)/15)===p.entryBlock &&
      !(buy?b.close>p.range.high:b.close<p.range.low))p.confirmExit=true;
  }
  if(clock.minute===599){
    const open=Array.from({length:30},(_,i)=>s.dayMinutes[570+i]);
    if(open.some(x=>!x)){s.haltDay=s.day;event(s,'RANGE_MISSING',b)}
    else{s.range={high:Math.max(...open.map(x=>x.high)),low:Math.min(...open.map(x=>x.low))};
      event(s,'RANGE_LOCKED',b,s.range)}
  }
  if(clock.minute<600||clock.minute>=690||s.haltDay===s.day||s.position||s.queued||
    s.closed.some(t=>t.day===s.day)||s.events.some(x=>x.type==='OPEN'&&nyTime(x.at).day===s.day))return s;
  if(!s.range)return s;
  const width=s.range.high-s.range.low;
  if(width<s.settings.minRangePoints||width>s.settings.maxRangePoints)return s;
  const side=b.close>s.range.high?'BUY':b.close<s.range.low?'SELL':null;
  if(!side)return s;
  // Confirmation is the CLOSE of a completed minute, with entry on next minute OPEN.
  s.queued={side,signalMinute:clock.minute,range:{...s.range}};
  event(s,'SIGNAL',b,{side,price:b.close,width});
  return s;
}
function summary(s){
  const closed=s.closed,won=closed.filter(x=>x.pnlUsd>0),lost=closed.filter(x=>x.pnlUsd<0);
  const gain=won.reduce((a,x)=>a+x.pnlUsd,0),loss=-lost.reduce((a,x)=>a+x.pnlUsd,0);
  const dayNet=closed.filter(x=>x.day===s.day).reduce((a,x)=>a+x.pnlUsd,0);
  const usdIls=s.settings.usdIls||null;
  return {paperOnly:true,brokerConnected:false,chartSymbol:'CME_MINI:NQ1!',contract:s.settings.contract,
    balanceUsd:s.balanceUsd,netUsd:round2(s.balanceUsd-s.settings.startingUsd),
    netIls:usdIls?round2((s.balanceUsd-s.settings.startingUsd)*usdIls):null,
    todayUsd:round2(dayNet),todayIls:usdIls?round2(dayNet*usdIls):null,
    targetIls:s.settings.dailyTargetIls,fxRateUsdIls:usdIls,
    targetMet:usdIls?dayNet*usdIls>=s.settings.dailyTargetIls:false,
    winRate:closed.length?round2(won.length/closed.length*100):null,trades:closed.length,
    profitFactor:loss?round2(gain/loss):null,maxDrawdownUsd:round2(s.maxDrawdownUsd),
    range:s.range,queued:s.queued,position:s.position,halted:s.day!==null&&s.haltDay===s.day,
    lastBar:s.lastBar?new Date(s.lastBar).toISOString():null,lastPrice:s.lastPrice,
    feed:s.source,events:s.events.slice(-70).reverse(),closed:s.closed.slice(-100).reverse()};
}
function replay(bars,opts={}){
  const s=state(opts);
  for(const bar of bars){const minute=nyTime(bar.t).minute;
    if(minute>=570&&minute<960)onBar(s,bar,{source:'historical-replay'});
  }
  if(s.position){throw Error('Replay ended with an unclosed position; supply full session data');}
  return {...summary(s),mode:'HISTORICAL_REPLAY',settings:s.settings};
}
module.exports={SETTINGS,settings,state,validBar,onBar,summary,replay};
