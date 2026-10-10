'use strict';
// Paper-account market-data adapter. It never submits any orders.
const DATA = 'https://data.alpaca.markets/v2/stocks/bars';
const CAL = 'https://paper-api.alpaca.markets/v2/calendar';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class AlpacaMarket {
  constructor(id=process.env.ALPACA_KEY_ID, secret=process.env.ALPACA_SECRET_KEY, http=fetch) {
    if (!id || !secret) throw new Error('Provide ALPACA_KEY_ID and ALPACA_SECRET_KEY from Alpaca Paper Only');
    this.http=http; this.headers={'APCA-API-KEY-ID':id,'APCA-API-SECRET-KEY':secret,Accept:'application/json'};
  }
  async get(url) {
    for(let attempt=0;attempt<3;attempt++) {
      const res=await this.http(url,{headers:this.headers,signal:AbortSignal.timeout(12000)});
      if(res.ok)return res.json();
      if([429,500,502,503,504].includes(res.status)&&attempt<2) {
        const header=Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(header)&&header>0&&header<20?header*1000:1000*(attempt+1));
        continue;
      }
      throw new Error('Alpaca HTTP '+res.status+': '+String(await res.text()).slice(0,180));
    }
  }
  async bars(symbols,start,end) {
    if(!Array.isArray(symbols)||!symbols.length||symbols.length>10||symbols.some(s=>!/^[A-Z][A-Z0-9.]{0,9}$/.test(s)))throw new Error('Invalid stock symbols');
    if(!(Date.parse(start)<Date.parse(end)))throw new Error('Invalid time range');
    const out=Object.fromEntries(symbols.map(s=>[s,[]]));let token=null,pages=0;
    do {
      if(++pages>50)throw new Error('Historical pagination guard exceeded');
      const u=new URL(DATA);
      for(const [k,v] of Object.entries({symbols:symbols.join(','),timeframe:'1Min',start:new Date(start).toISOString(),end:new Date(end).toISOString(),feed:'iex',adjustment:'raw',limit:'10000'}))u.searchParams.set(k,v);
      if(token)u.searchParams.set('page_token',token);
      const data=await this.get(u.href);
      for(const s of symbols)for(const b of data.bars?.[s]||[]) {
        const row={t:b.t,o:Number(b.o),h:Number(b.h),l:Number(b.l),c:Number(b.c),v:Number(b.v||0)};
        if(!Number.isFinite(Date.parse(row.t))||![row.o,row.h,row.l,row.c].every(x=>Number.isFinite(x)&&x>0)||row.l>Math.min(row.o,row.c)||row.h<Math.max(row.o,row.c))throw new Error('Invalid OHLC for '+s);
        out[s].push(row);
      }
      token=data.next_page_token||null;
    }while(token);
    for(const s of symbols){out[s].sort((a,b)=>a.t.localeCompare(b.t));for(let i=1;i<out[s].length;i++)if(out[s][i].t===out[s][i-1].t)throw new Error('Duplicate bar for '+s);}
    return out;
  }
  async calendar(day){
    if(!/^\d{4}-\d\d-\d\d$/.test(day))throw new Error('Invalid NY date');
    const u=new URL(CAL);u.searchParams.set('start',day);u.searchParams.set('end',day);
    const days=await this.get(u.href);
    const found=days.find(x=>x.date===day);
    if(!found)return null;
    const [hour,min]=found.close.split(':').map(Number);
    return {day,closeMinute:hour*60+min};
  }
}
module.exports={AlpacaMarket};
