const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const config = require("./config");

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}

function buildSvg(market) {
  const candles = market.candles["5m"].slice(-110);
  const W = 1280, H = 720;
  const L = 72, R = 110, T = 76, B = 76;
  const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
  let max = Math.max(...highs), min = Math.min(...lows);
  const pad = Math.max((max-min)*0.08, market.price*0.0005);
  max += pad; min -= pad;
  const px = i => L + (i + .5) * (W-L-R) / candles.length;
  const py = v => T + (max-v)/(max-min) * (H-T-B);
  const step = (W-L-R)/candles.length;
  const bw = Math.max(2, Math.min(7, step*.55));
  const parts = [];

  parts.push('<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'">');
  parts.push('<rect width="100%" height="100%" fill="#08090a"/>');
  parts.push('<text x="'+L+'" y="34" fill="#f2f2ef" font-family="Arial,sans-serif" font-size="22" font-weight="700">'+esc(market.name)+'</text>');
  parts.push('<text x="'+L+'" y="57" fill="#777d82" font-family="Arial,sans-serif" font-size="13">'+esc(market.symbol)+' · 5 minute · '+esc(market.ts)+'</text>');

  for(let i=0;i<=6;i++){
    const y=T+i*(H-T-B)/6;
    const v=max-(max-min)*i/6;
    parts.push('<line x1="'+L+'" y1="'+y+'" x2="'+(W-R)+'" y2="'+y+'" stroke="#1b1e21" stroke-width="1"/>');
    parts.push('<text x="'+(W-R+14)+'" y="'+(y+4)+'" fill="#62686d" font-family="Arial,sans-serif" font-size="12">'+v.toFixed(2)+'</text>');
  }
  for(let i=0;i<=8;i++){
    const x=L+i*(W-L-R)/8;
    parts.push('<line x1="'+x+'" y1="'+T+'" x2="'+x+'" y2="'+(H-B)+'" stroke="#15181a" stroke-width="1"/>');
  }

  candles.forEach((c,i)=>{
    const x=px(i), yo=py(c.open), yc=py(c.close), yh=py(c.high), yl=py(c.low);
    const up=c.close>=c.open;
    const color=up?"#d9dcdd":"#70777c";
    parts.push('<line x1="'+x+'" y1="'+yh+'" x2="'+x+'" y2="'+yl+'" stroke="'+color+'" stroke-width="1"/>');
    parts.push('<rect x="'+(x-bw/2)+'" y="'+Math.min(yo,yc)+'" width="'+bw+'" height="'+Math.max(2,Math.abs(yc-yo))+'" fill="'+color+'" rx="1"/>');
  });

  const lastY=py(market.price);
  parts.push('<line x1="'+L+'" y1="'+lastY+'" x2="'+(W-R)+'" y2="'+lastY+'" stroke="#aeb3b6" stroke-width="1" stroke-dasharray="4 5" opacity=".55"/>');
  parts.push('<rect x="'+(W-R+4)+'" y="'+(lastY-12)+'" width="88" height="24" rx="3" fill="#e5e6e4"/>');
  parts.push('<text x="'+(W-R+48)+'" y="'+(lastY+5)+'" text-anchor="middle" fill="#090a0b" font-family="Arial,sans-serif" font-size="12" font-weight="700">'+market.price.toFixed(2)+'</text>');
  parts.push('<text x="'+L+'" y="'+(H-28)+'" fill="#545a5f" font-family="Arial,sans-serif" font-size="12">Quant Bloodline · generated from real OHLC data</text>');
  parts.push('</svg>');
  return parts.join("");
}

async function renderChart(market) {
  fs.mkdirSync(config.CHART_DIR,{recursive:true});
  const stamp = new Date().toISOString().replace(/[:.]/g,"-");
  const filename = stamp + ".png";
  const full = path.join(config.CHART_DIR, filename);
  const svg = buildSvg(market);
  await sharp(Buffer.from(svg)).png().toFile(full);
  return {
    fullPath: full,
    publicPath: "/charts/" + filename,
    buffer: fs.readFileSync(full)
  };
}

module.exports = { renderChart };
