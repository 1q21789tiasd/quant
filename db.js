const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

fs.mkdirSync(path.dirname(config.DB_PATH), { recursive: true });
fs.mkdirSync(config.CHART_DIR, { recursive: true });

const db = new DatabaseSync(config.DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS account_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  starting_balance REAL NOT NULL,
  balance REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL,
  chart_path TEXT,
  data_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  trigger TEXT NOT NULL,
  snapshot_id INTEGER,
  status TEXT NOT NULL,
  account_json TEXT,
  bloodline_json TEXT,
  decision_json TEXT,
  summary TEXT,
  confidence INTEGER,
  error TEXT,
  completed_at TEXT,
  FOREIGN KEY(snapshot_id) REFERENCES market_snapshots(id)
);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL,
  margin_nis REAL NOT NULL,
  leverage REAL NOT NULL,
  notional_nis REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  status TEXT NOT NULL,
  realized_pnl REAL NOT NULL DEFAULT 0,
  spread_cost REAL NOT NULL DEFAULT 0,
  cycle_open_id INTEGER,
  cycle_close_id INTEGER,
  last_checked_at TEXT
);

CREATE TABLE IF NOT EXISTS position_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  cycle_id INTEGER,
  ts TEXT NOT NULL,
  event_type TEXT NOT NULL,
  price REAL,
  details_json TEXT,
  FOREIGN KEY(position_id) REFERENCES positions(id)
);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  FOREIGN KEY(cycle_id) REFERENCES ai_cycles(id)
);

CREATE TABLE IF NOT EXISTS daily_reports (
  day TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT,
  data_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON market_snapshots(ts DESC);
CREATE INDEX IF NOT EXISTS idx_cycles_ts ON ai_cycles(ts DESC);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_position_events_ts ON position_events(ts DESC);
`);

const account = db.prepare("SELECT * FROM account_state WHERE id = 1").get();
if (!account) {
  db.prepare("INSERT INTO account_state (id, starting_balance, balance, updated_at) VALUES (1, ?, ?, ?)")
    .run(config.STARTING_BALANCE_NIS, config.STARTING_BALANCE_NIS, new Date().toISOString());
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function getAccount() {
  return db.prepare("SELECT * FROM account_state WHERE id = 1").get();
}

function setBalance(balance) {
  db.prepare("UPDATE account_state SET balance = ?, updated_at = ? WHERE id = 1")
    .run(Number(balance), new Date().toISOString());
}

function resetSimulation() {
  const now = new Date().toISOString();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM position_events").run();
    db.prepare("DELETE FROM actions").run();
    db.prepare("DELETE FROM positions").run();
    db.prepare("DELETE FROM ai_cycles").run();
    db.prepare("DELETE FROM market_snapshots").run();
    db.prepare("DELETE FROM daily_reports").run();
    db.prepare("DELETE FROM system_events").run();
    db.prepare("UPDATE account_state SET starting_balance = ?, balance = ?, updated_at = ? WHERE id = 1")
      .run(config.STARTING_BALANCE_NIS, config.STARTING_BALANCE_NIS, now);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function insertSnapshot(snapshot) {
  const info = db.prepare(
    "INSERT INTO market_snapshots (ts, symbol, price, chart_path, data_json) VALUES (?, ?, ?, ?, ?)"
  ).run(snapshot.ts, snapshot.symbol, snapshot.price, snapshot.chartPath || null, json(snapshot.data));
  return Number(info.lastInsertRowid);
}

function latestSnapshot() {
  const row = db.prepare("SELECT * FROM market_snapshots ORDER BY id DESC LIMIT 1").get();
  if (!row) return null;
  row.data = parse(row.data_json, {});
  delete row.data_json;
  return row;
}

function createCycle({ trigger, snapshotId }) {
  const now = new Date().toISOString();
  const info = db.prepare(
    "INSERT INTO ai_cycles (ts, trigger, snapshot_id, status) VALUES (?, ?, ?, 'RUNNING')"
  ).run(now, trigger, snapshotId || null);
  return Number(info.lastInsertRowid);
}

function updateCycleInputs(id, accountState, bloodline) {
  db.prepare("UPDATE ai_cycles SET account_json = ?, bloodline_json = ? WHERE id = ?")
    .run(json(accountState), json(bloodline), id);
}

function completeCycle(id, decision) {
  db.prepare(
    "UPDATE ai_cycles SET status = 'COMPLETE', decision_json = ?, summary = ?, confidence = ?, completed_at = ? WHERE id = ?"
  ).run(
    json(decision),
    String(decision.summary || ""),
    Number(decision.marketState?.confidence || 0),
    new Date().toISOString(),
    id
  );
}

function failCycle(id, error) {
  db.prepare(
    "UPDATE ai_cycles SET status = 'FAILED', error = ?, completed_at = ? WHERE id = ?"
  ).run(String(error || "Cycle failed").slice(0, 1000), new Date().toISOString(), id);
}

function latestCycle() {
  const row = db.prepare("SELECT * FROM ai_cycles ORDER BY id DESC LIMIT 1").get();
  return hydrateCycle(row);
}

function listCycles(limit = 50) {
  return db.prepare("SELECT * FROM ai_cycles ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(250, Number(limit) || 50)))
    .map(hydrateCycle);
}

function hydrateCycle(row) {
  if (!row) return null;
  return {
    ...row,
    account: parse(row.account_json, null),
    bloodline: parse(row.bloodline_json, null),
    decision: parse(row.decision_json, null)
  };
}

function getOpenPosition() {
  return db.prepare("SELECT * FROM positions WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1").get() || null;
}

function insertPosition(p) {
  const info = db.prepare(`
    INSERT INTO positions
      (opened_at, side, entry_price, margin_nis, leverage, notional_nis, stop_loss, take_profit, status, cycle_open_id, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
  `).run(
    p.openedAt, p.side, p.entryPrice, p.marginNis, p.leverage, p.notionalNis,
    p.stopLoss || null, p.takeProfit || null, p.cycleId || null, p.lastCheckedAt || p.openedAt
  );
  return Number(info.lastInsertRowid);
}

function updatePosition(id, patch) {
  const allowed = [
    "margin_nis","notional_nis","stop_loss","take_profit","last_checked_at",
    "realized_pnl","spread_cost","exit_price","closed_at","status","cycle_close_id"
  ];
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));
  if (!entries.length) return;
  const set = entries.map(([k]) => k + " = ?").join(", ");
  db.prepare("UPDATE positions SET " + set + " WHERE id = ?")
    .run(...entries.map(([,v]) => v), id);
}

function insertPositionEvent(positionId, cycleId, eventType, price, details) {
  db.prepare(
    "INSERT INTO position_events (position_id, cycle_id, ts, event_type, price, details_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(positionId, cycleId || null, new Date().toISOString(), eventType, price ?? null, json(details || {}));
}

function insertAction(cycleId, action, status, message) {
  db.prepare(
    "INSERT INTO actions (cycle_id, ts, type, payload_json, status, message) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    cycleId || null,
    new Date().toISOString(),
    String(action.type || "UNKNOWN"),
    json(action),
    status,
    message || null
  );
}

function listActions(limit = 100) {
  return db.prepare("SELECT * FROM actions ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(r => ({ ...r, payload: parse(r.payload_json, {}) }));
}

function listPositions(limit = 100) {
  return db.prepare("SELECT * FROM positions ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, Number(limit) || 100)));
}

function listPositionEvents(limit = 200) {
  return db.prepare("SELECT * FROM position_events ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(1000, Number(limit) || 200)))
    .map(r => ({ ...r, details: parse(r.details_json, {}) }));
}

function realizedForDay(day) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(realized_pnl), 0) AS pnl FROM positions WHERE status = 'CLOSED' AND substr(closed_at,1,10) = ?"
  ).get(day);
  return Number(row?.pnl || 0);
}

function closedPositionsForDay(day) {
  return db.prepare(
    "SELECT * FROM positions WHERE status = 'CLOSED' AND substr(closed_at,1,10) = ? ORDER BY closed_at ASC"
  ).all(day);
}

function saveDailyReport(day, report) {
  db.prepare(`
    INSERT INTO daily_reports(day, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(day, json(report), new Date().toISOString());
}

function listDailyReports(limit = 30) {
  return db.prepare("SELECT * FROM daily_reports ORDER BY day DESC LIMIT ?")
    .all(Math.max(1, Math.min(365, Number(limit) || 30)))
    .map(r => ({ day: r.day, ...parse(r.json, {}) }));
}

function recentDecisions(limit = 6) {
  return db.prepare(
    "SELECT id, ts, decision_json FROM ai_cycles WHERE status = 'COMPLETE' AND decision_json IS NOT NULL ORDER BY id DESC LIMIT ?"
  ).all(Math.max(1, Math.min(20, Number(limit) || 6)))
   .map(r => ({ id:r.id, ts:r.ts, decision:parse(r.decision_json,{}) }));
}

function systemEvent(type, message, data = {}) {
  db.prepare("INSERT INTO system_events (ts, type, message, data_json) VALUES (?, ?, ?, ?)")
    .run(new Date().toISOString(), type, message || null, json(data));
}

function listSystemEvents(limit = 100) {
  return db.prepare("SELECT * FROM system_events ORDER BY id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, Number(limit) || 100)))
    .map(r => ({ ...r, data: parse(r.data_json, {}) }));
}

function close() {
  try { db.close(); } catch {}
}

module.exports = {
  raw: db,
  close,
  getAccount,
  setBalance,
  resetSimulation,
  insertSnapshot,
  latestSnapshot,
  createCycle,
  updateCycleInputs,
  completeCycle,
  failCycle,
  latestCycle,
  listCycles,
  getOpenPosition,
  insertPosition,
  updatePosition,
  insertPositionEvent,
  insertAction,
  listActions,
  listPositions,
  listPositionEvents,
  realizedForDay,
  closedPositionsForDay,
  saveDailyReport,
  listDailyReports,
  recentDecisions,
  systemEvent,
  listSystemEvents
};
