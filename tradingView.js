const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const config = require("./config");
const logger = require("./logger");

let browserPromise = null;

function n(v) {
  if (v == null) return null;
  const cleaned = String(v)
    .replace(/[\u2212\u2013\u2014]/g, "-")
    .replace(/,/g, "")
    .replace(/\s+/g, " ");
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const x = Number(m[0]);
  return Number.isFinite(x) ? x : null;
}

async function getBrowser() {
  if (!browserPromise) {
    logger.log("PLAYWRIGHT","Launching headless Chromium",{viewport:"1920x1080"});
    browserPromise = chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    }).then(browser => {
      logger.log("PLAYWRIGHT","Chromium launched");
      return browser;
    }).catch(error => {
      browserPromise = null;
      logger.error("PLAYWRIGHT","Chromium launch failed",error);
      throw error;
    });
  }
  return browserPromise;
}

function storageStateOption() {
  const p = config.TRADINGVIEW_STORAGE_STATE;
  return p && fs.existsSync(p) ? p : undefined;
}

async function newContext() {
  const browser = await getBrowser();
  return browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    storageState: storageStateOption(),
    userAgent: config.TRADINGVIEW_USER_AGENT
  });
}

async function dismissNoise(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept cookies")',
    'button:has-text("I agree")',
    'button:has-text("Allow all")',
    '[data-name="accept-all"]'
  ];

  for (const selector of selectors) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 500 })) {
        await el.click({ timeout: 1200 });
        await page.waitForTimeout(120);
      }
    } catch {}
  }

  // TradingView sometimes injects the consent banner after the chart itself has loaded.
  // If clicking the button did not remove it, hide only small fixed/sticky consent overlays.
  try {
    await page.evaluate(() => {
      const patterns = [
        "this website uses cookies",
        "accept all",
        "accept cookies",
        "our policy"
      ];

      const nodes = Array.from(document.querySelectorAll("body *"));
      for (const node of nodes) {
        const own = (node.textContent || "").trim().toLowerCase();
        if (!own || !patterns.some(p => own.includes(p))) continue;

        let cur = node;
        for (let depth = 0; depth < 7 && cur && cur !== document.body; depth++, cur = cur.parentElement) {
          const style = getComputedStyle(cur);
          const rect = cur.getBoundingClientRect();

          if (
            (style.position === "fixed" || style.position === "sticky") &&
            rect.width > 100 &&
            rect.width < 1000 &&
            rect.height > 20 &&
            rect.height < 360
          ) {
            cur.style.setProperty("display", "none", "important");
            break;
          }
        }
      }
    });
  } catch {}
}

async function text(page, selector) {
  try {
    const el = page.locator(selector).first();
    await el.waitFor({ state: "attached", timeout: 2500 });
    return (await el.innerText()).trim();
  } catch {
    return "";
  }
}

async function valueBlock(page, key) {
  const raw = await text(page, '[data-test-id-value-title="' + key + '"]');
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  return n(lines[lines.length - 1]);
}

function chartUrl(interval) {
  const u = new URL(config.TRADINGVIEW_CHART_URL);
  u.searchParams.set("symbol", config.TRADINGVIEW_SYMBOL);
  u.searchParams.set("interval", String(interval));
  return u.toString();
}

function technicalsUrl(intervalName) {
  const base = config.TRADINGVIEW_TECHNICALS_URL ||
    ("https://www.tradingview.com/symbols/" + config.TRADINGVIEW_SYMBOL.replace(":", "-") + "/technicals/");
  const u = new URL(base);
  u.searchParams.set("interval", intervalName);
  return u.toString();
}

async function waitForChart(page) {
  await page.waitForSelector('[data-qa-id="pane-top-canvas"]', { timeout: 45000 });
  await page.waitForTimeout(config.TRADINGVIEW_SETTLE_MS);
}

async function captureFrame(page, label, interval, signal) {
  if(signal?.aborted){
    const e=new Error("TradingView capture cancelled");
    e.name="AbortError";e.code="cycle_cancelled";throw e;
  }

  logger.log("PLAYWRIGHT","Loading TradingView chart",{timeframe:label,interval});
  const started=Date.now();

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(chartUrl(interval), { waitUntil: "domcontentloaded", timeout: 60000 });
  await dismissNoise(page);
  await waitForChart(page);
  await dismissNoise(page);
  await page.waitForTimeout(250);

  const title = await text(page, 'button[aria-label="Change symbol"]');
  const intervalText = await text(page, '[data-qa-id="title-wrapper legend-source-interval"] button');
  const exchange = await text(page, '[data-qa-id="title-wrapper legend-source-exchange"]');
  const status = await text(page, '[data-role="statuses-pill"]');

  const ohlc = {
    open: await valueBlock(page, "O"),
    high: await valueBlock(page, "H"),
    low: await valueBlock(page, "L"),
    close: await valueBlock(page, "C")
  };

  const buy = n(await text(page, '[data-name="buy-order-button"]'));
  const sell = n(await text(page, '[data-name="sell-order-button"]'));
  const price = ohlc.close ?? (
    Number.isFinite(buy) && Number.isFinite(sell) ? (buy + sell) / 2 :
    Number.isFinite(buy) ? buy :
    Number.isFinite(sell) ? sell :
    null
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = stamp + "-" + label + ".png";
  const fullPath = path.join(config.CHART_DIR, filename);
  fs.mkdirSync(config.CHART_DIR, { recursive: true });

  const container = page.locator('[data-qa-id="chart-container"]').first();
  let captureSize = { width: 1920, height: 1080 };

  await dismissNoise(page);

  if (await container.count()) {
    const box = await container.boundingBox().catch(() => null);
    if (box) {
      captureSize = {
        width: Math.round(box.width),
        height: Math.round(box.height)
      };
    }
    await container.screenshot({ path: fullPath });
  } else {
    await page.screenshot({ path: fullPath, fullPage: false });
  }

  logger.log("PLAYWRIGHT","Chart screenshot saved",{
    timeframe:label,
    price,
    ohlc,
    captureSize,
    file:filename,
    ms:Date.now()-started
  });

  return {
    label,
    requestedInterval: String(interval),
    title: title || config.MARKET_DISPLAY_NAME,
    interval: intervalText || label,
    exchange: exchange || "",
    status: status || "",
    ohlc,
    buy,
    sell,
    price,
    capturedAt: new Date().toISOString(),
    captureSize,
    chartPath: "/charts/" + filename,
    fullPath,
    buffer: fs.readFileSync(fullPath)
  };
}

function technicalExcerpt(raw) {
  const lines = String(raw || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.length) return [];

  const start = lines.findIndex(x => /^oscillators$/i.test(x));
  const interesting = /Oscillators|Moving Averages|Summary|Relative Strength|Stochastic|Commodity Channel|Directional|Awesome|Momentum|MACD|Williams|Bull Bear|Ultimate|Exponential Moving Average|Simple Moving Average|Hull Moving Average|Ichimoku|VWMA|Pivot/i;

  if (start >= 0) return lines.slice(start, start + 180);
  return lines.filter(x => interesting.test(x)).slice(0, 180);
}

async function scrapeTechnicals(page, intervalName, signal) {
  try {
    if(signal?.aborted){
      const e=new Error("Technicals capture cancelled");
      e.name="AbortError";e.code="cycle_cancelled";throw e;
    }

    logger.log("PLAYWRIGHT","Loading TradingView technicals",{timeframe:intervalName});
    await page.goto(technicalsUrl(intervalName), { waitUntil: "domcontentloaded", timeout: 60000 });
    await dismissNoise(page);
    await page.waitForTimeout(3500);
    const raw = await page.locator("body").innerText({ timeout: 10000 });
    const lines=technicalExcerpt(raw);
    logger.log("PLAYWRIGHT","Technicals captured",{timeframe:intervalName,lines:lines.length});
    return {
      url: page.url(),
      capturedAt: new Date().toISOString(),
      lines
    };
  } catch (error) {
    if(signal?.aborted||error?.name==="AbortError")throw error;
    logger.warn("PLAYWRIGHT","Technicals page could not be read",{timeframe:intervalName,message:error.message});
    return {
      url: technicalsUrl(intervalName),
      capturedAt: new Date().toISOString(),
      lines: [],
      error: "Technicals page could not be read"
    };
  }
}

async function captureMarket({ signal } = {}) {
  logger.log("PLAYWRIGHT","Starting TradingView capture session");
  const context = await newContext();

  const abortCapture = () => {
    context.close().catch(() => {});
  };

  if (signal?.aborted) {
    await context.close().catch(() => {});
    const error = new Error("TradingView capture cancelled");
    error.name = "AbortError";
    error.code = "cycle_cancelled";
    throw error;
  }

  signal?.addEventListener("abort", abortCapture, { once: true });

  const chartPage = await context.newPage();
  const techPage = await context.newPage();

  const frames = {};
  const images = {};
  const map = [
    ["5m", "5", "5m"],
    ["15m", "15", "15m"],
    ["1h", "60", "1h"],
    ["4h", "240", "4h"]
  ];

  try {
    for (const [label, interval, technicalInterval] of map) {
      let frame;
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if(signal?.aborted){
            const e=new Error("TradingView capture cancelled");
            e.name="AbortError";e.code="cycle_cancelled";throw e;
          }

          frame = await captureFrame(chartPage, label, interval, signal);
          break;
        } catch (error) {
          lastError = error;
          if(signal?.aborted||error?.name==="AbortError")throw error;
          logger.warn("PLAYWRIGHT","Chart capture attempt failed",{
            timeframe:label,
            attempt,
            message:error.message
          });
          if (attempt < 2) await chartPage.waitForTimeout(2000);
        }
      }
      if (!frame) throw lastError || new Error("TradingView chart capture failed");

      const technicals = config.TRADINGVIEW_SCRAPE_TECHNICALS
        ? await scrapeTechnicals(techPage, technicalInterval, signal)
        : { lines: [] };

      images[label] = frame.buffer;
      frames[label] = {
        label: frame.label,
        title: frame.title,
        interval: frame.interval,
        exchange: frame.exchange,
        status: frame.status,
        ohlc: frame.ohlc,
        buy: frame.buy,
        sell: frame.sell,
        price: frame.price,
        capturedAt: frame.capturedAt,
        captureSize: frame.captureSize,
        chartPath: frame.chartPath,
        technicals
      };
    }

    const main = frames["5m"];
    const price = main?.price ?? main?.ohlc?.close;
    if (!Number.isFinite(Number(price))) {
      const e = new Error("TradingView price could not be extracted");
      e.code = "tradingview_price_missing";
      throw e;
    }

    logger.log("PLAYWRIGHT","TradingView capture session complete",{
      price:Number(price),
      timeframes:Object.keys(frames)
    });

    return {
      source: "TradingView",
      symbol: config.TRADINGVIEW_SYMBOL,
      name: main?.title || config.MARKET_DISPLAY_NAME,
      price: Number(price),
      capturedAt: new Date().toISOString(),
      status: main?.status || "",
      frames,
      images
    };
  } catch (error) {
    if (signal?.aborted) {
      logger.warn("PLAYWRIGHT","TradingView capture session cancelled");
      const cancelled = new Error("TradingView capture cancelled");
      cancelled.name = "AbortError";
      cancelled.code = "cycle_cancelled";
      throw cancelled;
    }
    logger.error("PLAYWRIGHT","TradingView capture session failed",error);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortCapture);
    await context.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {}
  browserPromise = null;
}

module.exports = { captureMarket, closeBrowser };
