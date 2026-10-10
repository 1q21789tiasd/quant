#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs=require('node:fs'),path=require('node:path');
const {AlpacaMarket}=require('./market');
const {ny,openingRange,createLedger,step}=require('./paper');
const symbols=(process.env.QUANT_V2_SYMBOLS||'QQQ,GLD').split(',').map(x=>x.trim().toUpperCase());
const stateFile=process.env.QUANT_V2_STATE_FILE||path.join(__dirname,'..','data','v2-paper.json');
const mode=process.argv[2];
const log=o=>console.log(JSON.stringify({time:new Date().toISOString(),...o}));
let active=false,calCache={day:null,result:null},market=null;
function load(){if(!fs.existsSync(stateFile))return createLedger();const s=JSON.parse(fs.readFileSync(stateFile,'utf8'));if(s.version!==2)throw new Error('Unsupported paper state version');return s;}
function save(s){fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile+'.tmp',JSON.stringify(s,null,2));fs.renameSync(stateFile+'.tmp',stateFile);}
async function tick(){
  if(active)return;active=true;
  try{
    market ||= new AlpacaMarket();
    const now=Date.now(), clock=ny(new Date(now).toISOString());
    if(calCache.day!==clock.day)calCache={day:clock.day,result:await market.calendar(clock.day)};
    const calendar=calCache.result;
    if(!calendar||clock.minute<570||clock.minute>=calendar.closeMinute+3){log({status:'market_closed'});return;}
    // One batched request/minute for both ETFs, comfortably under the free 200 RPM.
    const all=await market.bars(symbols,new Date(now-21*3600000),new Date(now));
    const state=load(),tasks=[];
    for(const symbol of symbols){
      const current=all[symbol].filter(b=>ny(b.t).day===clock.day&&ny(b.t).minute>=570&&ny(b.t).minute<calendar.closeMinute&&Date.parse(b.t)+60000<=now);
      if(!current.length)continue;
      // On first start, remember the latest candle, but NEVER replay yesterday's or today's earlier trades.
      if(!state.lastBar[symbol]){state.lastBar[symbol]=current[current.length-1].t;state.events.push({type:'BOOTSTRAP',symbol,at:state.lastBar[symbol]});continue;}
      const opening=openingRange(current,clock.day);
      for(const bar of current)if(bar.t>state.lastBar[symbol])tasks.push({symbol,bar,opening});
    }
    tasks.sort((a,b)=>a.bar.t.localeCompare(b.bar.t)||a.symbol.localeCompare(b.symbol));
    const eventsBefore=state.events.length;
    for(const task of tasks){
      const last=state.lastBar[task.symbol];
      const gap=(Date.parse(task.bar.t)-Date.parse(last))/60000;
      const age=now-Date.parse(task.bar.t)-60000;
      step(state,task.symbol,task.bar,task.opening,{canEnter:gap>=1&&gap<=2&&age>=0&&age<150000,closeMinute:calendar.closeMinute});
    }
    state.updatedAt=new Date(now).toISOString();state.marketFeed='Alpaca IEX-only local paper';save(state);
    for(const event of state.events.slice(eventsBefore))log({paperEvent:event});
    log({status:'ok',processed:tasks.length,balanceUsd:Number(state.balanceUsd.toFixed(2)),openSymbol:state.position?.symbol||null,trades:state.trades.length});
  }catch(error){log({status:'error',reason:error.message});}
  finally{active=false;}
}
if(!['--once','--daemon'].includes(mode)||!symbols.length||symbols.length>10||symbols.some(s=>!/^[A-Z][A-Z0-9.]{0,9}$/.test(s))){
  console.error('Usage: node v2/runner.js --once|--daemon; configure QUANT_V2_SYMBOLS=QQQ,GLD');process.exitCode=2;
}else if(mode==='--once')tick();
else{tick();setInterval(tick,60000);}
