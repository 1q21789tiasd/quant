#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Massive,toCsv}=require('../massive');
(async()=>{
  const [, ,cmd,one,two]=process.argv,api=new Massive();
  if(cmd==='discover'){
    const result=await api.discover(one);
    console.log(JSON.stringify({date:one,contracts:result.map(x=>({ticker:x.ticker,days_to_maturity:x.days_to_maturity,last_trade_date:x.last_trade_date})),
      warning:'Nearest expiry is not necessarily most liquid. Verify front-month & rollover before downloading.'},null,2));
  }else if(cmd&&one&&two){
    const bars=await api.bars(cmd,one,two);
    const dir=path.join(__dirname,'..','data');fs.mkdirSync(dir,{recursive:true});
    const dest=path.join(dir,cmd+'-'+one+'-'+two+'.csv');fs.writeFileSync(dest,toCsv(bars),{mode:0o600});
    console.log(JSON.stringify({file:dest,contract:cmd,bars:bars.length,source:'Massive Futures 8-hour-delayed Historical',
      warning:'NEVER feed these candles into a live paper engine as live execution prices.'},null,2));
  }else throw Error('Usage: node scripts/download.js discover 2026-10-09 OR node scripts/download.js NQZ6 2026-10-05 2026-10-09');
})().catch(e=>{console.error(e.message);process.exitCode=1});
