require("dotenv").config();

const path = require("path");
const express = require("express");
const multer = require("multer");
const { analyzeChartImage } = require("./ai");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      const error = new Error("Only PNG, JPG and WEBP chart screenshots are supported");
      error.status = 415;
      return cb(error);
    }
    cb(null, true);
  }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0
}));

app.get("/", (_req, res) => {
  res.redirect("/studio.html");
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quant",
    analysisReady: Boolean(process.env.TOKUN_API_KEY)
  });
});

app.post("/api/analyze", upload.single("chart"), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "chart_required",
        message: "Upload a chart screenshot first"
      });
    }

    const startedAt = Date.now();
    const result = await analyzeChartImage({
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      note: typeof req.body.note === "string" ? req.body.note : ""
    });

    res.json({
      ok: true,
      ...result,
      meta: {
        ...result.meta,
        elapsedMs: Date.now() - startedAt
      }
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({
      error: error.code,
      message: error.code === "LIMIT_FILE_SIZE"
        ? "Image is too large. Maximum size is 12 MB."
        : error.message
    });
  }

  const status = Number(error.status) || 500;
  console.error("[Quant]", {
    status,
    code: error.code,
    message: error.message
  });

  const safeClientErrors = new Map([
    ["chart_required", "Upload a chart screenshot first"],
    ["LIMIT_FILE_SIZE", "Image is too large. Maximum size is 12 MB."]
  ]);

  const publicCode = status >= 500 ? "analysis_error" : (error.code || "request_error");
  const publicMessage =
    safeClientErrors.get(error.code) ||
    (status >= 500
      ? "Quant could not complete this analysis. Please try again."
      : "The request could not be completed.");

  res.status(status).json({
    error: publicCode,
    message: publicMessage
  });
});

app.listen(PORT, () => {
  console.log(`Quant running on http://localhost:${PORT}`);
});
