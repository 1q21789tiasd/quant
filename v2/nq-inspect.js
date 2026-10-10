#!/usr/bin/env node
'use strict';
// Read-only NQ chart inspection using the existing Playwright TradingView collector.
// IMPORTANT: TradingView quotes may be delayed by 10 minutes on free accounts.
// No paper positions, no real orders, no auto-entry.
require('dotenv').config();
const config=require('../config'),market=require('../tradingView');
(async()=>{
  if(config.TRADINGVIEW_SYMBOL!=='CME_MINI:NQ1!')throw new Error('This inspector is pinned to CME_MINI:NQ1!. Set TRADINGVIEW_SYMBOL correctly.');
  const capture=await market.captureMarket();
  console.log(JSON.stringify({
    chartUrl:config.TRADINGVIEW_CHART_URL,
    requestedSymbol:config.TRADINGVIEW_SYMBOL,
    source: capture.source,
    capturedAt: capture.capturedAt,
    reportedPrice:capture.price,
    sourceStatus:capture.status,
    timeframeStatus:Object.fromEntries(Object.entries(capture.frames).map(([k,v])=>[k,{title:v.title,interval:v.interval,status:v.status,ohlc:v.ohlc,chartPath:v.chartPath}])),
    notice:'Chart capture is NOT a licensed CME API, nor a verified live bar stream. Delayed quotes / mismatched layout may be present. No trading performed.'
  },null,2));
})().catch(e=>{console.error('NQ inspector failed:',e.message);process.exitCode=1})
.finally(async()=>{await market.closeBrowser().catch(()=>{});});
