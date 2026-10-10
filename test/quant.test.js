'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {nyTime,parseCsv}=require('../market');const {CONTRACT,riskFor,backtest}=require('../strategy');const {createServer}=require('../server');
function dayCsv({day='2026-10-12',offset='13:30',signal='BUY',at=32,exit='STOP'}={}){
  // Known 2026-10-12 NY open corresponds to 13:30Z.
  const start=Date.parse(day+'T'+offset+':00Z');const rows=['timestamp,open,high,low,close'];
  for(let i=0;i<390;i++){
    let o=22000,h=22001,l=21999,c=22000;
    if(i===at){if(signal==='BUY'){c=22002;h=22002}else{c=21998;l=21998}}
    if(i===at+1){if(signal==='BUY'){o=22002;h=22003;l=22001;c=22002}else{o=21998;h=21999;l=21997;c=21998}}
    if(i===at+2){if(exit==='STOP'){if(signal==='BUY'){o=21995;l=21994;h=21996;c=21995}else{o=22005;l=22004;h=22006;c=22005}}else{if(signal==='BUY'){o=22006;h=22007;l=22005;c=22006}else{o=21994;l=21993;h=21995;c=21994}}}
    rows.push([new Date(start+i*60000).toISOString(),o,h,l,c].join(','));
  }
  return rows.join('\n');
}
test('NQ contract multipliers correct',()=>{assert.equal(CONTRACT.symbol,'CME_MINI:NQ1!');assert.equal(CONTRACT.pointValueUsd,20);assert.equal(riskFor({entry:22000,stop:21990,opts:{slippageTicksPerSide:0,roundTripFeeUsd:0}}),200)});
test('New York DST conversion',()=>{assert.equal(nyTime('2026-10-12T13:30:00Z').minute,570);assert.equal(nyTime('2026-12-14T14:30:00Z').minute,570)});
test('CSV validates timezone',()=>assert.throws(()=>parseCsv('timestamp,open,high,low,close\n2026-10-12T13:30:00,22000,22001,21999,22000'),/timezone|offset|Z/));
test('CSV rejects tick invalid price',()=>assert.throws(()=>parseCsv('timestamp,open,high,low,close\n2026-10-12T13:30:00Z,22000.1,22001,21999,22000'),/tick/));
test('CSV rejects duplicate time',()=>{const r='2026-10-12T13:30:00Z,22000,22001,21999,22000';assert.throws(()=>parseCsv('timestamp,open,high,low,close\n'+r+'\n'+r),/Duplicate/)});
test('NQ small risk budget results no forced trades',()=>{const r=backtest(parseCsv(dayCsv()));assert.equal(r.stats.trades,0);assert.ok(r.stats.skips.risk>0)});
test('NQ breakout BUY trades at next bar open, stop gap worse',()=>{const r=backtest(parseCsv(dayCsv()),{riskUsd:300});assert.equal(r.stats.trades,1);assert.equal(r.trades[0].side,'BUY');assert.equal(r.trades[0].reason,'STOP');assert.ok(r.trades[0].pnlUsd<0);assert.ok(r.trades[0].entryAt.endsWith('14:03:00.000Z'))});
test('NQ breakout SELL and opposite stop',()=>{const r=backtest(parseCsv(dayCsv({signal:'SELL'})),{riskUsd:300});assert.equal(r.stats.trades,1);assert.equal(r.trades[0].side,'SELL');assert.equal(r.trades[0].reason,'STOP');assert.ok(r.trades[0].pnlUsd<0)});
test('NQ positive target win',()=>{const r=backtest(parseCsv(dayCsv({exit:'TARGET'})),{riskUsd:300});assert.equal(r.stats.trades,1);assert.equal(r.trades[0].reason,'TARGET');assert.ok(r.trades[0].pnlUsd>0)});
test('incomplete sessions are skipped, not filled',()=>{const rows=dayCsv().split('\n');rows.splice(15,1);const r=backtest(parseCsv(rows.join('\n')),{riskUsd:300});assert.equal(r.stats.completeSessions,0);assert.equal(r.stats.trades,0);assert.equal(r.stats.skips.incomplete,1)});
test('parameter bounds reject negative slippage',()=>assert.throws(()=>backtest([],{slippageTicksPerSide:-1}),/Invalid/));
test('server status explicitly reports no live feed or trading',async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{const res=await fetch('http://127.0.0.1:'+server.address().port+'/api/status');const j=await res.json();assert.equal(j.paperOnly,true);assert.equal(j.liveFeed,false);assert.equal(j.instrument.symbol,'CME_MINI:NQ1!')}finally{await new Promise(resolve=>server.close(resolve))}});
