const config = require("./config");
const db = require("./db");

function roundObject(value) {
  if (Array.isArray(value)) return value.map(roundObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k,v] of Object.entries(value)) out[k] = roundObject(v);
    return out;
  }
  if (typeof value === "number" && Number.isFinite(value)) return Number(value.toFixed(4));
  return value;
}

function buildBloodline({ market, account, openPosition }) {
  const recent = db.recentDecisions(6).map(x => ({
    at: x.ts,
    bias: x.decision?.marketState?.bias || "UNKNOWN",
    confidence: x.decision?.marketState?.confidence || 0,
    actions: (x.decision?.actions || []).map(a => a.type),
    summary: x.decision?.summary || ""
  }));

  const objective = {
    primary: "Maximize long-term simulated account growth while obeying every hard risk rule.",
    dailyBenchmarkNis: config.DAILY_BENCHMARK_NIS,
    benchmarkRule: "The daily benchmark is informational. Never force a trade to reach it.",
    environment: "PAPER TRADING ONLY"
  };

  const constraints = {
    startingBalanceNis: config.STARTING_BALANCE_NIS,
    leverage: config.LEVERAGE,
    maxMarginPerTradeNis: config.MAX_MARGIN_PER_TRADE_NIS,
    maxRiskPerTradeNis: config.MAX_RISK_PER_TRADE_NIS,
    maxDailyLossNis: config.MAX_DAILY_LOSS_NIS,
    maxOpenPositions: 1,
    requireStopLossForNewPosition: true,
    instrument: config.MARKET_DISPLAY_NAME
  };

  const marketBlock = {
    symbol: market.symbol,
    name: market.name,
    currentPrice: market.price,
    candleTime: market.ts,
    frames: market.frames
  };

  return roundObject({
    generatedAt: new Date().toISOString(),
    objective,
    constraints,
    account,
    openPosition,
    market: marketBlock,
    previousCycles: recent
  });
}

module.exports = { buildBloodline };
