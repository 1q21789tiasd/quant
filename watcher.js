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
  startupQueued:false,
  activeCyclePromise:null,
  manualQueued:false
};

function publicStatus(){
  return {
    running:state.running,
    paused:state.paused,
    inCycle:state.inCycle,
    manualQueued:state.manualQueued,
    nextRunAt:state.nextRunAt,
    lastCycleAt:state.lastCycleAt,
    lastError:state.lastError
  };
}

function intervalMs(){
  return Math.max(1,Number(config.CYCLE_MINUTES)||15)*60*1000;
}

function clearSchedule(){
  if(state.timer)clearTimeout(state.timer);
  state.timer=null;
}

function scheduleFromNow(){
  clearSchedule();

  if(state.paused){
    state.nextRunAt=null;
    events.emit("watcher",publicStatus());
    return;
  }

  const next=new Date(Date.now()+intervalMs());
  state.nextRunAt=next.toISOString();

  state.timer=setTimeout(()=>{
    state.timer=null;
    state.nextRunAt=null;

    if(state.paused)return;

    if(state.inCycle){
      db.systemEvent("SCHEDULE_SKIPPED","Scheduled cycle delayed because another cycle is active");
      scheduleFromNow();
      return;
    }

    const promise=startTrackedCycle("scheduled");
    promise.finally(()=>{
      if(!state.paused)scheduleFromNow();
    }).catch(()=>{});
  },intervalMs());

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
  if(state.inCycle){
    const error=new Error("A cycle is already running");
    error.code="cycle_busy";
    throw error;
  }

  state.inCycle=true;
  state.running=true;
  state.lastError=null;
  events.emit("cycle_start",{trigger});
  events.emit("watcher",publicStatus());

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
      cycleId,
      trigger,
      price:capture.price,
      source:"TradingView"
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
    state.inCycle=false;
    state.running=!state.paused;
    events.emit("watcher",publicStatus());
  }
}

function startTrackedCycle(trigger){
  const promise=runCycle(trigger);
  state.activeCyclePromise=promise;

  promise.finally(()=>{
    if(state.activeCyclePromise===promise)state.activeCyclePromise=null;

    if(state.manualQueued){
      state.manualQueued=false;

      if(!state.paused){
        // The queued manual cycle becomes the new 15-minute anchor.
        scheduleFromNow();
      }

      db.systemEvent("MANUAL_CYCLE_DEQUEUED","Queued manual cycle is starting now");
      events.emit("watcher",publicStatus());

      setTimeout(()=>{
        if(!state.inCycle){
          startTrackedCycle("manual").catch(()=>{});
        }
      },50);
    }
  }).catch(()=>{});

  return promise;
}

function requestCycle(trigger="manual"){
  if(trigger==="manual"){
    // A manual click always resets the next automatic cycle to 15 minutes from now.
    if(!state.paused)scheduleFromNow();

    if(state.inCycle){
      const newlyQueued=!state.manualQueued;
      state.manualQueued=true;

      if(newlyQueued){
        db.systemEvent("MANUAL_CYCLE_QUEUED","Manual cycle queued behind the active cycle");
      }

      events.emit("watcher",publicStatus());

      return {
        accepted:true,
        queued:true,
        alreadyRunning:true,
        promise:state.activeCyclePromise
      };
    }
  }else if(state.inCycle){
    return {
      accepted:false,
      queued:false,
      alreadyRunning:true,
      promise:state.activeCyclePromise
    };
  }

  const promise=startTrackedCycle(trigger);

  return {
    accepted:true,
    queued:false,
    alreadyRunning:false,
    promise
  };
}

function queueStartupCycle(){
  if(!config.RUN_ON_START||state.startupQueued)return;
  state.startupQueued=true;

  setTimeout(()=>{
    if(!state.inCycle)startTrackedCycle("startup").catch(()=>{});
  },1800);
}

function start(){
  state.paused=false;
  state.running=true;
  scheduleFromNow();
  queueStartupCycle();

  db.systemEvent("WATCHER_STARTED","Watcher started",{
    cycleMinutes:config.CYCLE_MINUTES,
    source:"TradingView"
  });
}

function pause(){
  state.paused=true;
  state.running=false;
  state.manualQueued=false;
  clearSchedule();
  state.nextRunAt=null;

  db.systemEvent("WATCHER_PAUSED","Watcher paused");
  events.emit("watcher",publicStatus());
}

function resume(){
  state.paused=false;
  state.running=true;
  scheduleFromNow();

  db.systemEvent("WATCHER_RESUMED","Watcher resumed",{
    cycleMinutes:config.CYCLE_MINUTES
  });
}

if(config.AUTO_START)start();

module.exports={
  runCycle,
  requestCycle,
  start,
  pause,
  resume,
  getStatus:publicStatus
};
