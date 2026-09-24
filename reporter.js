const db=require("./db");
const config=require("./config");

function day(){return new Date().toISOString().slice(0,10)}

function updateDailyReport(account){
  const d=day();
  const trades=db.closedPositionsForDay(d);
  const wins=trades.filter(t=>Number(t.realized_pnl)>0);
  const losses=trades.filter(t=>Number(t.realized_pnl)<0);
  const grossWins=wins.reduce((s,t)=>s+Number(t.realized_pnl),0);
  const grossLosses=Math.abs(losses.reduce((s,t)=>s+Number(t.realized_pnl),0));
  const realized=trades.reduce((s,t)=>s+Number(t.realized_pnl),0);
  const start=Number(account.balanceNis)-realized;

  let running=start,peak=start,maxDrawdown=0;
  for(const t of trades){
    running+=Number(t.realized_pnl);
    peak=Math.max(peak,running);
    maxDrawdown=Math.max(maxDrawdown,peak-running);
  }

  const report={
    startingEquityNis:start,
    endingBalanceNis:Number(account.balanceNis),
    equityNis:Number(account.equityNis),
    realizedPnlNis:realized,
    unrealizedPnlNis:Number(account.unrealizedPnlNis),
    dailyBenchmarkNis:config.DAILY_BENCHMARK_NIS,
    benchmarkProgressPct:config.DAILY_BENCHMARK_NIS?realized/config.DAILY_BENCHMARK_NIS*100:0,
    trades:trades.length,
    wins:wins.length,
    losses:losses.length,
    winRatePct:trades.length?wins.length/trades.length*100:0,
    avgWinnerNis:wins.length?grossWins/wins.length:0,
    avgLoserNis:losses.length?grossLosses/losses.length:0,
    profitFactor:grossLosses?grossWins/grossLosses:(grossWins>0?999:0),
    maxDrawdownNis:maxDrawdown,
    updatedAt:new Date().toISOString()
  };
  db.saveDailyReport(d,report);
  return report;
}

module.exports={updateDailyReport};
