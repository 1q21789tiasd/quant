const config=require("./config");
const db=require("./db");
const tradingView=require("./tradingView");
const {buildBloodline}=require("./bloodline");
const ai=require("./ai");
const broker=require("./paperBroker");
const reporter=require("./reporter");
const events=require("./eventBus");
const logger=require("./logger");

const state={
  running:false,
  paused:!config.AUTO_START,
  inCycle:false,
  restarting:false,
  nextRunAt:null,
  lastCycleAt:null,
  lastError:null,
  timer:null,
  startupQueued:false,
  activeCyclePromise:null,
  activeAbortController:null,
  activeTrigger:null,
  manualGeneration:0
};

function publicStatus(){
  return {
    running:state.running,
    paused:state.paused,
    inCycle:state.inCycle,
    restarting:state.restarting,
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
    logger.log("WATCHER","Automatic timer disabled because watcher is paused");
    return;
  }

  const delay=intervalMs();
  state.nextRunAt=new Date(Date.now()+delay).toISOString();

  logger.log("WATCHER","Next automatic cycle scheduled",{
    nextRunAt:state.nextRunAt,
    minutes:config.CYCLE_MINUTES
  });

  state.timer=setTimeout(()=>{
    state.timer=null;
    state.nextRunAt=null;

    if(state.paused)return;

    if(state.inCycle||state.restarting){
      logger.warn("WATCHER","Automatic cycle reached timer while another run is active; timer restarted");
      scheduleFromNow();
      return;
    }

    logger.log("WATCHER","Automatic cycle timer fired");
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

  logger.log("CYCLE","Cycle started",{trigger});
  events.emit("cycle_start",{trigger});
  events.emit("watcher",publicStatus());

  let cycleId=null;

  try{
    throwIfAborted(signal);

    logger.log("CYCLE","Opening TradingView and capturing 5m / 15m / 1h / 4h");
    const capture=await tradingView.captureMarket({signal});
    throwIfAborted(signal);

    logger.log("CYCLE","TradingView capture complete",{
      symbol:capture.symbol,
      price:capture.price,
      capturedAt:capture.capturedAt
    });

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
    logger.log("DB","Snapshot and cycle saved",{snapshotId,cycleId});

    throwIfAborted(signal);

    const candle=protectiveCandle(capture);
    if(candle){
      const protection=broker.processProtectiveOrders([candle],cycleId);
      if(protection)logger.log("BROKER","Protective order triggered",protection);
    }

    const accountBefore=broker.accountSnapshot(capture.price);
    const openBefore=db.getOpenPosition();

    const bloodline=buildBloodline({
      market:capture,
      account:accountBefore,
      openPosition:openBefore
    });

    db.updateCycleInputs(cycleId,accountBefore,bloodline);
    logger.log("CYCLE","Bloodline context built",{
      cycleId,
      balanceNis:accountBefore.balanceNis,
      openPosition:!!openBefore
    });

    throwIfAborted(signal);

    logger.log("AI","Decision request starting",{cycleId,images:Object.keys(capture.images||{})});
    const decision=await ai.decide({
      bloodline,
      chartBuffers:capture.images,
      signal
    });

    throwIfAborted(signal);

    logger.log("AI","Decision received",{
      cycleId,
      bias:decision.marketState?.bias,
      confidence:decision.marketState?.confidence,
      actions:(decision.actions||[]).map(x=>x.type)
    });

    const execution=broker.executePlan(decision,capture.price,cycleId);

    logger.log("BROKER","Decision actions processed",{
      cycleId,
      results:execution.map(x=>({
        type:x.action?.type,
        ok:x.result?.ok,
        message:x.result?.message
      }))
    });

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

    logger.log("CYCLE","Cycle complete",{
      cycleId,
      trigger,
      balanceNis:accountAfter.balanceNis,
      equityNis:accountAfter.equityNis
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

      logger.warn("CYCLE","Cycle cancelled",{cycleId,trigger});
      events.emit("cycle_cancelled",{cycleId,trigger});
      throw abortError("Cycle cancelled for manual restart");
    }

    const message=String(error.privateMessage||error.message||"Cycle failed");
    state.lastError=message;

    if(cycleId)db.failCycle(cycleId,message);

    db.systemEvent("CYCLE_FAILED",message,{cycleId,trigger});
    logger.error("CYCLE","Cycle failed",error);
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

function requestManualCycle(){
  const generation=++state.manualGeneration;
  const hadActive=!!state.activeCyclePromise||state.inCycle;

  logger.log("CONTROL","Manual cycle requested",{
    hadActive,
    generation
  });

  // The click itself becomes the new 15-minute anchor.
  if(!state.paused)scheduleFromNow();

  const oldPromise=state.activeCyclePromise;

  if(hadActive){
    state.restarting=true;
    events.emit("watcher",publicStatus());

    logger.warn("CONTROL","Cancelling active cycle for immediate fresh restart",{
      activeTrigger:state.activeTrigger
    });

    try{
      state.activeAbortController?.abort(
        abortError("Manual restart requested")
      );
    }catch(error){
      logger.error("CONTROL","Could not signal active cycle cancellation",error);
    }
  }

  // Important: do not await this here. HTTP must return immediately.
  (async()=>{
    if(oldPromise){
      try{await oldPromise}catch{}
    }

    if(generation!==state.manualGeneration){
      logger.warn("CONTROL","Older manual restart superseded by a newer click",{generation});
      return;
    }

    while(state.inCycle){
      const p=state.activeCyclePromise;
      if(!p)break;
      try{await p}catch{}
    }

    if(generation!==state.manualGeneration)return;

    state.restarting=false;
    events.emit("watcher",publicStatus());

    logger.log("CONTROL","Starting fresh manual cycle now",{generation});
    startTrackedCycle("manual").catch(error=>{
      if(error?.code!=="cycle_cancelled"){
        logger.error("CONTROL","Fresh manual cycle failed",error);
      }
    });
  })().catch(error=>{
    state.restarting=false;
    logger.error("CONTROL","Manual restart orchestration failed",error);
    events.emit("watcher",publicStatus());
  });

  return {
    accepted:true,
    restarted:hadActive,
    generation
  };
}

function requestCycle(trigger="manual"){
  if(trigger==="manual")return requestManualCycle();

  if(state.inCycle||state.restarting){
    return {
      accepted:false,
      restarted:false,
      alreadyRunning:true
    };
  }

  startTrackedCycle(trigger).catch(()=>{});

  return {
    accepted:true,
    restarted:false,
    alreadyRunning:false
  };
}

function queueStartupCycle(){
  if(!config.RUN_ON_START||state.startupQueued)return;
  state.startupQueued=true;

  setTimeout(()=>{
    if(!state.inCycle&&!state.restarting){
      logger.log("WATCHER","Starting startup cycle");
      startTrackedCycle("startup").catch(()=>{});
    }
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

  logger.log("WATCHER","Watcher started",{
    cycleMinutes:config.CYCLE_MINUTES,
    runOnStart:config.RUN_ON_START
  });
}

function pause(){
  state.paused=true;
  state.running=false;
  clearSchedule();
  state.nextRunAt=null;

  db.systemEvent("WATCHER_PAUSED","Watcher paused");
  logger.log("WATCHER","Watcher paused");
  events.emit("watcher",publicStatus());
}

function resume(){
  state.paused=false;
  state.running=true;
  scheduleFromNow();

  db.systemEvent("WATCHER_RESUMED","Watcher resumed",{
    cycleMinutes:config.CYCLE_MINUTES
  });

  logger.log("WATCHER","Watcher resumed");
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
