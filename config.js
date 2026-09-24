const path = require("path");

const root = __dirname;

module.exports = {
  PORT: Number(process.env.PORT || 3000),
  DATA_DIR: process.env.DATA_DIR || path.join(root, "data"),
  DB_PATH: process.env.DB_PATH || path.join(root, "data", "quant.db"),
  CHART_DIR: process.env.CHART_DIR || path.join(root, "data", "charts"),
  CONTEXT_FILE: process.env.CONTEXT_FILE || path.join(root, "context.md"),

  STARTING_BALANCE_NIS: Number(process.env.STARTING_BALANCE_NIS || 2000),
  LEVERAGE: Number(process.env.LEVERAGE || 40),
  MAX_MARGIN_PER_TRADE_NIS: Number(process.env.MAX_MARGIN_PER_TRADE_NIS || 450),
  MAX_RISK_PER_TRADE_NIS: Number(process.env.MAX_RISK_PER_TRADE_NIS || 15),
  MAX_DAILY_LOSS_NIS: Number(process.env.MAX_DAILY_LOSS_NIS || 120),
  DAILY_BENCHMARK_NIS: Number(process.env.DAILY_BENCHMARK_NIS || 40),
  SPREAD_POINTS: Number(process.env.SPREAD_POINTS || 1.8),

  CYCLE_MINUTES: Number(process.env.CYCLE_MINUTES || 15),
  AUTO_START: String(process.env.AUTO_START || "true").toLowerCase() === "true",

  MARKET_SYMBOL: process.env.MARKET_SYMBOL || "NDX",
  MARKET_DISPLAY_NAME: process.env.MARKET_DISPLAY_NAME || "NASDAQ 100",
  MARKET_TIMEZONE: process.env.MARKET_TIMEZONE || "UTC",
  MARKET_API_KEY: process.env.TWELVE_DATA_API_KEY || "",

  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || ""
};
