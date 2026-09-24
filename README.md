# Quant Bloodline

Quant is a **paper-trading research system** for NASDAQ analysis. It runs an automated cycle every 15 minutes, builds deterministic multi-timeframe market calculations, generates a fresh chart image, asks the private decision engine for structured actions, validates every requested action against hard risk rules, executes them only in a simulated wallet, and stores the full history in SQLite.

It does **not** place real-money orders.

## What it does

- Starting paper balance: configurable, default **₪2,000**
- Leverage simulation: configurable, default **1:40**
- Max margin per position: configurable, default **₪450**
- Max loss-at-stop per new trade: configurable, default **₪15**
- Daily-loss kill switch
- One open position maximum
- Mandatory stop loss for a new position
- 15-minute automated Bloodline cycle
- 5m / 15m / 1h / 4h calculations
- EMA 20/50/200, RSI, ATR, MACD, ADX, VWAP, relative volume, swings, support/resistance and structure
- Fresh PNG chart generated from real OHLC data each cycle
- Structured actions: open, close, partial close, set/move/remove TP, set/move/replace SL, or do nothing
- SQLite persistence for snapshots, decisions, actions, positions, events and daily reports
- Live browser dashboard over the EC2 IP
- Server-Sent Events for immediate UI refresh
- Full private cycle logging to `context.md`

The daily ₪40 value is a **benchmark**, not a forced objective. The decision prompt explicitly forbids taking a trade just to hit the benchmark.

## AWS / Ubuntu quick start

```bash
git clone https://github.com/1q21789tiasd/quant.git
cd quant

cp .env.example .env
nano .env

npm install
npm start
```

Open:

```text
http://YOUR_EC2_PUBLIC_IP:3000
```

Allow inbound TCP port **3000** in the EC2 security group, or put Nginx/Caddy in front of it.

For a public IP, set `DASHBOARD_PASSWORD` in `.env`. The browser will prompt for Basic Auth:

- username: `quant`
- password: the value of `DASHBOARD_PASSWORD`

## Run with systemd

Adjust the paths or user in `deploy/quant.service` if needed.

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

## Data

Runtime data is intentionally not committed:

```text
data/quant.db
data/charts/*.png
context.md
```

The SQLite database is created automatically.

## Market feed

The current implementation requests real 5-minute OHLC data from Twelve Data and derives 15m, 1h and 4h frames locally. Set:

```env
TWELVE_DATA_API_KEY=...
MARKET_SYMBOL=NDX
```

Use a provider-supported NASDAQ instrument symbol that matches the market you intend to simulate. A broker CFD quote can differ from a cash index or futures feed, so this paper engine should not be treated as an exact Plus500 execution replica.

## Safety architecture

The private decision engine cannot directly modify money or positions. It returns JSON instructions. `paperBroker.js` validates and executes them.

Examples of hard rejections:

- margin above the configured maximum
- second simultaneous position
- opening without a stop loss
- stop loss on the wrong side
- stop distance exceeding the maximum simulated loss
- new trades after the daily-loss kill switch triggers

This separation is intentional: model output is advisory to the simulator; the deterministic broker owns account state.
