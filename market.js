'use strict';
const nyFormatter = new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
function nyTime(timestamp) {
  const parts = Object.fromEntries(nyFormatter.formatToParts(new Date(timestamp)).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,minute:Number(parts.hour)*60+Number(parts.minute)};
}
const REQUIRED = ['timestamp','open','high','low','close'];
function parseCsv(csv, {maxRows=250000}={}) {
  if (typeof csv !== 'string' || csv.length > 26000000) throw Error('CSV missing or too large (26 MB max)');
  const lines = csv.replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw Error('CSV needs a header and candle rows');
  if (lines.length - 1 > maxRows) throw Error(`CSV exceeds ${maxRows} rows`);
  const columns = lines[0].toLowerCase().split(',').map(x=>x.trim());
  if (REQUIRED.some(x=>!columns.includes(x))) throw Error('Required CSV columns: timestamp,open,high,low,close (optional volume)');
  const idx = Object.fromEntries(columns.map((c,i)=>[c,i]));
  const bars=[];
  for(let k=1;k<lines.length;k++) {
    const fields=lines[k].split(',').map(x=>x.trim());
    const iso=fields[idx.timestamp];
    // Reject ambiguous local timestamps. Explicit Z or UTC offset required.
    if(!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(iso||'')) throw Error(`Row ${k+1}: timestamp must contain Z or UTC offset`);
    const ms=Date.parse(iso.replace(' ','T'));
    if(!Number.isFinite(ms)||ms%60000!==0) throw Error(`Row ${k+1}: invalid or non-minute timestamp`);
    const values=REQUIRED.slice(1).map(c=>Number(fields[idx[c]]));
    if(values.some((n,i)=>!fields[idx[REQUIRED[i+1]]] || !Number.isFinite(n) || n<=0)) throw Error(`Row ${k+1}: invalid OHLC`);
    const [o,h,l,c]=values;
    if (l>Math.min(o,c)||h<Math.max(o,c)||l>h) throw Error(`Row ${k+1}: OHLC inconsistent`);
    if ([o,h,l,c].some(v => Math.abs(v*4-Math.round(v*4))>1e-7)) throw Error(`Row ${k+1}: NQ price must align to 0.25 tick`);
    bars.push({t:ms,open:o,high:h,low:l,close:c});
  }
  bars.sort((a,b)=>a.t-b.t);
  for (let i=1;i<bars.length;i++) if (bars[i].t===bars[i-1].t) throw Error(`Duplicate minute: ${new Date(bars[i].t).toISOString()}`);
  return bars;
}
function nySessions(bars){
  const grouped=new Map();
  for(const b of bars){const {day,minute}=nyTime(b.t);if(minute<570||minute>=960)continue;const g=grouped.get(day)||new Map();g.set(minute,b);grouped.set(day,g)}
  return grouped;
}
module.exports={nyTime,parseCsv,nySessions};
