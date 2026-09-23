const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

const analysisSchema = {
  type: "object",
  properties: {
    instrument: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        name: { type: "string" },
        market: { type: "string", enum: ["stock", "index", "crypto", "forex", "futures", "unknown"] },
        exchange: { type: "string" },
        timeframe: { type: "string" },
        visiblePrice: { type: "number" }
      },
      required: ["symbol", "name", "market", "exchange", "timeframe", "visiblePrice"],
      additionalProperties: false
    },
    signal: {
      type: "string",
      enum: ["BUY", "SELL", "DO NOTHING"]
    },
    confidence: {
      type: "integer",
      minimum: 0,
      maximum: 100
    },
    setup: { type: "string" },
    entry: {
      type: "object",
      properties: {
        low: { type: "number" },
        high: { type: "number" }
      },
      required: ["low", "high"],
      additionalProperties: false
    },
    takeProfit: {
      type: "array",
      items: { type: "number" },
      minItems: 2,
      maxItems: 3
    },
    stopLoss: { type: "number" },
    riskReward: { type: "number" },
    trend: {
      type: "string",
      enum: ["bullish", "bearish", "neutral"]
    },
    momentum: {
      type: "string",
      enum: ["bullish", "bearish", "neutral"]
    },
    volume: {
      type: "string",
      enum: ["strong", "normal", "weak", "unavailable"]
    },
    keyLevels: {
      type: "object",
      properties: {
        support: {
          type: "array",
          items: { type: "number" },
          maxItems: 4
        },
        resistance: {
          type: "array",
          items: { type: "number" },
          maxItems: 4
        }
      },
      required: ["support", "resistance"],
      additionalProperties: false
    },
    reasons: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 6
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      maxItems: 4
    },
    summary: { type: "string" },
    imageQuality: {
      type: "string",
      enum: ["good", "usable", "poor"]
    }
  },
  required: [
    "instrument",
    "signal",
    "confidence",
    "setup",
    "entry",
    "takeProfit",
    "stopLoss",
    "riskReward",
    "trend",
    "momentum",
    "volume",
    "keyLevels",
    "reasons",
    "warnings",
    "summary",
    "imageQuality"
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `
You are Quant's visual chart-analysis engine.

You are given a screenshot of a financial chart, usually from TradingView. Your job is to extract what is visibly present and produce a conservative technical-analysis setup.

IMPORTANT RULES:
- This is screenshot-only analysis. Never pretend you have live prices, order books, news, fundamentals, or candles outside the visible screenshot.
- Read visible ticker, market/exchange, timeframe, price scale, indicators, volume, structure, support/resistance, trend, and recent price action.
- Prefer DO NOTHING whenever the image is ambiguous, cropped, low quality, has an unclear timeframe/ticker, has poor risk/reward, or lacks a clean setup.
- BUY and SELL are setup labels, not guarantees.
- Confidence means confidence that the visible chart supports the setup, NOT probability of profit.
- Use only prices that can be reasonably inferred from the screenshot's axis/labels. Do not invent precision.
- If exact prices are difficult to read, use conservative rounded values.
- Entry low/high define a zone. For DO NOTHING, both entry values may be 0, stopLoss may be 0, takeProfit should be [0, 0], and riskReward should be 0.
- For BUY: stop must be below the entry zone and targets above it.
- For SELL: stop must be above the entry zone and targets below it.
- If these constraints cannot be satisfied from visible evidence, choose DO NOTHING.
- Keep the summary concise and professional.
- Reasons must reference visible technical evidence, not vague AI language.
- warnings should mention screenshot limitations, nearby opposing levels, overextension, weak volume, or missing confirmation when relevant.
`;

function sanitizeResult(result) {
  const clean = structuredClone(result);

  clean.instrument.symbol = String(clean.instrument.symbol || "UNKNOWN").toUpperCase().slice(0, 24);
  clean.instrument.timeframe = String(clean.instrument.timeframe || "Unknown").slice(0, 24);
  clean.instrument.exchange = String(clean.instrument.exchange || "Unknown").slice(0, 40);
  clean.confidence = Math.max(0, Math.min(100, Number(clean.confidence) || 0));

  const numericFields = ["visiblePrice"];
  for (const key of numericFields) {
    clean.instrument[key] = Number(clean.instrument[key]) || 0;
  }

  clean.entry.low = Number(clean.entry.low) || 0;
  clean.entry.high = Number(clean.entry.high) || 0;
  clean.stopLoss = Number(clean.stopLoss) || 0;
  clean.riskReward = Number(clean.riskReward) || 0;
  clean.takeProfit = clean.takeProfit.map((n) => Number(n) || 0).slice(0, 3);
  clean.keyLevels.support = clean.keyLevels.support.map(Number).filter(Number.isFinite).slice(0, 4);
  clean.keyLevels.resistance = clean.keyLevels.resistance.map(Number).filter(Number.isFinite).slice(0, 4);

  if (clean.signal === "DO NOTHING") {
    clean.entry = { low: 0, high: 0 };
    clean.stopLoss = 0;
    clean.takeProfit = [0, 0];
    clean.riskReward = 0;
    clean.confidence = Math.min(clean.confidence, 85);
  }

  return clean;
}

async function analyzeChartImage({ buffer, mimeType, note = "" }) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not configured");
    error.status = 503;
    error.code = "service_not_configured";
    throw error;
  }

  const base64 = buffer.toString("base64");
  const imageUrl = `data:${mimeType};base64,${base64}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let response;
  try {
    response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        store: false,
        max_output_tokens: 1600,
        reasoning: { effort: "none" },
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: SYSTEM_PROMPT }]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: note
                  ? `Analyze this chart screenshot. User note: ${note.slice(0, 500)}`
                  : "Analyze this chart screenshot."
              },
              {
                type: "input_image",
                image_url: imageUrl,
                detail: "original"
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "quant_chart_analysis",
            strict: true,
            schema: analysisSchema
          }
        }
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI analysis timed out");
      timeoutError.status = 504;
      timeoutError.code = "ai_timeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(payload?.error?.message || "AI provider request failed");
    error.status = response.status;
    error.code = payload?.error?.code || "provider_error";
    throw error;
  }

  const contentParts = (payload.output || []).flatMap((item) => item.content || []);
  const outputText = payload.output_text || contentParts
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("");

  if (!outputText) {
    const refusal = contentParts.find((part) => part.type === "refusal")?.refusal;

    const error = new Error(refusal || "AI returned no analysis");
    error.status = 502;
    error.code = refusal ? "ai_refusal" : "empty_ai_response";
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    const error = new Error("AI returned invalid structured data");
    error.status = 502;
    error.code = "invalid_ai_response";
    throw error;
  }

  return {
    analysis: sanitizeResult(parsed),
    meta: {
      model: DEFAULT_MODEL,
      responseId: payload.id || null,
      inputTokens: payload.usage?.input_tokens ?? null,
      outputTokens: payload.usage?.output_tokens ?? null,
      totalTokens: payload.usage?.total_tokens ?? null
    }
  };
}

module.exports = {
  analyzeChartImage
};
