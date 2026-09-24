function num(v){ return Number(v) || 0; }

function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a,b)=>a+b,0) / period;
}

function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let e = values[0];
  return values.map((v, i) => {
    if (i === 0) return e;
    e = v * k + e * (1 - k);
    return e;
  });
}

function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i-1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i-1];
    avgGain = (avgGain * (period - 1) + Math.max(d,0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d,0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i=1;i<candles.length;i++) {
    const c=candles[i], p=candles[i-1];
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close)));
  }
  let a = trs.slice(0,period).reduce((x,y)=>x+y,0)/period;
  for(let i=period;i<trs.length;i++) a=(a*(period-1)+trs[i])/period;
  return a;
}

function macd(values) {
  if (values.length < 35) return { macd:null, signal:null, histogram:null };
  const fast=emaSeries(values,12), slow=emaSeries(values,26);
  const line=values.map((_,i)=>fast[i]-slow[i]);
  const sig=emaSeries(line.slice(25),9);
  const m=line[line.length-1], s=sig[sig.length-1];
  return { macd:m, signal:s, histogram:m-s };
}

function adx(candles, period=14) {
  if(candles.length < period*2+2) return null;
  const tr=[], plusDM=[], minusDM=[];
  for(let i=1;i<candles.length;i++){
    const c=candles[i],p=candles[i-1];
    tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));
    const up=c.high-p.high, down=p.low-c.low;
    plusDM.push(up>down&&up>0?up:0);
    minusDM.push(down>up&&down>0?down:0);
  }
  let tr14=tr.slice(0,period).reduce((a,b)=>a+b,0);
  let p14=plusDM.slice(0,period).reduce((a,b)=>a+b,0);
  let m14=minusDM.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  for(let i=period;i<tr.length;i++){
    tr14=tr14-tr14/period+tr[i];
    p14=p14-p14/period+plusDM[i];
    m14=m14-m14/period+minusDM[i];
    const pdi=tr14?100*p14/tr14:0,mmdi=tr14?100*m14/tr14:0;
    const den=pdi+mmdi;
    dx.push(den?100*Math.abs(pdi-mmdi)/den:0);
  }
  if(dx.length<period) return null;
  let value=dx.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<dx.length;i++) value=(value*(period-1)+dx[i])/period;
  return value;
}

function vwap(candles, maxBars = 78) {
  const arr=candles.slice(-maxBars);
  let pv=0,vol=0;
  for(const c of arr){
    const tp=(c.high+c.low+c.close)/3;
    pv+=tp*c.volume;vol+=c.volume;
  }
  return vol?pv/vol:null;
}

function relativeVolume(candles, period=20) {
  if(candles.length<period+1) return null;
  const current=candles[candles.length-1].volume;
  const base=candles.slice(-(period+1),-1).reduce((s,c)=>s+c.volume,0)/period;
  return base?current/base:null;
}

function swings(candles, radius=2) {
  const highs=[],lows=[];
  for(let i=radius;i<candles.length-radius;i++){
    const c=candles[i];
    let isH=true,isL=true;
    for(let j=i-radius;j<=i+radius;j++){
      if(j===i)continue;
      if(candles[j].high>=c.high)isH=false;
      if(candles[j].low<=c.low)isL=false;
    }
    if(isH)highs.push({price:c.high,ts:c.ts});
    if(isL)lows.push({price:c.low,ts:c.ts});
  }
  return { highs, lows };
}

function structure(candles) {
  const s=swings(candles.slice(-120),2);
  const hs=s.highs.slice(-2),ls=s.lows.slice(-2);
  let state="mixed";
  if(hs.length===2&&ls.length===2){
    if(hs[1].price>hs[0].price&&ls[1].price>ls[0].price)state="higher highs / higher lows";
    else if(hs[1].price<hs[0].price&&ls[1].price<ls[0].price)state="lower highs / lower lows";
    else state="mixed structure";
  }
  return { state, lastSwingHigh:s.highs.at(-1)?.price||null, lastSwingLow:s.lows.at(-1)?.price||null };
}

function levels(candles, price) {
  const s=swings(candles.slice(-180),2);
  const supports=[...new Set(s.lows.map(x=>x.price).filter(x=>x<price).sort((a,b)=>b-a).slice(0,4).map(x=>Number(x.toFixed(2))))];
  const resistances=[...new Set(s.highs.map(x=>x.price).filter(x=>x>price).sort((a,b)=>a-b).slice(0,4).map(x=>Number(x.toFixed(2))))];
  return { support:supports, resistance:resistances };
}

function trendFrom(close, e20, e50, e200) {
  if(e20&&e50&&e200){
    if(close>e20&&e20>e50&&e50>e200)return"bullish";
    if(close<e20&&e20<e50&&e50<e200)return"bearish";
  }
  if(e50&&close>e50)return"bullish";
  if(e50&&close<e50)return"bearish";
  return"neutral";
}

function summarize(candles) {
  const closes=candles.map(c=>c.close);
  const current=candles.at(-1)?.close||0;
  const e20=ema(closes,20),e50=ema(closes,50),e200=ema(closes,200);
  const r=rsi(closes,14),a=atr(candles,14),m=macd(closes),x=adx(candles,14),v=vwap(candles),rv=relativeVolume(candles,20);
  const str=structure(candles),lev=levels(candles,current);
  return {
    price:current,
    trend:trendFrom(current,e20,e50,e200),
    ema20:e20, ema50:e50, ema200:e200,
    rsi14:r, atr14:a,
    macd:m.macd, macdSignal:m.signal, macdHistogram:m.histogram,
    adx14:x, vwap:v, relativeVolume:rv,
    structure:str.state,
    lastSwingHigh:str.lastSwingHigh,
    lastSwingLow:str.lastSwingLow,
    support:lev.support,
    resistance:lev.resistance,
    bars:candles.length
  };
}

module.exports={sma,ema,rsi,atr,macd,adx,vwap,relativeVolume,structure,levels,summarize};
