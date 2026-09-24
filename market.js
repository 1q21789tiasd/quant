const config = require("./config");
const { summarize } = require("./indicators");

function parseTs(value) {
  if (!value) return Date.now();
  const normalized = String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.now();
}

function normalizeValue(row) {
  return {
    ts: new Date(parseTs(row.datetime)).toISOString(),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume || 0)
  };
}

function aggregate(candles, minutes) {
  const ms = minutes * 60 * 1000;
  const groups = new Map();
  for (const c of candles) {
    const key = Math.floor(new Date(c.ts).getTime() / ms) * ms;
    if (!groups.has(key)) {
      groups.set(key, {
        ts: new Date(key).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      });
    } else {
      const g = groups.get(key);
      g.high = Math.max(g.high, c.high);
      g.low = Math.min(g.low, c.low);
      g.close = c.close;
      g.volume += c.volume;
    }
  }
  return Array.from(groups.values()).sort((a,b) => new Date(a.ts) - new Date(b.ts));
}

async function fetchFiveMinuteCandles() {
  if (!config.MARKET_API_KEY) {
    const e = new Error("Market data is not configured");
    e.code = "market_not_configured";
    throw e;
  }

  const params = new URLSearchParams({
    symbol: config.MARKET_SYMBOL,
    interval: "5min",
    outputsize: "500",
    order: "ASC",
    timezone: config.MARKET_TIMEZONE,
    apikey: config.MARKET_API_KEY
  });

  const res = await fetch("https://api.twelvedata.com/time_series?" + params.toString(), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000)
  });

  if (!res.ok) {
    const e = new Error("Market data request failed");
    e.code = "market_request_failed";
    throw e;
  }

  const body = await res.json();
  if (body.status === "error" || !Array.isArray(body.values) || !body.values.length) {
    const e = new Error("Market data returned no candles");
    e.code = "market_empty";
    e.privateMessage = body.message || "No values";
    throw e;
  }

  return body.values.map(normalizeValue).filter(c =>
    [c.open,c.high,c.low,c.close].every(Number.isFinite)
  );
}

async function getMarketState() {
  const five = await fetchFiveMinuteCandles();
  const fifteen = aggregate(five, 15);
  const oneHour = aggregate(five, 60);
  const fourHour = aggregate(five, 240);

  const frames = {
    "5m": summarize(five),
    "15m": summarize(fifteen),
    "1h": summarize(oneHour),
    "4h": summarize(fourHour)
  };

  const latest = five[five.length - 1];
  return {
    symbol: config.MARKET_SYMBOL,
    name: config.MARKET_DISPLAY_NAME,
    price: latest.close,
    ts: latest.ts,
    frames,
    candles: {
      "5m": five,
      "15m": fifteen,
      "1h": oneHour,
      "4h": fourHour
    }
  };
}

module.exports = { getMarketState, aggregate };
