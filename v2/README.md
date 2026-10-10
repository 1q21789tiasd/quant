# Quant v2: Free Alpaca feed and automated local paper trading

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
QUANT_V2_SYMBOLS=QQQ,GLD
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
