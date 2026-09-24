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
  activeAbortController:null,
  activeTrigger:null,
  restartPromise:null
};

function publicStatus(){
  return {
    running:state.running,
    paused:state.paused,
    inCycle:state.inCycle,
    nextRunAt:state.nextRunAt,
    lastCycleAt:state.lastCycleAt,
    lastError:state.lastError,
    activeTrigger:state.activeTrigger
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

  const delay=intervalMs();
  state.nextRunAt=new Date(Date.now()+delay).toISOString();

  state.timer=setTimeout(()=>{
    state.timer=null;
    state.nextRunAt=null;

    if(state.paused)return;

    if(state.inCycle){
      scheduleFromNow();
      return;
    }

    const promise=startTrackedCycle("scheduled");
    promise.finally(()=>{
      if(!state.paused)scheduleFromNow();
    }).catch(()=>{});
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

function abortError(message="Cycle cancelled"){
  const error=new Error(message);
  error.name="AbortError";
  error.code="cycle_cancelled";
  return error;
}

function throwIfAborted(signal){
  if(signal?.aborted){
    throw signal.reason instanceof Error
      ? signal.reason
      : abortError("Cycle cancelled");
  }
}

async function runCycle(trigger="manual",signal){
  if(state.inCycle){
    const error=new Error("A cycle is already running");
    error.code="cycle_busy";
    throw error;
  }

  state.inCycle=true;
  state.running=true;
  state.activeTrigger=trigger;
  state.lastError=null;

  events.emit("cycle_start",{trigger});
  events.emit("watcher",publicStatus());

  let cycleId=null;

  try{
    throwIfAborted(signal);

    const capture=await tradingView.captureMarket({signal});
    throwIfAborted(signal);

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

    throwIfAborted(signal);

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

    throwIfAborted(signal);

    const decision=await ai.decide({
      bloodline,
      chartBuffers:capture.images,
      signal
    });

    throwIfAborted(signal);

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
    const cancelled=
      signal?.aborted ||
      error?.name==="AbortError" ||
      error?.code==="cycle_cancelled";

    if(cancelled){
      if(cycleId)db.failCycle(cycleId,"Cancelled for fresh manual restart");

      db.systemEvent(
        "CYCLE_CANCELLED",
        "Active cycle cancelled for a fresh manual restart",
        {cycleId,trigger}
      );

      events.emit("cycle_cancelled",{cycleId,trigger});
      throw abortError("Cycle cancelled for manual restart");
    }

    const message=String(error.privateMessage||error.message||"Cycle failed");
    state.lastError=message;

    if(cycleId)db.failCycle(cycleId,message);

    db.systemEvent("CYCLE_FAILED",message,{cycleId,trigger});
    events.emit("cycle_failed",{cycleId,trigger,message});
    throw error;
  }finally{
    state.inCycle=false;
    state.activeTrigger=null;
    state.running=!state.paused;
    events.emit("watcher",publicStatus());
  }
}

function startTrackedCycle(trigger){
  const controller=new AbortController();
  state.activeAbortController=controller;

  const promise=runCycle(trigger,controller.signal);
  state.activeCyclePromise=promise;

  promise.finally(()=>{
    if(state.activeCyclePromise===promise){
      state.activeCyclePromise=null;
      state.activeAbortController=null;
    }
  }).catch(()=>{});

  return promise;
}

async function restartManualCycle(){
  if(state.restartPromise)return state.restartPromise;

  state.restartPromise=(async()=>{
    // Manual run becomes the new automatic 15-minute anchor.
    if(!state.paused)scheduleFromNow();

    const hadActive=!!state.activeCyclePromise;

    if(hadActive){
      db.systemEvent(
        "MANUAL_RESTART",
        "Manual run requested; cancelling the active cycle and starting fresh"
      );

      try{
        state.activeAbortController?.abort(
          abortError("Manual restart requested")
        );
      }catch{}

      try{
        await state.activeCyclePromise;
      }catch{}
    }

    const promise=startTrackedCycle("manual");

    return {
      accepted:true,
      restarted:hadActive,
      promise
    };
  })();

  try{
    return await state.restartPromise;
  }finally{
    state.restartPromise=null;
  }
}

async function requestCycle(trigger="manual"){
  if(trigger==="manual"){
    return restartManualCycle();
  }

  if(state.inCycle){
    return {
      accepted:false,
      restarted:false,
      alreadyRunning:true,
      promise:state.activeCyclePromise
    };
  }

  return {
    accepted:true,
    restarted:false,
    alreadyRunning:false,
    promise:startTrackedCycle(trigger)
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
