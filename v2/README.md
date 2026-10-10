# Quant v2: Optional **stock/ETF-only** Alpaca paper experiment

**Important user correction:** Quant's requested asset is `CME_MINI:NQ1!` — continuous E-mini Nasdaq-100 **futures**. This Alpaca stock feed is **not an NQ futures feed** and **must not substitute QQQ, GLD or any other ETF** for that request. The v2 stock-only paper engine requires an explicitly set `QUANT_V2_SYMBOLS` value; it is NOT enabled by default. For the correct TradingView NQ chart use `node v2/nq-inspect.js` (read-only screenshot/quote-label inspection; no order execution).

## Legacy stock-only implementation

Opt-in standalone engine on `gpt-dev`; does not alter the original Quant AI bot or website.

**The engine places NO real or Alpaca-broker paper orders.** It calculates simulated trades and P&L locally and never calls an order endpoint. It's for researching a quant strategy without risking real capital.

## Why Alpaca Basic

- $0/month, 200 historical API calls per minute, 30 symbols on live websocket (not used in this REST implementation).
- We make only **one batched REST candle request per minute**, plus one trading calendar lookup each US trading day; no tight RPM bottleneck.
- `feed=iex` **only IEX, not SIP**. Can miss minutes and is not a true consolidated Nasdaq 100 price.
- QQQ = Nasdaq 100 ETF proxy, GLD = gold ETF proxy (NOT XAU/USD spot gold).
- Sources: https://docs.alpaca.markets/us/docs/about-market-data-api and https://docs.alpaca.markets/us/docs/paper-trading

## Install (Node 24+)

Get an Alpaca **Paper Only** account at https://alpaca.markets/. In Quant's existing root `.env` add:

```dotenv
ALPACA_KEY_ID=your_paper_only_key
ALPACA_SECRET_KEY=your_paper_only_secret
QUANT_V2_SYMBOLS= # leave empty for NQ; set an explicit ETF ticker ONLY if you separately want ETF research
AUTO_START=false
RUN_ON_START=false
```

No real key in Git. The last two settings prevent the old chart-AI watcher from running simultaneously.

```bash
npm install
node --test v2/paper.test.js
node v2/runner.js --once
node v2/runner.js --daemon
```

The daemon checks once/minute, pauses candle fetches outside NYSE regular session, respects NY timezone DST, holidays and early closing times, and uses a local atomic JSON file (`data/v2-paper.json`) ignored by `.gitignore`. Only **one** daemon should run per state file. Process supervision on EC2 (PM2/systemd) is recommended for month-long uptime.

### Trading rules

- Opening range first 30 actual 1-minute bars, 09:30–10:00 ET (first 2×15m candles); missing bars => no setup.
- After 10:00, one long-only opening-high breakout/day across both tickers, no short leverage. Stop opposite range end, TP 1:1. If first 15m breakout bar closes inside range, close on next minute open.
- Default fake wallet $600 USD, $4 model risk/trade, <=65% balance notional, $12 daily stop, 3 basis points slippage per side, $0.05 fee each side. **Stop fills can exceed the modeled risk on gaps.**
- The local price is an IEX minute OHLC proxy. Even this paper ledger does not reproduce actual stock exchange fills, spread, commissions, borrow, or liquidity; the bot hasn't demonstrated profits.
- On first startup the daemon intentionally ignores historical candles for entries; existing positions are advanced from subsequently observed completed candles. Without live tick-based quotes, protective fills can be late. No real-money order execution is available.

### Historical candles (export only)

```bash
node v2/export.js QQQ 45
# Creates data/qqq-iex-45d.csv
```

The separate `research/orb-backtest.js` from the earlier research starter can consume this CSV. Since IEX alone can have missing minutes, its strict complete-day checks may skip many days. Never fake missing candles to make the backtest look good.

### Not yet included

Broker-native simulated order placement, new dashboard integration, streaming WebSocket, a validated consolidated-data backtest, deployment on your running EC2 instance. These require further work and/or credentials; this commit does not claim them done.


## NQ1! futures (the target, not an ETF)

- TradingView layout: https://www.tradingview.com/chart/Q2Yhm4MH/
- Continuous symbol: `CME_MINI:NQ1!`. This is a **rolling** research/chart symbol; live orders require the actual deliverable futures contract, verified again at each roll.
- Free CME quotes on TradingView are normally **10 minutes delayed** unless you have qualifying paid market-data access. A screenshot is NOT an accurate 1-minute automated futures feed.
- `node v2/nq-inspect.js` uses Quant's existing Playwright chart capture. It **does not trade**, and reports requested symbol, chart statuses and extracted OHLC without claiming they are exchange-verified.
- `node --test v2/nq.test.js` checks a futures-specific risk calculator using NQ $20 per point ($5/tick) and MNQ $2 per point ($0.50/tick). MNQ calculations are informational, not a symbol substitution.
- Real-time NQ strategy automation requires actual CME-licensed NQ market data from a properly connected broker/data provider. There is currently **no verified unlimited free real-time CME NQ API** in this project.
- The original Quant screenshot AI paper simulator is *not* futures-correct (stock/CFD-style margin and spread model), so `AUTO_START=false` and `RUN_ON_START=false` are now the safe defaults.
- Source: https://www.tradingview.com/data-coverage/ and https://www.tradingview.com/support/solutions/43000483493-what-are-1-and-2-continuous-futures-contracts/

### Protection against legacy futures mispricing
The old `paperBroker.js` now refuses new NQ1!/MNQ1! simulated entries; its percentage-PnL CFD formula cannot model CME contract multipliers. The original `.env` (if one already exists) overrides `config.js` and `.env.example`: change `TRADINGVIEW_SYMBOL=CME_MINI:NQ1!` and set `AUTO_START=false`, `RUN_ON_START=false` explicitly. The saved TradingView chart layout may require TradingView login/browser storage-state and may still contain delayed quotes. Neither the local paper P&L nor the screenshot collector is a substitute for properly sourced futures data.
