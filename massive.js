'use strict';
// Massive.com Futures Basic: FREE historical CME contract 1-minute OHLC, up to 5 req/min.
// Explicitly NOT a real-time/live execution feed. No proxy symbols and no scraping.
const ORIGIN='https://api.massive.com';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function contractTicker(ticker){
  if(!/^NQ[HMUZ]\d{1,2}$/.test(ticker))throw Error('Use an explicit NQ futures contract, e.g. NQZ6, NOT NQ1!/QQQ');
  return ticker;
}
function normalizeMassive(items,ticker){
  return items.map(x=>{
    if(x.ticker&&x.ticker!==ticker)throw Error('Provider contract mismatch '+x.ticker);
    // Nanosecond timestamps exceed Number.MAX_SAFE_INTEGER; parse without losing minute.
    const ns=BigInt(String(x.window_start));
    const ms=Number((ns+500000n)/1000000n); // tolerate JSON-number rounding below 1 ms
    if(!Number.isSafeInteger(ms)||ms%60000!==0)throw Error('Invalid provider minute timestamp');
    return {t:ms,open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)};
  });
}
class Massive {
  constructor(key=process.env.MASSIVE_API_KEY,http=fetch,delay=13000){
    if(!key)throw Error('MASSIVE_API_KEY is required for historical futures research');
    this.key=key;this.http=http;this.delay=delay;this.last=0;
  }
  async get(raw){
    const url=new URL(raw,ORIGIN);
    if(url.origin!==ORIGIN||!url.pathname.startsWith('/futures/v1/'))throw Error('Untrusted API pagination URL');
    url.searchParams.set('apiKey',this.key);
    const elapsed=Date.now()-this.last;
    if(this.last&&elapsed<this.delay)await sleep(this.delay-elapsed);
    this.last=Date.now();
    const response=await this.http(url.href,{signal:AbortSignal.timeout(20000)});
    if(!response.ok){
      const detail=await response.text();
      throw Error('Massive API '+response.status+': '+detail.slice(0,180));
    }
    const json=await response.json();
    if(!Array.isArray(json.results))throw Error('Invalid provider response');
    return json;
  }
  async discover(day){
    if(!/^\d{4}-\d\d-\d\d$/.test(day))throw Error('Use YYYY-MM-DD');
    const url=new URL('/futures/v1/contracts',ORIGIN);
    for(const [k,v] of Object.entries({product_code:'NQ',date:day,type:'single',limit:'100',sort:'ticker.asc'}))url.searchParams.set(k,v);
    const rows=(await this.get(url.href)).results;
    return rows.filter(x=>/^NQ[HMUZ]\d{1,2}$/.test(x.ticker||''))
      .sort((a,b)=>(a.days_to_maturity??9999)-(b.days_to_maturity??9999));
  }
  async bars(ticker,from,to,{maxPages=8}={}){
    contractTicker(ticker);
    if(!/^\d{4}-\d\d-\d\d$/.test(from)||!/^\d{4}-\d\d-\d\d$/.test(to)||from>to)throw Error('Use valid YYYY-MM-DD date range');
    if((Date.parse(to)-Date.parse(from))/86400000>35)throw Error('Request at most 35 days per download');
    const url=new URL('/futures/v1/aggs/'+ticker,ORIGIN);
    const nextDay=new Date(Date.parse(to+'T00:00:00Z')+86400000).toISOString().slice(0,10);
    for(const [k,v] of Object.entries({resolution:'1min','window_start.gte':from,'window_start.lt':nextDay,limit:'50000',sort:'window_start.asc'}))url.searchParams.set(k,v);
    let next=url.href,pages=0,rows=[];
    while(next){
      if(++pages>maxPages)throw Error('Too many pages: reduce date range');
      const response=await this.get(next);
      rows.push(...normalizeMassive(response.results,ticker));
      if(rows.length>150000)throw Error('Too many candles');
      next=response.next_url||null;
    }
    rows.sort((a,b)=>a.t-b.t);
    for(let i=1;i<rows.length;i++)if(rows[i].t===rows[i-1].t)throw Error('Duplicate minute from provider');
    return rows;
  }
}
function toCsv(bars){
  return ['timestamp,open,high,low,close,volume',...bars.map(b=>[new Date(b.t).toISOString(),b.open,b.high,b.low,b.close,b.volume].join(','))].join('\n')+'\n';
}
module.exports={Massive,contractTicker,normalizeMassive,toCsv};
