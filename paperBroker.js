const config=require("./config");
const db=require("./db");
const events=require("./eventBus");

function today(){ return new Date().toISOString().slice(0,10); }

function grossPnl(position, exitPrice, notionalOverride=null){
  const n=Number(notionalOverride ?? position.notional_nis);
  const dir=position.side==="BUY"?1:-1;
  return n*((Number(exitPrice)-Number(position.entry_price))/Number(position.entry_price))*dir;
}

function spreadCost(notional, price){
  if(!config.SPREAD_POINTS||!price)return 0;
  return Number(notional)*(config.SPREAD_POINTS/Number(price));
}

function accountSnapshot(price){
  const a=db.getAccount();
  const p=db.getOpenPosition();
  const unrealized=p&&price?grossPnl(p,price):0;
  const used=p?Number(p.margin_nis):0;
  const equity=Number(a.balance)+unrealized;
  return {
    startingBalanceNis:Number(a.starting_balance),
    balanceNis:Number(a.balance),
    equityNis:equity,
    freeMarginNis:equity-used,
    usedMarginNis:used,
    unrealizedPnlNis:unrealized,
    realizedPnlTodayNis:db.realizedForDay(today()),
    totalRealizedPnlNis:Number(a.balance)-Number(a.starting_balance)
  };
}

function recordAction(cycleId,action,status,message){
  db.insertAction(cycleId,action,status,message);
  events.emit("action",{cycleId,action,status,message});
}

function closePosition(position,price,percentage,cycleId,reason,eventType="CLOSE"){
  const pct=Math.max(0,Math.min(100,Number(percentage)||0));
  if(!pct)return {ok:false,message:"Close percentage must be above zero"};
  const fraction=pct/100;
  const closingNotional=Number(position.notional_nis)*fraction;
  const closingMargin=Number(position.margin_nis)*fraction;
  const gross=grossPnl(position,price,closingNotional);
  const cost=spreadCost(closingNotional,price);
  const net=gross-cost;
  const a=db.getAccount();
  db.setBalance(Number(a.balance)+net);

  const existingRealized=Number(position.realized_pnl||0);
  const existingSpread=Number(position.spread_cost||0);

  if(pct>=99.999){
    db.updatePosition(position.id,{
      margin_nis:0,
      notional_nis:0,
      exit_price:Number(price),
      closed_at:new Date().toISOString(),
      status:"CLOSED",
      realized_pnl:existingRealized+net,
      spread_cost:existingSpread+cost,
      cycle_close_id:cycleId||null,
      last_checked_at:new Date().toISOString()
    });
  }else{
    db.updatePosition(position.id,{
      margin_nis:Number(position.margin_nis)-closingMargin,
      notional_nis:Number(position.notional_nis)-closingNotional,
      realized_pnl:existingRealized+net,
      spread_cost:existingSpread+cost,
      last_checked_at:new Date().toISOString()
    });
  }

  db.insertPositionEvent(position.id,cycleId,eventType,Number(price),{
    percentage:pct,
    grossPnlNis:gross,
    spreadCostNis:cost,
    netPnlNis:net,
    reason:reason||""
  });

  events.emit("position",{
    event:eventType,
    positionId:position.id,
    price:Number(price),
    percentage:pct,
    netPnlNis:net
  });

  return {ok:true,message:"Position reduced",netPnlNis:net};
}

function validatePriceForStop(position,price){
  if(position.side==="BUY")return Number(price)<Number(position.entry_price);
  return Number(price)>Number(position.entry_price);
}

function validatePriceForTarget(position,price){
  if(position.side==="BUY")return Number(price)>Number(position.entry_price);
  return Number(price)<Number(position.entry_price);
}

function openPosition(action,decision,currentPrice,cycleId){
  if(db.getOpenPosition())return {ok:false,message:"An open position already exists"};

  const snap=accountSnapshot(currentPrice);
  if(snap.realizedPnlTodayNis<=-Math.abs(config.MAX_DAILY_LOSS_NIS)){
    return {ok:false,message:"Daily loss kill switch is active"};
  }

  const margin=Number(action.marginNis);
  if(!Number.isFinite(margin)||margin<=0)return {ok:false,message:"Margin must be above zero"};
  if(margin>config.MAX_MARGIN_PER_TRADE_NIS)return {ok:false,message:"Requested margin exceeds the hard limit"};
  if(margin>snap.freeMarginNis)return {ok:false,message:"Not enough free margin"};

  const side=action.side;
  if(!["BUY","SELL"].includes(side))return {ok:false,message:"OPEN_POSITION requires BUY or SELL"};

  const stopAction=(decision.actions||[]).find(a=>["SET_STOP_LOSS","MOVE_STOP_LOSS"].includes(a.type)&&Number(a.price)>0);
  if(!stopAction)return {ok:false,message:"A new position requires a stop loss in the same cycle"};

  const stop=Number(stopAction.price);
  const pseudo={side,entry_price:currentPrice};
  if(!validatePriceForStop(pseudo,stop))return {ok:false,message:"Stop loss is on the wrong side of entry"};

  const targetAction=(decision.actions||[]).find(a=>["SET_TAKE_PROFIT","MOVE_TAKE_PROFIT"].includes(a.type)&&Number(a.price)>0);
  const tp=targetAction?Number(targetAction.price):null;
  if(tp&&!validatePriceForTarget(pseudo,tp))return {ok:false,message:"Take profit is on the wrong side of entry"};

  const notional=margin*config.LEVERAGE;
  const risk=notional*(Math.abs(currentPrice-stop)/currentPrice)+spreadCost(notional,currentPrice);
  if(risk>config.MAX_RISK_PER_TRADE_NIS){
    return {ok:false,message:"Stop distance risks more than the hard per-trade loss limit"};
  }

  const id=db.insertPosition({
    openedAt:new Date().toISOString(),
    side,
    entryPrice:Number(currentPrice),
    marginNis:margin,
    leverage:config.LEVERAGE,
    notionalNis:notional,
    stopLoss:stop,
    takeProfit:tp,
    cycleId,
    lastCheckedAt:new Date().toISOString()
  });
  db.insertPositionEvent(id,cycleId,"OPEN",Number(currentPrice),{
    marginNis:margin,notionalNis:notional,stopLoss:stop,takeProfit:tp,riskAtStopNis:risk,reason:action.reason||""
  });
  events.emit("position",{event:"OPEN",positionId:id,side,price:Number(currentPrice),marginNis:margin});
  return {ok:true,message:"Paper position opened",positionId:id};
}

function modifyProtection(action,currentPrice,cycleId,decision){
  const p=db.getOpenPosition();
  if(!p)return {ok:false,message:"No open position"};

  if(["SET_STOP_LOSS","MOVE_STOP_LOSS"].includes(action.type)){
    const price=Number(action.price);
    if(!price||!validatePriceForStop(p,price))return {ok:false,message:"Invalid stop-loss price"};
    const risk=Number(p.notional_nis)*(Math.abs(Number(p.entry_price)-price)/Number(p.entry_price))+spreadCost(Number(p.notional_nis),currentPrice);
    if(risk>config.MAX_RISK_PER_TRADE_NIS)return {ok:false,message:"Requested stop exceeds the hard per-trade risk limit"};
    db.updatePosition(p.id,{stop_loss:price});
    db.insertPositionEvent(p.id,cycleId,action.type,price,{reason:action.reason||""});
    return {ok:true,message:"Stop loss updated"};
  }

  if(action.type==="REMOVE_STOP_LOSS"){
    const hasReplacement=(decision.actions||[]).some(a=>["SET_STOP_LOSS","MOVE_STOP_LOSS"].includes(a.type)&&Number(a.price)>0);
    if(!hasReplacement)return {ok:false,message:"A protected open position cannot be left without a stop"};
    db.updatePosition(p.id,{stop_loss:null});
    db.insertPositionEvent(p.id,cycleId,"REMOVE_STOP_LOSS",currentPrice,{reason:action.reason||""});
    return {ok:true,message:"Stop loss cleared for replacement"};
  }

  if(["SET_TAKE_PROFIT","MOVE_TAKE_PROFIT"].includes(action.type)){
    const price=Number(action.price);
    if(!price||!validatePriceForTarget(p,price))return {ok:false,message:"Invalid take-profit price"};
    db.updatePosition(p.id,{take_profit:price});
    db.insertPositionEvent(p.id,cycleId,action.type,price,{reason:action.reason||""});
    return {ok:true,message:"Take profit updated"};
  }

  if(action.type==="REMOVE_TAKE_PROFIT"){
    db.updatePosition(p.id,{take_profit:null});
    db.insertPositionEvent(p.id,cycleId,"REMOVE_TAKE_PROFIT",currentPrice,{reason:action.reason||""});
    return {ok:true,message:"Take profit removed"};
  }

  return {ok:false,message:"Unsupported protection action"};
}

function executePlan(decision,currentPrice,cycleId){
  const results=[];
  for(const action of decision.actions||[]){
    let result;
    try{
      if(action.type==="OPEN_POSITION"){
        result=openPosition(action,decision,currentPrice,cycleId);
      }else if(action.type==="CLOSE_POSITION"||action.type==="CLOSE_PARTIAL"){
        const p=db.getOpenPosition();
        result=p
          ? closePosition(p,currentPrice,action.type==="CLOSE_POSITION"?100:Number(action.percentage||0),cycleId,action.reason,action.type)
          : {ok:false,message:"No open position"};
      }else if([
        "SET_STOP_LOSS","MOVE_STOP_LOSS","REMOVE_STOP_LOSS",
        "SET_TAKE_PROFIT","MOVE_TAKE_PROFIT","REMOVE_TAKE_PROFIT"
      ].includes(action.type)){
        result=modifyProtection(action,currentPrice,cycleId,decision);
      }else if(action.type==="DO_NOTHING"){
        result={ok:true,message:"No trade action taken"};
      }else{
        result={ok:false,message:"Unknown action"};
      }
    }catch(error){
      result={ok:false,message:"Execution error"};
      db.systemEvent("BROKER_ERROR",error.message,{cycleId});
    }
    recordAction(cycleId,action,result.ok?"EXECUTED":"REJECTED",result.message);
    results.push({action,result});
  }
  return results;
}

function processProtectiveOrders(candles,cycleId){
  let p=db.getOpenPosition();
  if(!p||!Array.isArray(candles)||!candles.length)return null;
  const after=p.last_checked_at?new Date(p.last_checked_at).getTime():0;
  const fresh=candles.filter(c=>new Date(c.ts).getTime()>after);

  for(const c of fresh){
    p=db.getOpenPosition();
    if(!p)break;
    const sl=Number(p.stop_loss)||null,tp=Number(p.take_profit)||null;
    let stopHit=false,targetHit=false;
    if(p.side==="BUY"){
      stopHit=sl!==null&&c.low<=sl;
      targetHit=tp!==null&&c.high>=tp;
    }else{
      stopHit=sl!==null&&c.high>=sl;
      targetHit=tp!==null&&c.low<=tp;
    }

    if(stopHit){
      return closePosition(p,sl,100,cycleId,"Protective stop triggered","STOP_LOSS");
    }
    if(targetHit){
      return closePosition(p,tp,100,cycleId,"Take profit triggered","TAKE_PROFIT");
    }
    db.updatePosition(p.id,{last_checked_at:c.ts});
  }
  return null;
}

function reset(){
  db.resetSimulation();
  events.emit("reset",{});
}

module.exports={accountSnapshot,executePlan,processProtectiveOrders,reset,grossPnl};
