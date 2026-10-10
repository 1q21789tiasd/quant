'use strict';
const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {parseCsv}=require('./market');const {backtest,CONTRACT,DEFAULTS}=require('./strategy');
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
const assets=path.join(__dirname,'public');const saved=path.join(__dirname,'data','last-backtest.json');
const maxBody=26000000; // ~26 MB of 1m CSV
function respond(res,status,body,contentType='application/json'){
  res.writeHead(status,{'Content-Type':contentType+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
  res.end(contentType==='application/json'?JSON.stringify(body):body);
}
function authOk(req,res){
  const password=process.env.DASHBOARD_PASSWORD;
  if(!password)return true;
  const expected=Buffer.from('quant:'+password).toString('base64');
  const got=(req.headers.authorization||'').replace(/^Basic\s+/i,'');
  const a=Buffer.from(got),b=Buffer.from(expected);
  if(a.length===b.length&&crypto.timingSafeEqual(a,b))return true;
  res.writeHead(401,{'WWW-Authenticate':'Basic realm="Quant NQ"'});res.end('Authentication required');return false;
}
function receive(req){return new Promise((resolve,reject)=>{
  let length=0,chunks=[];
  req.on('data',chunk=>{length+=chunk.length;if(length>maxBody){reject(new Error('CSV too large'));req.destroy();}else chunks.push(chunk)});
  req.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));req.on('error',reject);
});}
function createServer(){return http.createServer(async(req,res)=>{
  if(!authOk(req,res))return;
  try {
    const url=new URL(req.url,'http://localhost');
    if(req.method==='GET'&&url.pathname==='/api/status')return respond(res,200,{instrument:CONTRACT,defaults:DEFAULTS,paperOnly:true,liveFeed:false,source:'CSV_UPLOAD_ONLY'});
    if(req.method==='GET'&&url.pathname==='/api/results')return respond(res,200,fs.existsSync(saved)?JSON.parse(fs.readFileSync(saved,'utf8')):null);
    if(req.method==='POST'&&url.pathname==='/api/backtest'){
      // Use text/csv body to avoid copy/paste huge JSON; optional settings in query string.
      if(!/^text\/csv(?:;|$)/i.test(req.headers['content-type']||''))return respond(res,415,{error:'Use Content-Type: text/csv'});
      const params={};for(const key of Object.keys(DEFAULTS))if(url.searchParams.has(key))params[key]=Number(url.searchParams.get(key));
      const report=backtest(parseCsv(await receive(req)),params);
      fs.mkdirSync(path.dirname(saved),{recursive:true});
      const tmp=saved+'.tmp';fs.writeFileSync(tmp,JSON.stringify(report,null,2));fs.renameSync(tmp,saved);
      return respond(res,200,report);
    }
    if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html'))return respond(res,200,fs.readFileSync(path.join(assets,'index.html'),'utf8'),'text/html');
    if(req.method==='GET'&&url.pathname==='/api/health')return respond(res,200,{ok:true});
    respond(res,404,{error:'Not found'});
  }catch(err){respond(res,400,{error:err.message||'Invalid request'})}
});}
if(require.main===module){if(!Number.isInteger(port)||port<1||port>65535)throw Error('PORT must be 1..65535');createServer().listen(port,host,()=>console.log(`Quant NQ research on http://${host}:${port} | no live orders | no real-time data`));}
module.exports={createServer};
