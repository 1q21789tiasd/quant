'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {state,onBar,summary,replay,validBar}=require('../engine');
const {Massive,normalizeMassive,contractTicker}=require('../massive');
const {createServer}=require('../server');
const base=Date.parse('2026-10-12T13:30:00Z');
const bar=(i,{open=22000,high=22001,low=21999,close=22000}={})=>({t:base+i*60000,open,high,low,close});
function feedTo(s,finish,mods={},source='test'){
  for(let i=s.barsSeen;i<=finish;i++)onBar(s,bar(i,mods[i]||{}),{source});
}
test('official NQ tick validation, bad candles and duplicate rejection',()=>{
  assert.throws(()=>validBar(bar(0,{open:22000.1})),/quarter-point/);
  assert.throws(()=>validBar(bar(0,{low:22002})),/OHLC/);
  const s=state();onBar(s,bar(0));assert.throws(()=>onBar(s,bar(0)),/duplicate/);
});
test('complete opening range locked after 30 1-minute candles',()=>{
  const s=state();feedTo(s,29);assert.deepEqual(s.range,{high:22001,low:21999});
  assert.equal(s.position,null);
});
test('paper long signal next minute open, stop gap and fee included',()=>{
  const s=state({riskUsd:200,slippageTicks:0,feePerSideUsd:0});feedTo(s,29);
  onBar(s,bar(30,{open:22000,high:22002,low:22000,close:22002}));
  assert.equal(s.queued.side,'BUY');assert.equal(s.position,null);
  onBar(s,bar(31,{open:22002,high:22003,low:22001,close:22002}));
  assert.equal(s.position.side,'BUY');assert.equal(s.position.entryAt,'2026-10-12T14:01:00.000Z');
  onBar(s,bar(32,{open:21990,high:21991,low:21989,close:21990}));
  assert.equal(s.closed.length,1);assert.equal(s.closed[0].reason,'STOP');
  assert.equal(s.closed[0].exit,21990);assert.equal(s.closed[0].pnlUsd,-240);
});
test('entry skipped when risk budget below full NQ contract',()=>{
  const s=state({riskUsd:15});feedTo(s,29);
  onBar(s,bar(30,{open:22000,high:22002,low:22000,close:22002}));
  onBar(s,bar(31,{open:22002,high:22003,low:22001,close:22002}));
  assert.equal(s.position,null);assert.equal(s.closed.length,0);
  assert.ok(s.events.some(x=>x.type==='RISK_REJECT'));
});
test('long target and only one position per day',()=>{
  const s=state({riskUsd:300,slippageTicks:0,feePerSideUsd:0});feedTo(s,29);
  onBar(s,bar(30,{open:22000,high:22002,low:22000,close:22002}));
  onBar(s,bar(31,{open:22002,high:22003,low:22001,close:22002}));
  onBar(s,bar(32,{open:22005,high:22006,low:22004,close:22005}));
  assert.equal(s.closed.length,1);assert.equal(s.closed[0].reason,'TARGET');
  onBar(s,bar(33,{open:22004,high:22007,low:22003,close:22007}));
  assert.equal(s.position,null);assert.equal(s.closed.length,1);
});
test('short signal and stop on high',()=>{
  const s=state({riskUsd:300,slippageTicks:0,feePerSideUsd:0});feedTo(s,29);
  onBar(s,bar(30,{open:22000,high:22000,low:21998,close:21998}));
  onBar(s,bar(31,{open:21998,high:21999,low:21997,close:21998}));
  assert.equal(s.position.side,'SELL');
  onBar(s,bar(32,{open:22005,high:22006,low:22004,close:22005}));
  assert.equal(s.closed[0].reason,'STOP');assert.ok(s.closed[0].pnlUsd<0);
});
test('gap during session halts entries',()=>{
  const s=state({riskUsd:300});feedTo(s,20);
  onBar(s,bar(22));assert.equal(s.haltDay,'2026-10-12');
  for(let i=23;i<=30;i++)onBar(s,bar(i));assert.equal(s.range,null);
});
test('feed freshness rejects stale and future bars',()=>{
  const s=state();assert.throws(()=>onBar(s,bar(0),{maxAgeMs:120000,now:Date.parse('2026-10-12T15:30:00Z')}),/Stale/);
  assert.throws(()=>onBar(s,bar(0),{maxAgeMs:120000,now:base-60000}),/future|not-yet-closed/i);
});
test('restart recovery preserves trade state by JSON',()=>{
  const s=state({riskUsd:300});feedTo(s,29);onBar(s,bar(30,{open:22000,high:22002,low:22000,close:22002}));
  const copy=JSON.parse(JSON.stringify(s));onBar(copy,bar(31,{open:22002,high:22003,low:22001,close:22002}));
  assert.equal(copy.position.side,'BUY');
});
test('USD/ILS target is only a metric, not a forced trade',()=>{
  const s=state({usdIls:3.8,dailyTargetIls:50});const out=summary(s);
  assert.equal(out.targetIls,50);assert.equal(out.todayIls,0);assert.equal(out.targetMet,false);assert.equal(s.position,null);
});
test('replay deterministic with 390 1m candles',()=>{
  const data=Array.from({length:390},(_,i)=>bar(i));
  data[30]=bar(30,{open:22000,high:22002,low:22000,close:22002});
  data[31]=bar(31,{open:22002,high:22003,low:22001,close:22002});
  data[32]=bar(32,{open:22005,high:22006,low:22004,close:22005});
  const a=replay(data,{riskUsd:300,slippageTicks:0,feePerSideUsd:0});
  const b=replay(data,{riskUsd:300,slippageTicks:0,feePerSideUsd:0});
  assert.equal(a.trades,1);assert.equal(a.closed[0].reason,'TARGET');assert.deepEqual(a,b);
});
test('Massive nanosecond OHLC maps without precision loss',()=>{
  const rows=normalizeMassive([{ticker:'NQZ6',window_start:'1791811800000000000',open:22000,high:22001,low:21999,close:22000}],'NQZ6');
  assert.equal(rows[0].t,1791811800000);assert.throws(()=>contractTicker('NQ1!'),/dated|explicit/i);
});
test('Massive historical adapter refuses untrusted pagination and rate limits',async()=>{
  let calls=0;
  const api=new Massive('test',async url=>{
    calls++;const u=new URL(url);assert.equal(u.searchParams.get('apiKey'),'test');
    return {ok:true,json:async()=>({results:[{ticker:'NQZ6',window_start:'1791811800000000000',open:22000,high:22001,low:21999,close:22000}],next_url:'https://attacker.invalid/page'})};
  },0);
  await assert.rejects(api.bars('NQZ6','2026-10-01','2026-10-02'),/Untrusted/);assert.equal(calls,1);
});
test('HTTP app exposes paper status but refuses unauthorized live feed',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const root='http://127.0.0.1:'+server.address().port;
    const s=await (await fetch(root+'/api/status')).json();assert.equal(s.paperOnly,true);assert.equal(s.chartSymbol,'CME_MINI:NQ1!');
    const post=await fetch(root+'/api/feed/bar',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    assert.equal(post.status,403);
  }finally{await new Promise(resolve=>server.close(resolve))}
});
test('HTTP CSV paper replay reports actual simulated closed trade',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const root='http://127.0.0.1:'+server.address().port;
    const values=Array.from({length:390},(_,i)=>bar(i));
    values[30]=bar(30,{open:22000,high:22002,low:22000,close:22002});
    values[31]=bar(31,{open:22002,high:22003,low:22001,close:22002});
    values[32]=bar(32,{open:22005,high:22006,low:22004,close:22005});
    const csv='timestamp,open,high,low,close\n'+values.map(b=>[new Date(b.t).toISOString(),b.open,b.high,b.low,b.close].join(',')).join('\n');
    const response=await fetch(root+'/api/replay?riskUsd=300&slippageTicks=0&feePerSideUsd=0',{
      method:'POST',headers:{'content-type':'text/csv'},body:csv});
    const report=await response.json();
    assert.equal(response.status,200,JSON.stringify(report));assert.equal(report.trades,1);
    assert.equal(report.closed[0].reason,'TARGET');assert.equal(report.mode,'HISTORICAL_REPLAY');
  }finally{await new Promise(resolve=>server.close(resolve))}
});
test('MNQ changes multiplier, never changes NQ1 chart symbol',()=>{
  const s=state({contract:'MNQ',riskUsd:30,slippageTicks:0,feePerSideUsd:0});feedTo(s,29);
  onBar(s,bar(30,{open:22000,high:22002,low:22000,close:22002}));
  onBar(s,bar(31,{open:22002,high:22003,low:22001,close:22002}));
  assert.equal(s.position.contracts,1);assert.equal(s.position.estimatedRiskUsd,6);
  assert.equal(summary(s).chartSymbol,'CME_MINI:NQ1!');
});
test('fresh empty ledger is not incorrectly halted by null day',()=>assert.equal(summary(state()).halted,false));
test('Massive nanosecond numeric timestamp survives JSON number precision loss',()=>{
  const rows=normalizeMassive([{ticker:'NQZ6',window_start:Number('1791811800000000000'),open:22000,high:22001,low:21999,close:22000}],'NQZ6');
  assert.equal(rows[0].t,1791811800000);
});
