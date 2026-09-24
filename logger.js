function safe(value) {
  if (value === undefined) return "";
  try {
    return " " + JSON.stringify(value);
  } catch {
    return " " + String(value);
  }
}

function log(scope, message, data) {
  console.log("[QUANT][" + new Date().toISOString() + "][" + scope + "] " + message + safe(data));
}

function warn(scope, message, data) {
  console.warn("[QUANT][" + new Date().toISOString() + "][" + scope + "] " + message + safe(data));
}

function error(scope, message, err) {
  const detail = err && typeof err === "object"
    ? {
        name: err.name,
        code: err.code,
        message: err.message
      }
    : err;
  console.error("[QUANT][" + new Date().toISOString() + "][" + scope + "] " + message + safe(detail));
}

module.exports = { log, warn, error };
