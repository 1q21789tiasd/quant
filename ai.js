const fs = require("fs");
const path = require("path");

const TOKUN_API_URL = "https://api.tokun.sh/v1/responses";
const MODEL = "openai/gpt-5.6-luna";

const logging_to_file = true;
const CONTEXT_FILE = process.env.VERCEL
  ? "/tmp/context.md"
  : path.join(__dirname, "context.md");

function appendContext(text) {
  if (!logging_to_file || !text) return;
  fs.appendFileSync(CONTEXT_FILE, text, "utf8");
}

function startContextSession() {
  if (!logging_to_file) return;

  appendContext(
    `\n\n---\n\n# Quant Session\n\n` +
    `Started: ${new Date().toISOString()}\n` +
    `Provider: Tokun\n` +
    `Model: ${MODEL}\n` +
    `Logging: live / unbuffered\n\n`
  );
}

function startContextRequest({ mimeType, bytes, note }) {
  const requestId = crypto.randomUUID();

  appendContext(
    `## Request ${requestId}\n\n` +
    `Time: ${new Date().toISOString()}\n` +
    `Input: chart screenshot (${mimeType}, ${bytes} bytes)\n` +
    (note ? `User note: ${note}\n` : "") +
    `\n### Assistant (live)\n\n`
  );

  return requestId;
}

function finishContextRequest({ requestId, responseId, usage, error }) {
  appendContext(
    `\n\n### Request metadata\n\n` +
    `Request ID: ${requestId}\n` +
    `Provider response ID: ${responseId || "n/a"}\n` +
    `Input tokens: ${usage?.input_tokens ?? "n/a"}\n` +
    `Output tokens: ${usage?.output_tokens ?? "n/a"}\n` +
    `Total tokens: ${usage?.total_tokens ?? "n/a"}\n` +
    (error ? `Error: ${error}\n` : "") +
    `\n---\n\n`
  );
}

startContextSession();

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
    signal: { type: "string", enum: ["BUY", "SELL", "DO NOTHING"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    setup: { type: "string" },
    summary: { type: "string" },
    imageQuality: { type: "string", enum: ["good", "usable", "poor"] },
    entry: {
      type: "object",
      properties: { low: { type: "number" }, high: { type: "number" } },
      required: ["low", "high"],
      additionalProperties: false
    },
    takeProfit: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 3 },
    stopLoss: { type: "number" },
    riskReward: { type: "number" },
    trend: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    momentum: { type: "string", enum: ["bullish", "bearish", "neutral"] },
    volume: { type: "string", enum: ["strong", "normal", "weak", "unavailable"] },
    visibleIndicators: { type: "array", items: { type: "string" }, maxItems: 10 },
    keyLevels: {
      type: "object",
      properties: {
        support: { type: "array", items: { type: "number" }, maxItems: 5 },
        resistance: { type: "array", items: { type: "number" }, maxItems: 5 }
      },
      required: ["support", "resistance"],
      additionalProperties: false
    },
    marketStructure: {
      type: "object",
      properties: {
        trendDescription: { type: "string" },
        supportContext: { type: "string" },
        resistanceContext: { type: "string" },
        pattern: { type: "string" }
      },
      required: ["trendDescription", "supportContext", "resistanceContext", "pattern"],
      additionalProperties: false
    },
    tradePlan: {
      type: "object",
      properties: {
        actionNow: { type: "string" },
        confirmation: { type: "string" },
        invalidation: { type: "string" },
        management: { type: "string" }
      },
      required: ["actionNow", "confirmation", "invalidation", "management"],
      additionalProperties: false
    },
    scenarios: {
      type: "object",
      properties: {
        bullish: { type: "string" },
        bearish: { type: "string" },
        neutral: { type: "string" }
      },
      required: ["bullish", "bearish", "neutral"],
      additionalProperties: false
    },
    reasons: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 8 },
    whatChangesSignal: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 6 },
    warnings: { type: "array", items: { type: "string" }, maxItems: 6 }
  },
  required: [
    "instrument","signal","confidence","setup","summary","imageQuality","entry","takeProfit",
    "stopLoss","riskReward","trend","momentum","volume","visibleIndicators","keyLevels",
    "marketStructure","tradePlan","scenarios","reasons","whatChangesSignal","warnings"
  ],
  additionalProperties: false
};

const SYSTEM_PROMPT = `
You are Quant's visual chart-analysis engine.

You receive one screenshot of a financial chart, usually from TradingView. Build a detailed, conservative technical-analysis report from ONLY what is visible in the image.

CORE RULES:
- Never pretend you have live prices, order books, news, fundamentals, hidden candles, or data outside the screenshot.
- Read the visible ticker, exchange/market, timeframe, current visible price, candle structure, visible indicators, volume, support/resistance, trend, momentum and chart patterns.
- Prefer DO NOTHING when the screenshot is ambiguous, cropped, poor quality, missing important context, has conflicting structure, poor risk/reward, or no clean confirmation.
- BUY and SELL are chart-setup labels, not promises or personalized investment recommendations.
- Confidence means confidence that the visible screenshot supports the setup, NOT probability of profit.
- Never invent an indicator that is not visibly present.
- Never invent exact price precision. If a level is approximate, use conservative rounded values.
- Explain WHY every conclusion was reached with visible evidence.

TRADE PLAN:
- actionNow: what the chart setup suggests doing now in plain language. For example, wait for confirmation, avoid chasing, or monitor the entry zone.
- confirmation: the specific visible price action that would strengthen the setup.
- invalidation: the specific visible condition or level that would invalidate the thesis.
- management: a conservative description of how the setup would be managed if triggered.
- For BUY: stop must be below the entry zone and targets above it.
- For SELL: stop must be above the entry zone and targets below it.
- For DO NOTHING: entry low/high = 0, stopLoss = 0, takeProfit = [0,0], riskReward = 0. The action plan must explain what to wait for instead.

SCENARIOS:
- bullish: what visible development would favor upside.
- bearish: what visible development would favor downside.
- neutral: what would keep the chart untradeable or range-bound.

OUTPUT QUALITY:
- reasons: 4-8 concrete visible reasons.
- whatChangesSignal: 2-6 concrete events/levels that could change the verdict.
- warnings: screenshot limitations, nearby opposing levels, overextension, weak volume, missing confirmation, or ambiguity.
- marketStructure fields should be specific, concise and useful.
- summary should be 2-4 sentences and explain the setup clearly.
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
  if (!process.env.TOKUN_API_KEY) {
    const error = new Error("TOKUN_API_KEY is not configured");
    error.status = 503;
    error.code = "service_not_configured";
    throw error;
  }

  const base64 = buffer.toString("base64");
  const imageUrl = `data:${mimeType};base64,${base64}`;
  const requestId = startContextRequest({
    mimeType,
    bytes: buffer.length,
    note: String(note || "").slice(0, 500)
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let response;

  try {
    response = await fetch(TOKUN_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TOKUN_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        store: false,
        max_output_tokens: 3000,
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

    if (!response.ok) {
      const raw = await response.text();
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {}

      const message = payload?.error?.message || raw || "AI provider request failed";
      finishContextRequest({
        requestId,
        responseId: payload?.id || null,
        usage: payload?.usage || null,
        error: `${response.status}: ${message}`
      });

      const error = new Error(message);
      error.status = response.status;
      error.code = payload?.error?.code || "provider_error";
      throw error;
    }

    if (!response.body) {
      const error = new Error("AI provider returned no response stream");
      error.status = 502;
      error.code = "empty_ai_stream";
      finishContextRequest({ requestId, error: error.message });
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let sseBuffer = "";
    let outputText = "";
    let reasoningText = "";
    let refusalText = "";
    let responseId = null;
    let usage = null;
    let finalResponse = null;
    let streamError = null;
    let reasoningHeaderWritten = false;
    let refusalHeaderWritten = false;
    let assistantHeaderRestored = true;

    function writeReasoning(delta) {
      if (!delta) return;
      if (!reasoningHeaderWritten) {
        appendContext("\n\n#### Reasoning stream\n\n");
        reasoningHeaderWritten = true;
        assistantHeaderRestored = false;
      }
      appendContext(delta);
      reasoningText += delta;
    }

    function writeAssistant(delta) {
      if (!delta) return;
      if (!assistantHeaderRestored) {
        appendContext("\n\n#### Assistant output\n\n");
        assistantHeaderRestored = true;
      }
      // IMPORTANT: append immediately for every provider delta.
      // Nothing is buffered before being written to context.md.
      appendContext(delta);
      outputText += delta;
    }

    function writeRefusal(delta) {
      if (!delta) return;
      if (!refusalHeaderWritten) {
        appendContext("\n\n#### Refusal stream\n\n");
        refusalHeaderWritten = true;
      }
      appendContext(delta);
      refusalText += delta;
    }

    function handleEvent(event) {
      if (!event || typeof event !== "object") return;

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        writeAssistant(event.delta);
        return;
      }

      if (
        (event.type === "response.reasoning_summary_text.delta" ||
         event.type === "response.reasoning_text.delta") &&
        typeof event.delta === "string"
      ) {
        writeReasoning(event.delta);
        return;
      }

      if (event.type === "response.refusal.delta" && typeof event.delta === "string") {
        writeRefusal(event.delta);
        return;
      }

      if (event.type === "response.completed" && event.response) {
        finalResponse = event.response;
        responseId = event.response.id || responseId;
        usage = event.response.usage || usage;
        return;
      }

      if (event.type === "error") {
        streamError =
          event.error?.message ||
          event.message ||
          "AI provider stream failed";
      }
    }

    function consumeSseBlock(block) {
      if (!block.trim()) return;

      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (!dataLines.length) return;

      const data = dataLines.join("\n");
      if (!data || data === "[DONE]") return;

      try {
        handleEvent(JSON.parse(data));
      } catch {
        // Never dump raw SSE JSON into context.md.
        // Only readable provider output deltas are written there.
      }
    }

    while (true) {
      const { value, done } = await reader.read();

      if (value) {
        sseBuffer += decoder.decode(value, { stream: !done });

        let boundary;
        while ((boundary = sseBuffer.search(/\r?\n\r?\n/)) !== -1) {
          const block = sseBuffer.slice(0, boundary);
          const match = sseBuffer.slice(boundary).match(/^(\r?\n){2}/);
          sseBuffer = sseBuffer.slice(boundary + (match ? match[0].length : 2));
          consumeSseBlock(block);
        }
      }

      if (done) break;
    }

    sseBuffer += decoder.decode();
    if (sseBuffer.trim()) consumeSseBlock(sseBuffer);

    if (streamError) {
      finishContextRequest({
        requestId,
        responseId,
        usage,
        error: streamError
      });

      const error = new Error(streamError);
      error.status = 502;
      error.code = "provider_stream_error";
      throw error;
    }

    // Some OpenAI-compatible providers may only expose the final response
    // at completion. Use it only as a fallback, never duplicate streamed text.
    if (!outputText && finalResponse) {
      const contentParts = (finalResponse.output || []).flatMap((item) => item.content || []);
      outputText = finalResponse.output_text || contentParts
        .filter((part) => part.type === "output_text")
        .map((part) => part.text || "")
        .join("");

      if (outputText) appendContext(outputText);

      if (!refusalText) {
        refusalText = contentParts
          .filter((part) => part.type === "refusal")
          .map((part) => part.refusal || "")
          .join("");
      }
    }

    if (!outputText) {
      const message = refusalText || "AI returned no analysis";
      finishContextRequest({
        requestId,
        responseId,
        usage,
        error: message
      });

      const error = new Error(message);
      error.status = 502;
      error.code = refusalText ? "ai_refusal" : "empty_ai_response";
      throw error;
    }

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch {
      finishContextRequest({
        requestId,
        responseId,
        usage,
        error: "AI returned invalid structured data"
      });

      const error = new Error("AI returned invalid structured data");
      error.status = 502;
      error.code = "invalid_ai_response";
      throw error;
    }

    finishContextRequest({
      requestId,
      responseId,
      usage
    });

    return {
      analysis: sanitizeResult(parsed),
      meta: {
        model: MODEL,
        provider: "tokun",
        responseId: responseId || null,
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null
      }
    };
  } catch (error) {
    if (error.name === "AbortError") {
      finishContextRequest({
        requestId,
        error: "AI analysis timed out"
      });

      const timeoutError = new Error("AI analysis timed out");
      timeoutError.status = 504;
      timeoutError.code = "ai_timeout";
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  analyzeChartImage,
  CONTEXT_FILE
};
