const config = require("./config");
const db = require("./db");

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k,v] of Object.entries(value)) {
      if (k === "buffer" || k === "fullPath") continue;
      out[k] = clean(v);
    }
    return out;
  }
  if (typeof value === "number" && Number.isFinite(value)) return Number(value.toFixed(4));
  return value;
}

function buildBloodline({ market, account, openPosition }) {
  const recent = db.recentDecisions(8).map(x => ({
    at: x.ts,
    bias: x.decision?.marketState?.bias || "UNKNOWN",
    confidence: x.decision?.marketState?.confidence || 0,
    actions: (x.decision?.actions || []).map(a => a.type),
    summary: x.decision?.summary || ""
  }));

  return clean({
    generatedAt: new Date().toISOString(),

    objective: {
      primary: "Maximize long-term simulated account growth while obeying every hard risk rule.",
      dailyBenchmarkNis: config.DAILY_BENCHMARK_NIS,
      benchmarkRule: "The benchmark is informational. Never force a trade to reach it.",
      environment: "PAPER TRADING ONLY"
    },

    constraints: {
      startingBalanceNis: config.STARTING_BALANCE_NIS,
      leverage: config.LEVERAGE,
      maxMarginPerTradeNis: config.MAX_MARGIN_PER_TRADE_NIS,
      maxRiskPerTradeNis: config.MAX_RISK_PER_TRADE_NIS,
      maxDailyLossNis: config.MAX_DAILY_LOSS_NIS,
      maxOpenPositions: 1,
      requireStopLossForNewPosition: true,
      instrument: config.MARKET_DISPLAY_NAME
    },

    account,
    openPosition,

    market: {
      source: "TradingView headless browser capture",
      symbol: market.symbol,
      name: market.name,
      currentPrice: market.price,
      capturedAt: market.capturedAt,
      sourceStatus: market.status || "",
      timeframes: market.frames
    },

    sourceRules: [
      "All chart images and visible O/H/L/C values came from TradingView pages opened in a headless browser.",
      "Each timeframe may report delayed or closed-market status. Respect that status.",
      "Technicals text is scraped from TradingView's Technicals page when available.",
      "Do not invent hidden candles, news, order flow, broker quotes or indicators that are not present."
    ],

    previousCycles: recent
  });
}

module.exports = { buildBloodline };
