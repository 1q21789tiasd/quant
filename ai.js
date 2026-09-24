const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");

const API_URL = "https://api.tokun.sh/v1/responses";
const MODEL = "openai/gpt-5.6-luna";

const schema = {
  type:"object",
  properties:{
    marketState:{
      type:"object",
      properties:{
        bias:{type:"string",enum:["BULLISH","BEARISH","NEUTRAL"]},
        regime:{type:"string"},
        confidence:{type:"integer",minimum:0,maximum:100}
      },
      required:["bias","regime","confidence"],
      additionalProperties:false
    },
    actions:{
      type:"array",
      minItems:1,
      maxItems:6,
      items:{
        type:"object",
        properties:{
          type:{type:"string",enum:[
            "OPEN_POSITION","CLOSE_POSITION","CLOSE_PARTIAL",
            "SET_STOP_LOSS","MOVE_STOP_LOSS","REMOVE_STOP_LOSS",
            "SET_TAKE_PROFIT","MOVE_TAKE_PROFIT","REMOVE_TAKE_PROFIT",
            "DO_NOTHING"
          ]},
          side:{type:"string",enum:["BUY","SELL","NONE"]},
          marginNis:{type:"number",minimum:0},
          percentage:{type:"number",minimum:0,maximum:100},
          price:{type:"number",minimum:0},
          reason:{type:"string"}
        },
        required:["type","side","marginNis","percentage","price","reason"],
        additionalProperties:false
      }
    },
    summary:{type:"string"},
    confirmation:{type:"string"},
    invalidation:{type:"string"},
    riskNote:{type:"string"},
    changedSinceLastCycle:{type:"array",items:{type:"string"},maxItems:8}
  },
  required:["marketState","actions","summary","confirmation","invalidation","riskNote","changedSinceLastCycle"],
  additionalProperties:false
};

const SYSTEM = [
  "You are Quant Bloodline, the decision engine for a PAPER-TRADING research system.",
  "Your objective is long-term simulated account growth while obeying every hard risk rule.",
  "A daily profit benchmark may exist, but NEVER force a trade to hit it.",
  "Your market evidence comes from fresh headless TradingView chart captures across 5m, 15m, 1h and 4h, visible legend O/H/L/C values, source status, and TradingView Technicals text when available.",
  "Respect delayed-data or closed-market labels. Never pretend delayed data is live.",
  "Use all timeframes together. Prefer DO_NOTHING when there is no clean asymmetric setup or when source data is incomplete.",
  "Never assume data not present in BLOODLINE or the supplied TradingView screenshots.",
  "Never invent hidden candles, news, fundamentals, order flow, broker quotes or indicators.",
  "Never claim certainty or guaranteed profit.",
  "You can request operations only through the allowed action schema.",
  "For OPEN_POSITION: choose BUY or SELL, marginNis <= the supplied maximum, and include a SET_STOP_LOSS action in the SAME cycle.",
  "Do not open a second position if one is already open.",
  "When a position exists, decide whether to hold, close, partially close, or modify TP/SL.",
  "If the setup is invalidated, prioritize reducing or closing risk.",
  "The deterministic paper broker validates every requested action and may reject unsafe operations.",
  "Confidence is confidence in the observed setup, not probability of profit.",
  "Return only the strict structured response."
].join("\n");

function append(text) {
  if (!text) return;
  fs.appendFileSync(config.CONTEXT_FILE, text, "utf8");
}

function beginLog(bloodline) {
  const id = crypto.randomUUID();
  append("\n\n---\n\n# Bloodline cycle " + id + "\n\n");
  append("Time: " + new Date().toISOString() + "\n\n");
  append("## Full input context\n\n```json\n" + JSON.stringify(bloodline,null,2) + "\n```\n\n");
  append("## Assistant stream\n\n");
  return id;
}

function endLog(id, usage, error) {
  append("\n\n## Cycle metadata\n\n");
  append("Cycle log ID: " + id + "\n");
  if (usage) {
    append("Input tokens: " + (usage.input_tokens ?? "n/a") + "\n");
    append("Output tokens: " + (usage.output_tokens ?? "n/a") + "\n");
    append("Total tokens: " + (usage.total_tokens ?? "n/a") + "\n");
  }
  if (error) append("Error: " + error + "\n");
  append("\n---\n");
}

function imageContent(chartBuffers) {
  const order = ["5m","15m","1h","4h"];
  const parts = [];
  for (const tf of order) {
    const buffer = chartBuffers?.[tf];
    if (!buffer) continue;
    parts.push({type:"input_text",text:"TRADINGVIEW CHART — " + tf});
    parts.push({
      type:"input_image",
      image_url:"data:image/png;base64," + buffer.toString("base64"),
      detail:"original"
    });
  }
  return parts;
}

async function decide({ bloodline, chartBuffers }) {
  if (!process.env.TOKUN_API_KEY) {
    const e = new Error("Decision service is not configured");
    e.code = "decision_unavailable";
    throw e;
  }

  const logId = beginLog(bloodline);
  const controller = new AbortController();
  const timeout = setTimeout(()=>controller.abort(),90000);

  try {
    const content = [
      {type:"input_text",text:"BLOODLINE:\n" + JSON.stringify(bloodline)},
      ...imageContent(chartBuffers)
    ];

    if (content.length < 2) {
      const e = new Error("No chart images were captured");
      e.code = "decision_images_missing";
      throw e;
    }

    const res = await fetch(API_URL,{
      method:"POST",
      headers:{
        Authorization:"Bearer " + process.env.TOKUN_API_KEY,
        "Content-Type":"application/json",
        Accept:"text/event-stream"
      },
      body:JSON.stringify({
        model:MODEL,
        stream:true,
        store:false,
        max_output_tokens:2500,
        reasoning:{effort:"none"},
        input:[
          {role:"system",content:[{type:"input_text",text:SYSTEM}]},
          {role:"user",content}
        ],
        text:{format:{type:"json_schema",name:"quant_bloodline_decision",strict:true,schema}}
      }),
      signal:controller.signal
    });

    if (!res.ok) {
      const raw = await res.text();
      endLog(logId,null,"upstream " + res.status + ": " + raw.slice(0,1000));
      const e = new Error("Decision service request failed");
      e.code = "decision_request_failed";
      throw e;
    }
    if (!res.body) throw new Error("Decision service returned no stream");

    const reader=res.body.getReader();
    const decoder=new TextDecoder();
    let buf="",out="",usage=null,final=null,streamError=null;

    function event(block){
      const lines=block.split(/\r?\n/).filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trimStart());
      if(!lines.length)return;
      const data=lines.join("\n");
      if(!data||data==="[DONE]")return;
      try{
        const e=JSON.parse(data);
        if(e.type==="response.output_text.delta"&&typeof e.delta==="string"){
          append(e.delta);
          out+=e.delta;
        }else if(e.type==="response.completed"&&e.response){
          final=e.response;usage=e.response.usage||usage;
        }else if(e.type==="error"){
          streamError=e.error?.message||e.message||"stream error";
        }
      }catch{}
    }

    while(true){
      const {value,done}=await reader.read();
      if(value){
        buf+=decoder.decode(value,{stream:!done});
        let m;
        while((m=buf.match(/\r?\n\r?\n/))){
          const idx=m.index;
          const block=buf.slice(0,idx);
          buf=buf.slice(idx+m[0].length);
          event(block);
        }
      }
      if(done)break;
    }
    buf+=decoder.decode();
    if(buf.trim())event(buf);

    if(streamError)throw new Error(streamError);

    if(!out&&final){
      const parts=(final.output||[]).flatMap(x=>x.content||[]);
      out=final.output_text||parts.filter(x=>x.type==="output_text").map(x=>x.text||"").join("");
      if(out)append(out);
    }
    if(!out)throw new Error("Decision service returned no result");

    let parsed;
    try{parsed=JSON.parse(out)}catch{throw new Error("Decision service returned invalid structured data")}
    parsed.marketState.confidence=Math.max(0,Math.min(100,Number(parsed.marketState.confidence)||0));
    endLog(logId,usage,null);
    return parsed;
  } catch (error) {
    if(error.name==="AbortError"){
      endLog(logId,null,"timeout");
      const e=new Error("Decision timed out");e.code="decision_timeout";throw e;
    }
    endLog(logId,null,error.message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports={decide};
