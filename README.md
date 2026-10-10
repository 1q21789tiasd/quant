# Quant v3 — NQ1! paper trading & futures research

A focused CME E-mini Nasdaq-100 **paper-only** strategy engine. Chart reference: [your NQ1! TradingView layout](https://www.tradingview.com/chart/Q2Yhm4MH/). Uses actual NQ quarterly **dated contracts** (`NQZ6`, etc.) for historical source queries, not an ETF or an exchange-tradable `NQ1!` symbol.

**No brokerage connection. No real-money orders. No claim of a ₪50/day profitable system.** The target is a benchmark, never a reason to force entries, leverage, or fictitious profits.

## Quick start — no npm dependencies

Requires Node.js 22+.

```bash
npm test                     # 30 automated tests
npm start                    # http://127.0.0.1:3000
```

The dashboard works immediately and starts with an *empty* simulated account. The absence of live data is shown transparently. A valid historical CSV can be uploaded for fully automated **historical trade replay**, including next-candle entries and subsequent paper exits.

### BEST free, authorized CME NQ historical source: Massive Futures Basic

As of October 2026, [Massive Futures Basic](https://massive.com/futures) includes CME historical minute aggregates and contract definitions at **$0**, with **5 API requests/minute, 2 years' history, and 8-hour-delayed historical data**. It's suitable for historical strategy research, **not a live execution feed**. The script batches lots of minute candles into a single request and handles pagination, provider errors, invalid timestamps, and rate limiting.

Get a free account with Futures access, set your credential in the environment (never in Git):

```bash
export MASSIVE_API_KEY='YOUR_MASSIVE_FUTURES_API_KEY'
node scripts/download.js discover 2026-10-09
# Choose the liquid relevant dated NQ contract and check its expiry.
node scripts/download.js NQZ6 2026-10-05 2026-10-09
# Creates data/NQZ6-2026-10-05-2026-10-09.csv
npm start
```

Upload that CSV on the dashboard and select the risk parameters. **Do not upload it to `/api/feed/bar`**: historical candles must never be represented as fresh.

Alternatively, run a delayed, historical **daily shadow paper study** without manually uploading files:

```bash
export MASSIVE_CONTRACT=NQZ6 # Must be maintained at roll/expiry; no silent contract switches
export PAPER_RISK_USD=15
export USD_ILS_RATE=0       # Optional manually verified rate, 0 means unknown
npm run sync
npm start
```

`npm run sync` processes only complete 390-candle NY cash sessions and saves `data/last-replay.json` and `data/last-backtest.json`. **It reports retrospective hypothetical fills 8+ hours after the market moves**. It does NOT trade in realtime or guarantee an actionable signal. With 8-hour-delayed data you can schedule sync once each morning from cron/systemd, not once every minute. If there are missing bars, it refuses to invent prices.

Official sources: [Massive futures aggregate API](https://massive.com/docs/rest/futures/aggregates), [contracts API](https://massive.com/docs/rest/futures/contracts), [minute-bar example](https://massive.com/knowledge-base/article/how-do-i-get-intraday-bars-for-a-futures-contract), [Massive Futures Pricing](https://massive.com/futures).

## Optional real-time-like local paper order processing

We implemented a **separate** brokerless paper engine (`engine.js`) that processes fresh, timestamped, finalized 1-minute OHLC candles into local BUY/SELL simulated orders and broker-like exits. It is inert until explicitly enabled:

```bash
export PAPER_AUTOMATION_ENABLED=true
export PAPER_CONTRACT_TICKER=NQZ6
export FEED_TOKEN='GENERATE_A_LONG_RANDOM_SECRET'
# Install your own *authorized, trustworthy, fresh* CME NQ 1-minute data forwarder.
npm start
```

Feed endpoint (from your own authorized data forwarder):

- `POST /api/feed/bar` with `Content-Type: application/json` and `X-Quant-Feed-Token: <FEED_TOKEN>`.
- JSON structure: `{"contract":"NQZ6","bar":{"t":"<ISO UTC 1m-open timestamp>","open":<NQ price>,"high":<NQ price>,"low":<NQ price>,"close":<NQ price>,"volume":123}}`.
- Input must be quarter-point-aligned, unique/monotonic, from the right dated contract, and no more than 120 seconds past the end of that bar. Stale/delayed bars and attempts to submit 8-hour-old candles are rejected. Startup mid-session will **refuse to generate retroactive positions**. Missing data during an open trade simulates an emergency exit at next observed open and halts further entries.
- **Authentication does not certify the source data**. Only use genuine entitled CME futures prices, not a guessed, unauthorized, or mislabeled feed. This is still **local simulation**, NOT an Alpaca/IBKR paper brokerage API integration, and has no exchange-held protective orders. Don't expose this endpoint to the public Internet; bind to localhost and use TLS and strong authentication if you add a trusted reverse proxy.

No genuinely free reliable CME NQ *fresh* API has been verified. CME licenses its market data; [its own real-time WebSocket API](https://www.cmegroup.com/market-data/real-time-futures-and-options-data-api.html) is a licensed product. A free TradingView chart and Massive Basic cannot replace that. Avoid Yahoo Finance unofficial scraping/automated endpoints.

## The trading rules (explicitly limited hypothesis)

- Market: **`CME_MINI:NQ1!`**, December/next quarterly contract selected explicitly at the data-provider level; real orders are **not** placed.
- Cash-session experiment in futures prices: first two NY 15-minute candles, 09:30–10:00 **America/New_York**. All opening 1-minute candles are required; missing bars mean no setup.
- Detect a close-confirmed opening-range breakout; enter on **next minute's open**, never the same bar's close. Both long and short signals tested.
- Opposite edge of range as SL, target at 1:1 reward:risk by default. Exit if the entry 15-minute block fails to confirm, or at 15:59 ET. Simulated stop before target if both touch in the same 1-minute bar. Adverse gap fills use observed next open, and can **lose more than the stop-budget estimate**.
- One filled position per day, no position overlap, configurable risk cap and contract size. Missing bars halt the day, and no startup back-filling of nonexistent live entries.
- **NQ: $20 per point / $5 per tick**; **MNQ: $2 per point / $0.50 per tick**. MNQ is an explicitly selected *paper sizing mode* using the same Nasdaq-100 underlying; default is NQ. At low risk budgets such as $15/trade, NQ often correctly produces **zero** entries.
- Fees, spread/slippage are **estimates**, not measured broker fills. No actual margin/funding model. `USD_ILS_RATE=0` means NIS P&L is **unknown** (not assumed exchange rate). The ₪50/day figure is an optional reference target; it never influences sizing or entry decisions.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Persistent local paper summary, open positions, trades, feed status |
| `GET /api/replay` | Latest offline paper replay |
| `POST /api/replay?riskUsd=15&contract=NQ` with CSV body | Compute historical paper simulation |
| `GET /api/backtest` | Latest historical ORB backtest |
| `POST /api/backtest` with CSV body | Compute research ORB backtest |
| `POST /api/feed/bar` | Authenticated fresh 1m futures candle for automatic local paper execution (disabled by default) |
| `GET /api/health` | Local process health |

## Honest limitations / next engineering steps

**The system is built and locally tested; it has not traded against a real authenticated CME feed** (no credentials supplied), was not deployed on your AWS server, and has not demonstrated any daily profit. It also has no licensed live broker order feed, and its bar-based protective fills cannot guarantee stop prices. It is insufficient to claim robust profitability from a tiny or synthetic sample.

Research quality will require a real multi-month NQ minute dataset, distinct in-sample/out-of-sample windows, conservative costs, CME calendar/early closes and futures rollover tracking, independent quote validation, and at least several weeks of stable paper monitoring. A target of ₪50 every day cannot be engineered as a certainty.

### Files (small, deliberate)

- `server.js`: minimal local dashboard/API and persistent storage
- `market.js`: strict minute-bar/CSV validation, NY timezone
- `strategy.js`: deterministic historical ORB backtest
- `engine.js`: stateful automatic **paper-only** fill + risk engine
- `massive.js`: free Massive CME historical provider adapter
- `scripts/download.js`, `scripts/sync.js`: historical data downloader & retrospective daily study
- `public/index.html`: responsive paper dashboard
- `test/`: automated tests
