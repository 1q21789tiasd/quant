# Quant — NQ1! Research

Primary market: CME_MINI:NQ1!
Chart: https://www.tradingview.com/chart/Q2Yhm4MH/

NQ1! is the continuous E-mini Nasdaq-100 futures chart.

## Components

- nq-futures.js — futures contract risk calculations
- nq-inspect.js — TradingView chart inspection
- nq.test.js — automated futures risk tests

## Run

npm install
node --test v2/nq.test.js
node v2/nq-inspect.js

## Important

TradingView screenshots may contain delayed CME quotes.
This project does not have a verified live NQ futures data feed.
The existing legacy paper broker is not futures-accurate.

Real-money trading is disabled.
