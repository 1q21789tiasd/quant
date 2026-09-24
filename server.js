require("dotenv").config();
const express=require("express");
const path=require("path");
const config=require("./config");
const db=require("./db");
const broker=require("./paperBroker");
const watcher=require("./watcher");
const reporter=require("./reporter");
const events=require("./eventBus");

const app=express();
app.disable("x-powered-by");
app.use(express.json({limit:"1mb"}));

if(config.DASHBOARD_PASSWORD){
  app.use((req,res,next)=>{
    if(req.path==="/api/health")return next();
    const auth=req.headers.authorization||"";
    if(auth.startsWith("Basic ")){
      try{
        const decoded=Buffer.from(auth.slice(6),"base64").toString("utf8");
        const idx=decoded.indexOf(":");
        const user=decoded.slice(0,idx),pass=decoded.slice(idx+1);
        if(user==="quant"&&pass===config.DASHBOARD_PASSWORD)return next();
      }catch{}
    }
    res.set("WWW-Authenticate",'Basic realm="Quant"');
    return res.status(401).send("Authentication required");
  });
}

app.use("/charts",express.static(config.CHART_DIR,{maxAge:"30m"}));
app.use(express.static(path.join(__dirname,"public")));

app.get("/api/health",(_req,res)=>res.json({ok:true,service:"quant"}));

function snapshotState(){
  const snap=db.latestSnapshot();
  const price=snap?.price||null;
  const account=broker.accountSnapshot(price);
  const openPosition=db.getOpenPosition();
  const cycle=db.latestCycle();
  const reports=db.listDailyReports(1);
  return {
    watcher:watcher.getStatus(),
    account,
    openPosition,
    latestSnapshot:snap?{
      id:snap.id,ts:snap.ts,symbol:snap.symbol,price:snap.price,chartPath:snap.chart_path,
      frames:snap.data?.frames||{}
    }:null,
    latestCycle:cycle?{
      id:cycle.id,ts:cycle.ts,status:cycle.status,trigger:cycle.trigger,
      summary:cycle.summary,confidence:cycle.confidence,decision:cycle.decision,error:cycle.error
    }:null,
    today:reports[0]||null,
    limits:{
      leverage:config.LEVERAGE,
      maxMarginPerTradeNis:config.MAX_MARGIN_PER_TRADE_NIS,
      maxRiskPerTradeNis:config.MAX_RISK_PER_TRADE_NIS,
      maxDailyLossNis:config.MAX_DAILY_LOSS_NIS,
      dailyBenchmarkNis:config.DAILY_BENCHMARK_NIS,
      cycleMinutes:config.CYCLE_MINUTES
    }
  };
}

app.get("/api/state",(_req,res)=>res.json(snapshotState()));
app.get("/api/cycles",(req,res)=>res.json({items:db.listCycles(req.query.limit)}));
app.get("/api/actions",(req,res)=>res.json({items:db.listActions(req.query.limit)}));
app.get("/api/trades",(req,res)=>res.json({items:db.listPositions(req.query.limit),events:db.listPositionEvents(200)}));
app.get("/api/reports",(req,res)=>res.json({items:db.listDailyReports(req.query.limit)}));
app.get("/api/events",(req,res)=>res.json({items:db.listSystemEvents(req.query.limit)}));

app.get("/api/stream",(req,res)=>{
  res.set({
    "Content-Type":"text/event-stream",
    "Cache-Control":"no-cache",
    Connection:"keep-alive"
  });
  res.flushHeaders();
  res.write("event: ready\ndata: {}\n\n");
  const unsub=events.subscribe(evt=>{
    res.write("event: update\ndata: "+JSON.stringify(evt)+"\n\n");
  });
  const ping=setInterval(()=>res.write(": ping\n\n"),20000);
  req.on("close",()=>{clearInterval(ping);unsub()});
});

app.post("/api/control/run",async(_req,res)=>{
  try{
    const result=await watcher.runCycle("manual");
    res.json({ok:true,cycleId:result.cycleId});
  }catch(error){
    res.status(409).json({ok:false,message:"Cycle could not be completed"});
  }
});
app.post("/api/control/pause",(_req,res)=>{watcher.pause();res.json({ok:true})});
app.post("/api/control/resume",(_req,res)=>{watcher.resume();res.json({ok:true})});
app.post("/api/control/reset",(req,res)=>{
  if(req.body?.confirm!=="RESET")return res.status(400).json({ok:false,message:"Confirmation required"});
  broker.reset();
  res.json({ok:true});
});

app.get("/",(_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.use((err,req,res,next)=>{
  console.error("[QUANT]",err);
  if(res.headersSent)return next(err);
  res.status(500).json({ok:false,message:"Quant could not complete the request"});
});

app.listen(config.PORT,"0.0.0.0",()=>{
  console.log("Quant running on 0.0.0.0:"+config.PORT);
});
