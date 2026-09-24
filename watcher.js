const config=require("./config");
const db=require("./db");
const market=require("./market");
const chart=require("./chart");
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
  timer:null
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

async function runCycle(trigger="manual"){
  if(state.inCycle)throw new Error("A cycle is already running");
  state.inCycle=true;state.running=true;state.lastError=null;
  events.emit("cycle_start",{trigger});
  let cycleId=null;

  try{
    const m=await market.getMarketState();
    const rendered=await chart.renderChart(m);
    const snapshotId=db.insertSnapshot({
      ts:m.ts,
      symbol:m.symbol,
      price:m.price,
      chartPath:rendered.publicPath,
      data:{
        name:m.name,
        frames:m.frames,
        recentCandles:{
          "5m":m.candles["5m"].slice(-120),
          "15m":m.candles["15m"].slice(-100),
          "1h":m.candles["1h"].slice(-80),
          "4h":m.candles["4h"].slice(-60)
        }
      }
    });

    cycleId=db.createCycle({trigger,snapshotId});
    broker.processProtectiveOrders(m.candles["5m"],cycleId);

    const accountBefore=broker.accountSnapshot(m.price);
    const openBefore=db.getOpenPosition();
    const bloodline=buildBloodline({market:m,account:accountBefore,openPosition:openBefore});
    db.updateCycleInputs(cycleId,accountBefore,bloodline);

    const decision=await ai.decide({bloodline,chartBuffer:rendered.buffer});
    const execution=broker.executePlan(decision,m.price,cycleId);
    db.completeCycle(cycleId,{...decision,execution});

    const accountAfter=broker.accountSnapshot(m.price);
    reporter.updateDailyReport(accountAfter);

    state.lastCycleAt=new Date().toISOString();
    state.lastError=null;
    db.systemEvent("CYCLE_COMPLETE","Bloodline cycle completed",{cycleId,trigger,price:m.price});
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

function start(){
  state.paused=false;state.running=true;schedule();
  db.systemEvent("WATCHER_STARTED","Watcher started",{cycleMinutes:config.CYCLE_MINUTES});
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
