/**
 * test/d1_mock.mjs
 * High-fidelity in-memory Cloudflare D1 mock using Node 24 native node:sqlite (DatabaseSync).
 * Enforces foreign keys (PRAGMA foreign_keys = ON) and transaction semantics from schema.sql.
 * Also provides Worker invocation helper and simulated client runtime.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SCHEMA_PATH = path.resolve(__dirname, "../schema.sql");
const DATA_PATH = path.resolve(__dirname, "../public/js/technical_sheet_data.js");

export class MockD1PreparedStatement {
  constructor(db, sql, params = []) {
    this._db = db;
    this._sql = sql;
    this._params = params;
  }

  bind(...params) {
    const normalized = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return new MockD1PreparedStatement(this._db, this._sql, normalized);
  }

  async run(...params) {
    const p = params.length > 0
      ? (params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
      : this._params;
    const stmt = this._db.prepare(this._sql);
    const info = stmt.run(...p);
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid),
        rows_written: info.changes,
      },
    };
  }

  async all(...params) {
    const p = params.length > 0
      ? (params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
      : this._params;
    const stmt = this._db.prepare(this._sql);
    const rows = stmt.all(...p);
    return {
      success: true,
      results: rows,
      meta: {
        changes: 0,
        rows_read: rows.length,
      },
    };
  }

  async first(colName, ...params) {
    const p = params.length > 0
      ? (params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
      : this._params;
    const stmt = this._db.prepare(this._sql);
    const row = stmt.get(...p);
    if (!row) return null;
    if (typeof colName === "string") {
      return row[colName] !== undefined ? row[colName] : null;
    }
    return row;
  }

  async raw(...params) {
    const p = params.length > 0
      ? (params.length === 1 && Array.isArray(params[0]) ? params[0] : params)
      : this._params;
    const stmt = this._db.prepare(this._sql);
    const rows = stmt.all(...p);
    return rows.map((r) => Object.values(r));
  }
}

export class MockD1Database {
  constructor(options = {}) {
    this.schemaPath = options.schemaPath || DEFAULT_SCHEMA_PATH;
    this.rawDb = new DatabaseSync(":memory:");
    this._txQueue = Promise.resolve();
    this.initSchema();
  }

  _acquireTxLock() {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const current = this._txQueue;
    this._txQueue = this._txQueue.then(() => next);
    return current.then(() => release);
  }

  initSchema() {
    this.rawDb.exec("PRAGMA foreign_keys = ON;");
    if (fs.existsSync(this.schemaPath)) {
      const sql = fs.readFileSync(this.schemaPath, "utf8");
      this.rawDb.exec(sql);
    }
  }

  reset() {
    this.rawDb.close();
    this.rawDb = new DatabaseSync(":memory:");
    this._txQueue = Promise.resolve();
    this.initSchema();
  }

  prepare(sql) {
    return new MockD1PreparedStatement(this.rawDb, sql);
  }

  async batch(statements) {
    const release = await this._acquireTxLock();
    try {
      this.rawDb.exec("BEGIN IMMEDIATE;");
      const results = [];
      for (const stmt of statements) {
        if (!stmt) continue;
        const sql = stmt._sql ? stmt._sql.trim().toUpperCase() : "";
        if (sql.startsWith("SELECT") || sql.startsWith("PRAGMA")) {
          results.push(await stmt.all());
        } else {
          results.push(await stmt.run());
        }
      }
      this.rawDb.exec("COMMIT;");
      return results;
    } catch (err) {
      try {
        this.rawDb.exec("ROLLBACK;");
      } catch (_) {
        // Rollback ignore if already closed
      }
      throw err;
    } finally {
      release();
    }
  }

  async exec(sql) {
    this.rawDb.exec(sql);
    return { count: 1, duration: 0 };
  }

  close() {
    this.rawDb.close();
  }
}

export function createMockD1(options = {}) {
  return new MockD1Database(options);
}

export function createWorkerEnv(mockD1) {
  const d1 = mockD1 || createMockD1();
  return {
    DB: d1,
    ASSETS: {
      fetch: async () => new Response("Static asset mock", { status: 200 }),
    },
  };
}

/**
 * Execute worker fetch with structured helper
 */
export async function callWorker(env, method, pathname, body = null, headers = {}) {
  const url = `http://localhost${pathname}`;
  const reqHeaders = {
    ...headers,
  };
  const init = {
    method,
    headers: reqHeaders,
  };
  if (body !== null) {
    reqHeaders["Content-Type"] = reqHeaders["Content-Type"] || "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const request = new Request(url, init);
  const response = await worker.fetch(request, env);
  let json = null;
  let text = null;
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    try {
      json = await response.json();
    } catch (_) {
      // not valid json
    }
  } else {
    text = await response.text();
  }
  return {
    status: response.status,
    headers: response.headers,
    json,
    text,
  };
}

/**
 * Load TECHNICAL_SHEET_MASTER data
 */
let cachedMaster = null;
export function getTechnicalSheetMaster() {
  if (cachedMaster) return cachedMaster;
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`Data file not found at ${DATA_PATH}`);
  }
  const code = fs.readFileSync(DATA_PATH, "utf8");
  const sandbox = { window: {} };
  new Function("window", code)(sandbox.window);
  cachedMaster = sandbox.window.TECHNICAL_SHEET_MASTER;
  return cachedMaster;
}

/**
 * Mock LocalStorage
 */
export class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
  get length() {
    return this.store.size;
  }
  key(index) {
    return Array.from(this.store.keys())[index] || null;
  }
}

/**
 * High-fidelity client simulator for testing offline queue, backoff, LWW, and sync states
 */
export class SimulatedClient {
  constructor(env, options = {}) {
    this.env = env;
    this.name = options.name || "Client_Mobile_1";
    this.online = options.online !== undefined ? options.online : true;
    this.simulateServerError = false;
    this.clockOffsetMs = options.clockOffsetMs || 0; // Positive = client is ahead, negative = behind
    this.localStorage = new MockLocalStorage();
    this.STORAGE_KEY_DATA = "TECHNICAL_SHEET_DATA_V2";
    this.STORAGE_KEY_QUEUE = "TECHNICAL_SHEET_QUEUE_V2";

    this.data = {
      staff: [],
      advisors: {
        "2F": "2F担当アドバイザー",
        "3F": "3F担当アドバイザー",
        "4F": "4F担当アドバイザー",
        "5F": "5F担当アドバイザー",
      },
      evaluations: {},
      lastSyncedAt: null,
    };

    this.syncQueue = [];
    this.isSyncing = false;
    this.syncStatus = "synced"; // 'synced' | 'syncing' | 'local_safe' | 'error'
    this.statusListeners = [];
    this.backoffDelayMs = 2000;
    this.backoffFailures = 0;
    this.serverClockOffsetMs = 0; // Calculated drift

    // Load initial data
    this.loadFromStorage();
  }

  now() {
    return new Date(Date.now() + this.clockOffsetMs + this.serverClockOffsetMs).toISOString();
  }

  onSyncStatusChange(cb) {
    this.statusListeners.push(cb);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== cb);
    };
  }

  setSyncStatus(status, details = {}) {
    if (this.syncStatus !== status) {
      this.syncStatus = status;
      for (const listener of this.statusListeners) {
        try {
          listener(status, details);
        } catch (_) {}
      }
    }
  }

  loadFromStorage() {
    try {
      const rawData = this.localStorage.getItem(this.STORAGE_KEY_DATA);
      if (rawData) {
        const parsed = JSON.parse(rawData);
        if (parsed.staff) this.data.staff = parsed.staff;
        if (parsed.advisors) this.data.advisors = parsed.advisors;
        if (parsed.evaluations) this.data.evaluations = parsed.evaluations;
        if (parsed.lastSyncedAt) this.data.lastSyncedAt = parsed.lastSyncedAt;
      }
      const rawQueue = this.localStorage.getItem(this.STORAGE_KEY_QUEUE);
      if (rawQueue) {
        this.syncQueue = JSON.parse(rawQueue);
      }
    } catch (e) {
      // Corrupt storage reset
      this.syncQueue = [];
    }
  }

  saveToStorage() {
    this.localStorage.setItem(this.STORAGE_KEY_DATA, JSON.stringify(this.data));
    this.localStorage.setItem(this.STORAGE_KEY_QUEUE, JSON.stringify(this.syncQueue));
  }

  async fetch(pathname, init = {}) {
    if (!this.online) {
      throw new TypeError("Failed to fetch: Network is offline");
    }
    if (this.simulateServerError) {
      return {
        status: 500,
        ok: false,
        json: async () => ({ success: false, error: "Simulated Internal Server Error" }),
      };
    }
    const res = await callWorker(
      this.env,
      init.method || "GET",
      pathname,
      init.body ? JSON.parse(init.body) : null,
      init.headers
    );
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: async () => res.json,
      headers: res.headers,
    };
  }

  async fetchBootstrap() {
    try {
      this.setSyncStatus("syncing");
      const res = await this.fetch("/api/bootstrap");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!body.success) throw new Error(body.error || "Bootstrap failed");

      // Clock drift calculation
      if (body.serverTime) {
        const serverTimeMs = new Date(body.serverTime).getTime();
        this.serverClockOffsetMs = serverTimeMs - (Date.now() + this.clockOffsetMs);
      }

      // Update staff
      if (Array.isArray(body.staff)) {
        this.data.staff = body.staff;
        // Purge zombie evaluations for deleted staff
        const validStaffIds = new Set(body.staff.map((s) => s.id));
        for (const key of Object.keys(this.data.evaluations)) {
          const evalItem = this.data.evaluations[key];
          if (evalItem && !validStaffIds.has(evalItem.staff_id)) {
            delete this.data.evaluations[key];
          }
        }
      }

      // Update advisors
      if (Array.isArray(body.advisors)) {
        for (const adv of body.advisors) {
          this.data.advisors[adv.floor] = adv.advisor_name;
        }
      }

      // Update evaluations with LWW
      if (Array.isArray(body.evaluations)) {
        for (const remote of body.evaluations) {
          const key = `${remote.staff_id}_${remote.item_id}`;
          const local = this.data.evaluations[key];
          if (!local || !local.updated_at || remote.updated_at >= local.updated_at) {
            this.data.evaluations[key] = {
              staff_id: remote.staff_id,
              item_id: remote.item_id,
              check_eval: remote.check_eval || "",
              score: remote.score || "",
              checks_json: typeof remote.checks_json === "string" ? JSON.parse(remote.checks_json || "[]") : remote.checks_json || [],
              memo: remote.memo || "",
              evaluator_name: remote.evaluator_name || "",
              evaluation_date: remote.evaluation_date || "",
              updated_at: remote.updated_at,
            };
          }
        }
      }

      this.data.lastSyncedAt = body.serverTime || this.now();
      this.saveToStorage();
      this.setSyncStatus("synced");
      this.backoffFailures = 0;
      this.backoffDelayMs = 2000;
      return true;
    } catch (err) {
      this.setSyncStatus(this.online ? "error" : "local_safe", { error: err.message });
      return false;
    }
  }

  async saveEvaluation(staffId, itemId, updates) {
    const key = `${staffId}_${itemId}`;
    const current = this.data.evaluations[key] || {
      staff_id: staffId,
      item_id: itemId,
      check_eval: "",
      score: "",
      checks_json: [],
      memo: "",
      evaluator_name: "",
      evaluation_date: "",
      updated_at: null,
    };
    const nowIso = this.now();
    const updated = {
      ...current,
      ...updates,
      staff_id: staffId,
      item_id: itemId,
      updated_at: updates.updated_at || nowIso,
    };
    this.data.evaluations[key] = updated;

    // Queue mutation (deduplicate within queue)
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "evaluation" && m.data.staff_id === staffId && m.data.item_id === itemId)
    );
    this.syncQueue.push({
      type: "evaluation",
      data: updated,
    });
    this.saveToStorage();

    if (!this.online) {
      this.setSyncStatus("local_safe");
      return false;
    } else {
      return this.flushSyncQueue();
    }
  }

  async saveStaff(staffMember) {
    const clean = { ...staffMember, role: "general", updated_at: this.now() };
    const idx = this.data.staff.findIndex((s) => s.id === clean.id);
    if (idx >= 0) {
      this.data.staff[idx] = clean;
    } else {
      this.data.staff.push(clean);
    }
    // Queue staff mutation
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "staff_save" && m.data.id === clean.id)
    );
    this.syncQueue.push({
      type: "staff_save",
      data: clean,
    });
    this.saveToStorage();

    if (!this.online) {
      this.setSyncStatus("local_safe");
      return false;
    } else {
      return this.flushSyncQueue();
    }
  }

  async deleteStaff(staffId) {
    this.data.staff = this.data.staff.filter((s) => s.id !== staffId);
    // Remove local evaluations
    for (const key of Object.keys(this.data.evaluations)) {
      if (key.startsWith(`${staffId}_`)) {
        delete this.data.evaluations[key];
      }
    }
    // Remove pending evaluation syncs for this staff
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "evaluation" && m.data.staff_id === staffId)
    );
    // Queue staff delete mutation
    this.syncQueue.push({
      type: "staff_delete",
      staffId,
    });
    this.saveToStorage();

    if (!this.online) {
      this.setSyncStatus("local_safe");
      return false;
    } else {
      return this.flushSyncQueue();
    }
  }

  async setAdvisorName(floor, name) {
    const updated = { floor, advisor_name: name, updated_at: this.now() };
    this.data.advisors[floor] = name;
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "advisor_save" && m.data.floor === floor)
    );
    this.syncQueue.push({
      type: "advisor_save",
      data: updated,
    });
    this.saveToStorage();

    if (!this.online) {
      this.setSyncStatus("local_safe");
      return false;
    } else {
      return this.flushSyncQueue();
    }
  }

  async flushSyncQueue() {
    if (!this.online) {
      this.setSyncStatus("local_safe");
      return false;
    }
    if (this._syncPromise) {
      await this._syncPromise;
      if (this.syncQueue.length === 0 || !this.online) {
        return this.online;
      }
    }
    this._syncPromise = (async () => {
      try {
        while (this.syncQueue.length > 0 && this.online) {
          const ok = await this._executeFlush();
          if (!ok) return false;
        }
        return true;
      } finally {
        this._syncPromise = null;
      }
    })();
    return this._syncPromise;
  }

  async _executeFlush() {
    if (this.syncQueue.length === 0) {
      this.setSyncStatus("synced");
      return true;
    }
    if (!this.online) {
      this.setSyncStatus("local_safe");
      return false;
    }

    this.setSyncStatus("syncing");
    const currentBatch = [...this.syncQueue];
    this.syncQueue = [];

    const evaluationItems = [];
    const nonEvalMutations = [];

    for (const m of currentBatch) {
      if (m.type === "evaluation") {
        evaluationItems.push(m.data);
      } else {
        nonEvalMutations.push(m);
      }
    }

    try {
      // Execute non-eval mutations first (staff add/delete, advisors)
      for (const mut of nonEvalMutations) {
        if (mut.type === "staff_save") {
          const res = await this.fetch("/api/staff", {
            method: "POST",
            body: JSON.stringify(mut.data),
          });
          if (!res.ok) throw new Error(`Staff save failed: HTTP ${res.status}`);
        } else if (mut.type === "staff_delete") {
          const res = await this.fetch(`/api/staff/${encodeURIComponent(mut.staffId)}`, {
            method: "DELETE",
          });
          if (!res.ok) throw new Error(`Staff delete failed: HTTP ${res.status}`);
        } else if (mut.type === "advisor_save") {
          const res = await this.fetch("/api/advisors", {
            method: "POST",
            body: JSON.stringify(mut.data),
          });
          if (!res.ok) throw new Error(`Advisor save failed: HTTP ${res.status}`);
        }
      }

      // Execute evaluation batch
      if (evaluationItems.length > 0) {
        const res = await this.fetch("/api/evaluations/sync", {
          method: "POST",
          body: JSON.stringify({ items: evaluationItems }),
        });
        if (!res.ok) throw new Error(`Eval sync failed: HTTP ${res.status}`);
      }

      this.saveToStorage();
      this.setSyncStatus("synced");
      this.backoffFailures = 0;
      this.backoffDelayMs = 2000;
      return true;
    } catch (err) {
      this.syncQueue = [...currentBatch, ...this.syncQueue];
      this.backoffFailures++;
      this.backoffDelayMs = Math.min(30000, 2000 * Math.pow(2, this.backoffFailures - 1));
      this.setSyncStatus(this.online ? "error" : "local_safe", { error: err.message });
      return false;
    }
  }

  async setOnline(isOnline) {
    const wasOffline = !this.online;
    this.online = isOnline;
    if (isOnline && wasOffline) {
      // Auto-flush on reconnection event
      await this.flushSyncQueue();
      await this.fetchBootstrap();
    } else if (!isOnline) {
      this.setSyncStatus("local_safe");
    }
  }

  async retrySyncManual() {
    this.backoffFailures = 0;
    this.backoffDelayMs = 2000;
    const flushOk = await this.flushSyncQueue();
    const bootOk = await this.fetchBootstrap();
    return flushOk && bootOk;
  }

  calcStaffProgress(staffId) {
    const master = getTechnicalSheetMaster();
    let total = 0;
    let completed = 0;
    for (const cat of master) {
      for (const sub of cat.subcategories) {
        for (const mid of sub.mid_items) {
          total++;
          const ev = this.data.evaluations[`${staffId}_${mid.id}`];
          if (ev && (ev.check_eval || ev.score)) {
            completed++;
          }
        }
      }
    }
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percent };
  }

  calcFloorProgress(floor) {
    const staffList = this.data.staff.filter((s) => s.floor === floor);
    if (staffList.length === 0) return { completed: 0, total: 0, percent: 0 };
    let completedCount = 0;
    for (const s of staffList) {
      const p = this.calcStaffProgress(s.id);
      if (p.percent === 100) completedCount++;
    }
    const percent = Math.round((completedCount / staffList.length) * 100);
    return { completed: completedCount, total: staffList.length, percent };
  }
}

export function createSimulatedClient(env, options = {}) {
  return new SimulatedClient(env, options);
}
