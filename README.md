# Quant — NQ1! research engine

Clean NQ1!-only version. No QQQ, Alpaca, old AI, scraping, or real-money orders.

**Market:** TradingView `CME_MINI:NQ1!` (continuous E-mini Nasdaq-100 futures). [Your TradingView layout](https://www.tradingview.com/chart/Q2Yhm4MH/).

This application is deliberately **historical research only**. A TradingView shared chart URL is **not a licensed real-time CME futures data API**. It does not pretend the displayed OHLC from a potentially delayed chart is executable. To analyze NQ1!, import your own properly licensed minute-bar CSV. Continuous future prices can be back-adjusted across rolls; results do not precisely represent contract fills.

## Setup

Requires Node.js 22+; **zero npm dependencies**.

```bash
npm start
# open http://127.0.0.1:3000
npm test
```

On AWS, put a reverse proxy with TLS/auth in front of this service; don't expose it unauthenticated. Optionally set `DASHBOARD_PASSWORD` via the shell, and use `HOST=127.0.0.1` behind Nginx.

## CSV data

Upload a CSV containing **real, consecutive, one-minute NQ OHLC bars** in ISO-8601 timestamps with explicit UTC timezone/offset, standard 0.25-point price increments:

```csv
timestamp,open,high,low,close
2026-10-12T13:30:00Z,22000,22001,21999,22000
2026-10-12T13:31:00Z,22000,22001,21999,22000
```

You need **all 390 one-minute candles for each normal 09:30–15:59 New York cash session** for the day to count; partial, missing or early-close sessions are skipped. The application does not fabricate missing data. The exported CSV may contain overnight bars, which are ignored in the current experiment. The strategy is a **cash-session opening range** applied to futures, not futures overnight breakout.

## Current strategy hypothesis

- Opening range from 09:30–09:59 ET (first two 15-min NYSE cash-session candles).
- After 10:00 ET, enter long on a candle closing above the opening high; enter short closing below the low, **at the next candle's open** (avoids close-price lookahead).
- Stop on opposite opening-range boundary; take profit 1:1 based on actual modeled entry. Exit after the entry's 15-min block doesn't confirm, otherwise by 15:59.
- NQ contract multiplier $20/point, 0.25 point/tick, no fractional contracts. Same-bar stop/target ambiguity resolves pessimistically to stop. Slippage and round-trip fee are configurable.
- Max 1 trade per NY cash session. Daily limit is a fail-safe, not a profit objective.
- Risk cap defaults $15 per trade with fake $600 start. **Normal NQ stops frequently exceed this budget, so the correct result may be zero trades.** For example, 10 index points = $200 loss/contract before fees/slippage. Do not increase leverage or falsify risk to force trades.

## Important limitations

No live CME feed, broker margin/funding, real order routing, real-time alerts, or account connection. The latest backtest is stored locally in ignored `data/last-backtest.json`. Profits are hypothetical. Fill models do not recreate order-book executions or continuous-futures rolls. Backtest survival and profitability should be checked with multiple out-of-sample periods and licensed data before considering a live system.

## Files

- `market.js`: NQ CSV parsing, tick validation, New York session grouping.
- `strategy.js`: contract risk math, ORB execution model, P&L and drawdown.
- `server.js`: localhost API and dashboard serving.
- `public/index.html`: dashboard and TradingView link.
- `test/quant.test.js`: deterministic tests, including DST, risk, and stop gaps.
