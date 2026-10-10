'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parseCsv}=require('./market');
const {backtest,CONTRACT,DEFAULTS}=require('./strategy');
const {state,settings,onBar,summary,replay}=require('./engine');
const {Massive,toCsv}=require('./massive');
const PORT=Number(process.env.PORT||3000),HOST=process.env.HOST||'127.0.0.1';
const DIR=path.join(__dirname,'data'),STATE=path.join(DIR,'paper.json'),BACKTEST=path.join(DIR,'last-backtest.json'),REPLAY=path.join(DIR,'last-replay.json');
const WEB=path.join(__dirname,'public','index.html');
function safeEqual(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y)}
function authorized(req,res){const pass=process.env.DASHBOARD_PASSWORD;
  if(!pass)return true;
  const encoded=(req.headers.authorization||'').replace(/^Basic\s+/i,'');
  if(safeEqual(encoded,Buffer.from('quant:'+pass).toString('base64')))return true;
  res.writeHead(401,{'WWW-Authenticate':'Basic realm="Quant Paper"'});res.end('Unauthorized');return false;
}
function respond(res,status,data,type='application/json'){
  res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
    'Content-Security-Policy':"default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"});
  res.end(type==='application/json'?JSON.stringify(data):data);
}
function body(req,max=26000000){return new Promise((resolve,reject)=>{
  const parts=[];let size=0,rejected=false;
  req.on('data',buf=>{size+=buf.length;if(size>max&&!rejected){rejected=true;reject(Error('Body too large'));req.resume();}else if(!rejected)parts.push(buf)});
  req.on('end',()=>{if(!rejected)resolve(Buffer.concat(parts).toString('utf8'))});req.on('error',reject);
})}
function fileRead(file){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null}
function fileSave(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(data,null,2),{mode:0o600});fs.renameSync(temp,file)}
function currentState(){const saved=fileRead(STATE);if(!saved)return state();if(saved.version!==3)throw Error('Invalid on-disk paper state version');return saved}
const rate=new Map();
function restricted(request){
  const ip=request.socket.remoteAddress||'?';const now=Date.now();const entry=rate.get(ip)||[];
  const times=entry.filter(x=>now-x<60000);if(times.length>120)return true;
  times.push(now);rate.set(ip,times);if(rate.size>300)rate.clear();return false;
}
function createServer(){return http.createServer(async(req,res)=>{
  if(!authorized(req,res))return;
  try{
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/api/health')return respond(res,200,{ok:true,version:3});
    if(req.method==='GET'&&url.pathname==='/api/status'){
      const s=currentState();return respond(res,200,{...summary(s),instrument:CONTRACT,historicalSource:'Massive Futures Basic or CSV',
        feedEndpointEnabled:Boolean(process.env.PAPER_AUTOMATION_ENABLED==='true'&&process.env.FEED_TOKEN&&process.env.PAPER_CONTRACT_TICKER),
        actualLiveQuoteVerified:false,liveFeed:false,mode:'LOCAL_PAPER_SIMULATOR',dailyTargetGuaranteed:false,
        message:'An authenticated fresh 1-minute futures feed is REQUIRED for automatic intraday paper trading.'});
    }
    if(req.method==='GET'&&url.pathname==='/api/backtest')return respond(res,200,fileRead(BACKTEST));
    if(req.method==='GET'&&url.pathname==='/api/replay')return respond(res,200,fileRead(REPLAY));
    if(req.method==='POST'&&url.pathname==='/api/backtest'){
      if(!/^text\/csv\b/i.test(req.headers['content-type']||''))return respond(res,415,{error:'Use text/csv'});
      if(restricted(req))return respond(res,429,{error:'Too many requests'});
      const opts={};for(const key of Object.keys(DEFAULTS))if(url.searchParams.has(key))opts[key]=Number(url.searchParams.get(key));
      const result=backtest(parseCsv(await body(req)),opts);fileSave(BACKTEST,result);return respond(res,200,result);
    }
    if(req.method==='POST'&&url.pathname==='/api/replay'){
      if(!/^text\/csv\b/i.test(req.headers['content-type']||''))return respond(res,415,{error:'Use text/csv'});
      if(restricted(req))return respond(res,429,{error:'Too many requests'});
      const opts={};const proto=state().settings;
      for(const k of Object.keys(proto))if(url.searchParams.has(k))opts[k]=k==='contract'?url.searchParams.get(k):Number(url.searchParams.get(k));
      const results=replay(parseCsv(await body(req)),settings(opts));
      fileSave(REPLAY,results);return respond(res,200,results);
    }
    if(req.method==='POST'&&url.pathname==='/api/feed/bar'){
      if(process.env.PAPER_AUTOMATION_ENABLED!=='true'||!process.env.FEED_TOKEN||!process.env.PAPER_CONTRACT_TICKER)
        return respond(res,403,{error:'Feed not configured; paper runner disabled'});
      if(restricted(req))return respond(res,429,{error:'Too many requests'});
      if(!safeEqual(req.headers['x-quant-feed-token'],process.env.FEED_TOKEN))return respond(res,401,{error:'Invalid feed token'});
      if(!/^application\/json\b/i.test(req.headers['content-type']||''))return respond(res,415,{error:'JSON required'});
      const incoming=JSON.parse(await body(req,16384));
      if(incoming.contract!==process.env.PAPER_CONTRACT_TICKER || !/^NQ[HMUZ]\d{1,2}$/.test(incoming.contract))
        return respond(res,400,{error:'Expected explicitly pinned dated NQ contract ticker (NQZ6 etc.)'});
      const old=currentState();const at=Date.now();
      onBar(old,incoming.bar,{source:'authenticated-external-futures-feed ('+incoming.contract+')',maxAgeMs:120000,now:at});
      fileSave(STATE,old);
      return respond(res,200,{accepted:true,lastBar:new Date(old.lastBar).toISOString(),paper:summary(old)});
    }
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html'))
      return respond(res,200,fs.readFileSync(WEB,'utf8'),'text/html');
    respond(res,404,{error:'Not found'});
  }catch(error){respond(res,400,{error:String(error.message||'Invalid request').slice(0,240)})}
})}
if(require.main===module){if(!Number.isInteger(PORT)||PORT<1||PORT>65535)throw Error('Invalid port');
  createServer().listen(PORT,HOST,()=>console.log(`Quant v3 on http://${HOST}:${PORT} — CME NQ only | historical replay + paper simulator | NO real orders`));}
module.exports={createServer};
