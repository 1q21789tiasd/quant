const config=require("./config");
const db=require("./db");
const tradingView=require("./tradingView");
const {buildBloodline}=require("./bloodline");
const ai=require("./ai");
const broker=require("./paperBroker");
const reporter=require("./reporter");
const events=require("./eventBus");

const state={
  running:false,
  paused:!config.AUTO_START,
  inCycle:false,
  nextRunAt:null,
  lastCycleAt:null,
  lastError:null,
  timer:null,
  startupQueued:false
};

function publicStatus(){
  return {
    running:state.running,
    paused:state.paused,
    inCycle:state.inCycle,
    nextRunAt:state.nextRunAt,
    lastCycleAt:state.lastCycleAt,
    lastError:state.lastError
  };
}

function nextBoundary(){
  const now=Date.now();
  const step=config.CYCLE_MINUTES*60*1000;
  return new Date(Math.ceil((now+1000)/step)*step+5000);
}

function schedule(){
  if(state.timer)clearTimeout(state.timer);
  if(state.paused){state.nextRunAt=null;return}
  const next=nextBoundary();
  state.nextRunAt=next.toISOString();
  const delay=Math.max(1000,next.getTime()-Date.now());
  state.timer=setTimeout(async()=>{
    await runCycle("scheduled").catch(()=>{});
    schedule();
  },delay);
  events.emit("watcher",publicStatus());
}

function protectiveCandle(capture){
  const frame=capture.frames?.["5m"];
  const o=frame?.ohlc||{};
  if(!Number.isFinite(Number(o.high))||!Number.isFinite(Number(o.low)))return null;
  return {
    ts:frame.capturedAt||capture.capturedAt,
    open:Number(o.open)||Number(capture.price),
    high:Number(o.high),
    low:Number(o.low),
    close:Number(o.close)||Number(capture.price),
    volume:0
  };
}

async function runCycle(trigger="manual"){
  if(state.inCycle)throw new Error("A cycle is already running");
  state.inCycle=true;state.running=true;state.lastError=null;
  events.emit("cycle_start",{trigger});
  let cycleId=null;

  try{
    const capture=await tradingView.captureMarket();
    const main=capture.frames["5m"];

    const snapshotId=db.insertSnapshot({
      ts:capture.capturedAt,
      symbol:capture.symbol,
      price:capture.price,
      chartPath:main.chartPath,
      data:{
        source:capture.source,
        name:capture.name,
        status:capture.status,
        frames:capture.frames
      }
    });

    cycleId=db.createCycle({trigger,snapshotId});

    const candle=protectiveCandle(capture);
    if(candle)broker.processProtectiveOrders([candle],cycleId);

    const accountBefore=broker.accountSnapshot(capture.price);
    const openBefore=db.getOpenPosition();
    const bloodline=buildBloodline({
      market:capture,
      account:accountBefore,
      openPosition:openBefore
    });
    db.updateCycleInputs(cycleId,accountBefore,bloodline);

    const decision=await ai.decide({
      bloodline,
      chartBuffers:capture.images
    });

    const execution=broker.executePlan(decision,capture.price,cycleId);
    db.completeCycle(cycleId,{...decision,execution});

    const accountAfter=broker.accountSnapshot(capture.price);
    reporter.updateDailyReport(accountAfter);

    state.lastCycleAt=new Date().toISOString();
    state.lastError=null;
    db.systemEvent("CYCLE_COMPLETE","Bloodline cycle completed",{
      cycleId,trigger,price:capture.price,source:"TradingView"
    });
    events.emit("cycle_complete",{cycleId,trigger,decision,execution});
    return {cycleId,decision,execution};
  }catch(error){
    const message=String(error.privateMessage||error.message||"Cycle failed");
    state.lastError=message;
    if(cycleId)db.failCycle(cycleId,message);
    db.systemEvent("CYCLE_FAILED",message,{cycleId,trigger});
    events.emit("cycle_failed",{cycleId,trigger,message});
    throw error;
  }finally{
    state.inCycle=false;state.running=!state.paused;
  }
}

function queueStartupCycle(){
  if(!config.RUN_ON_START||state.startupQueued)return;
  state.startupQueued=true;
  setTimeout(()=>runCycle("startup").catch(()=>{}),1800);
}

function start(){
  state.paused=false;state.running=true;
  schedule();
  queueStartupCycle();
  db.systemEvent("WATCHER_STARTED","Watcher started",{
    cycleMinutes:config.CYCLE_MINUTES,
    source:"TradingView"
  });
}
function pause(){
  state.paused=true;state.running=false;
  if(state.timer)clearTimeout(state.timer);
  state.timer=null;state.nextRunAt=null;
  db.systemEvent("WATCHER_PAUSED","Watcher paused");
  events.emit("watcher",publicStatus());
}
function resume(){start()}

if(config.AUTO_START)start();

module.exports={runCycle,start,pause,resume,getStatus:publicStatus};
