#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs=require('node:fs'),path=require('node:path');
const {AlpacaMarket}=require('./market');const {ny}=require('./paper');
async function main(){
  const symbol=(process.argv[2]||'QQQ').toUpperCase(),days=Number(process.argv[3]||45);
  if(!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)||!Number.isInteger(days)||days<1||days>365)throw new Error('Usage: node v2/export.js QQQ 45');
  const end=new Date(),start=new Date(end.getTime()-days*86400000);
  const bars=(await new AlpacaMarket().bars([symbol],start,end))[symbol].filter(b=>ny(b.t).minute>=570&&ny(b.t).minute<960);
  const csv=['timestamp,open,high,low,close,volume',...bars.map(b=>[b.t,b.o,b.h,b.l,b.c,b.v].join(','))].join('\n')+'\n';
  const filepath=path.join(__dirname,'..','data',symbol.toLowerCase()+'-iex-'+days+'d.csv');
  fs.mkdirSync(path.dirname(filepath),{recursive:true});fs.writeFileSync(filepath,csv);
  const counts={};for(const bar of bars){const day=ny(bar.t).day;counts[day]=(counts[day]||0)+1;}
  console.log(JSON.stringify({filepath,provider:'Alpaca IEX',minuteBars:bars.length,byDay:counts,warning:'IEX-only data can omit 1m bars; DO NOT interpolate missing candles.'},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
