# Quant Bloodline

Quant is a **paper-trading research system** for NASDAQ analysis. It runs a headless Chromium browser on the server, opens TradingView, captures fresh chart images, scrapes visible chart metadata, builds the Bloodline context, asks the private decision engine for structured actions, validates every requested action against hard risk rules, and executes only in a simulated wallet.

It does **not** place real-money orders.

## Current market source

There is **no Twelve Data or other market-data API** in this build.

Quant uses Playwright in headless mode to open TradingView directly.

Every cycle currently captures:

- NASDAQ 100 5m chart
- NASDAQ 100 15m chart
- NASDAQ 100 1h chart
- NASDAQ 100 4h chart
- visible chart legend values such as O/H/L/C when available
- symbol / interval / exchange
- TradingView market status such as delayed / market closed
- best-effort TradingView Technicals-page text for each timeframe
- a real PNG screenshot of every chart

The **latest 5m TradingView screenshot is shown directly in the Quant dashboard**, and the UI lets you switch between the four latest captured timeframes.

## Paper wallet

Defaults:

- Starting balance: **₪2,000**
- Leverage simulation: **1:40**
- Max margin per position: **₪450**
- Max loss-at-stop for a new trade: **₪15**
- Daily-loss kill switch: **₪120**
- Maximum open positions: **1**
- New positions require a stop loss
- Daily ₪40 value is a benchmark only — never a forced target

All limits are configurable in `.env`.

## AWS / Ubuntu 24.04

```bash
git clone https://github.com/1q21789tiasd/quant.git
cd quant

cp .env.example .env
nano .env

npm install

# Install Chromium + Linux packages Playwright needs.
sudo npx playwright install-deps chromium
npx playwright install chromium

npm start
```

Open:

```text
http://YOUR_EC2_PUBLIC_IP:3000
```

Allow inbound TCP 3000 in the EC2 security group, or put Nginx/Caddy in front of it.

For a public IP, set `DASHBOARD_PASSWORD`. Browser login:

- username: `quant`
- password: your `DASHBOARD_PASSWORD`

## Headless TradingView session

Chromium is launched with:

```text
headless: true
--no-sandbox
--disable-setuid-sandbox
--disable-dev-shm-usage
```

By default Quant uses public TradingView pages.

If you later want to reuse a logged-in TradingView browser state, export a Playwright storage-state JSON file on the server and set:

```env
TRADINGVIEW_STORAGE_STATE=/home/ubuntu/quant/private/tradingview-state.json
```

Do **not** commit that file.

## Runtime flow

```text
Every 15 minutes
      ↓
Headless Chromium
      ↓
TradingView 5m / 15m / 1h / 4h
      ↓
Real screenshots + visible O/H/L/C + TradingView technicals text
      ↓
Bloodline account + position + previous decisions
      ↓
private structured decision
      ↓
paperBroker.js validates actions
      ↓
simulated execution
      ↓
SQLite + context.md + live dashboard
```

## Database

SQLite is created automatically at:

```text
data/quant.db
```

It stores:

- market snapshots
- screenshot metadata
- every Bloodline cycle
- raw structured decision JSON
- every requested action
- executed and rejected actions
- open and closed positions
- TP / SL changes
- realized P/L
- daily reports
- system events

Generated TradingView screenshots are stored in:

```text
data/charts/
```

The complete Bloodline input plus every streamed model output delta is logged to:

```text
context.md
```

These runtime files are ignored by Git.

## Run continuously with systemd

Adjust the path/user in `deploy/quant.service` if needed:

```bash
sudo cp deploy/quant.service /etc/systemd/system/quant.service
sudo systemctl daemon-reload
sudo systemctl enable --now quant
sudo systemctl status quant
```

Logs:

```bash
journalctl -u quant -f
```

## Important source limitation

TradingView may show delayed market data depending on the symbol, session and account. Quant stores and shows TradingView's visible source-status label and the decision engine is instructed to respect it.

This paper simulator also approximates Plus500-style leveraged exposure; it is not an exact reproduction of Plus500 CFD contract pricing or execution.
