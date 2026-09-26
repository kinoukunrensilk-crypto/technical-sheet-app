/**
 * test/tier1_feature.test.mjs
 * Tier 1: Equivalence Class Coverage for Features F1-F12 (≥5 tests per feature, 60+ tests).
 * Zero npm dependencies: uses node:test and node:assert/strict.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createMockD1,
  createWorkerEnv,
  createSimulatedClient,
  callWorker,
  getTechnicalSheetMaster,
} from "./d1_mock.mjs";

describe("Tier 1: Feature Equivalence Class Suite (F1-F12)", () => {
  let d1;
  let env;

  beforeEach(() => {
    d1 = createMockD1();
    env = createWorkerEnv(d1);
  });

  // =========================================================================
  // F1: D1 Safe Conditional Upsert (Foreign Key Guard)
  // =========================================================================
  describe("F1: D1 Safe Conditional Upsert", () => {
    it("F1-01: Valid staff evaluation insert succeeds and increments updated count", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "item_001",
            check_eval: "circle",
            score: "A",
            memo: "入浴介助良好",
            updated_at: new Date().toISOString(),
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 1);
      assert.equal(res.json.updated, 1);

      const dbRow = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "item_001")
        .first();
      assert.ok(dbRow);
      assert.equal(dbRow.score, "A");
      assert.equal(dbRow.check_eval, "circle");
    });

    it("F1-02: Nonexistent staff evaluation is safely ignored without foreign key failure", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_ghost_999",
            item_id: "item_001",
            check_eval: "cross",
            score: "C",
            updated_at: new Date().toISOString(),
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 1);
      assert.equal(res.json.updated, 0); // Ignored due to WHERE EXISTS

      const count = await d1
        .prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = ?")
        .bind("staff_ghost_999")
        .first("c");
      assert.equal(count, 0);
    });

    it("F1-03: Mixed batch with valid and nonexistent staff persists only valid staff", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
          { staff_id: "staff_nonexistent_1", item_id: "item_001", score: "B", updated_at: new Date().toISOString() },
          { staff_id: "staff_2f_02", item_id: "item_002", score: "B", updated_at: new Date().toISOString() },
          { staff_id: "staff_nonexistent_2", item_id: "item_002", score: "C", updated_at: new Date().toISOString() },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 4);
      assert.equal(res.json.updated, 2);

      const r1 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01'").first("score");
      const r2 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_02'").first("score");
      assert.equal(r1, "A");
      assert.equal(r2, "B");
    });

    it("F1-04: Deleted staff evaluations are cascaded and subsequent sync is ignored", async () => {
      // 1. Insert evaluation
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: "2026-09-26T00:00:00Z" }],
      });
      // 2. Delete staff
      const delRes = await callWorker(env, "DELETE", "/api/staff/staff_2f_01");
      assert.equal(delRes.status, 200);
      assert.equal(delRes.json.success, true);

      // Verify cascading delete
      const evalCount = await d1
        .prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_01'")
        .first("c");
      assert.equal(evalCount, 0);

      // 3. Subsequent sync for deleted staff is ignored without error
      const syncRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "B", updated_at: "2026-09-26T01:00:00Z" }],
      });
      assert.equal(syncRes.status, 200);
      assert.equal(syncRes.json.updated, 0);
    });

    it("F1-05: Multiple mid-items for existing staff all persist successfully", async () => {
      const items = ["item_001", "item_002", "item_003", "item_004", "item_005"].map((id) => ({
        staff_id: "staff_3f_01",
        item_id: id,
        score: "A",
        check_eval: "circle",
        updated_at: new Date().toISOString(),
      }));
      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      assert.equal(res.status, 200);
      assert.equal(res.json.updated, 5);

      const count = await d1
        .prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_3f_01'")
        .first("c");
      assert.equal(count, 5);
    });
  });

  // =========================================================================
  // F2: D1 Last-Write-Wins (LWW) Conflict Resolution
  // =========================================================================
  describe("F2: D1 Last-Write-Wins Conflict Resolution", () => {
    it("F2-01: Newer timestamp overwrites existing evaluation", async () => {
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "B", updated_at: "2026-09-26T10:00:00Z" }],
      });
      const updateRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: "2026-09-26T10:05:00Z" }],
      });
      assert.equal(updateRes.json.updated, 1);
      const row = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'")
        .first("score");
      assert.equal(row, "A");
    });

    it("F2-02: Stale timestamp (older) is ignored and does not overwrite newer data", async () => {
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: "2026-09-26T10:05:00Z" }],
      });
      const staleRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "C", updated_at: "2026-09-26T10:00:00Z" }],
      });
      assert.equal(staleRes.json.updated, 0); // Not updated because excluded.updated_at < evaluations.updated_at
      const row = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'")
        .first("score");
      assert.equal(row, "A"); // Still "A"
    });

    it("F2-03: Equal timestamp is accepted without corruption (idempotency)", async () => {
      const ts = "2026-09-26T10:00:00Z";
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: ts }],
      });
      const idempRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: ts }],
      });
      assert.equal(idempRes.json.success, true);
      const row = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'")
        .first("score");
      assert.equal(row, "A");
    });

    it("F2-04: Advisor LWW resolves newer update and rejects older update", async () => {
      await callWorker(env, "POST", "/api/advisors", {
        floor: "2F",
        advisor_name: "新アドバイザー 2F (正)",
        updated_at: "2026-09-26T12:00:00Z",
      });
      // Try older update
      await callWorker(env, "POST", "/api/advisors", {
        floor: "2F",
        advisor_name: "旧アドバイザー 2F (誤)",
        updated_at: "2026-09-26T11:00:00Z",
      });
      const advName = await d1
        .prepare("SELECT advisor_name FROM advisors WHERE floor = '2F'")
        .first("advisor_name");
      assert.equal(advName, "新アドバイザー 2F (正)");
    });

    it("F2-05: Staff update with newer timestamp succeeds", async () => {
      await callWorker(env, "POST", "/api/staff", {
        id: "staff_2f_01",
        floor: "2F",
        name: "介護スタッフ A (昇格更新)",
        role: "general",
        order_num: 1,
        updated_at: "2026-09-26T12:00:00Z",
      });
      const name = await d1
        .prepare("SELECT name FROM staff WHERE id = 'staff_2f_01'")
        .first("name");
      assert.equal(name, "介護スタッフ A (昇格更新)");
    });
  });

  // =========================================================================
  // F3: Backend Sync Metadata & Clock Reference
  // =========================================================================
  describe("F3: Backend Sync Metadata & Clock Reference", () => {
    it("F3-01: Sync response returns accurate count and updated rows count", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_3f_01", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
          { staff_id: "staff_3f_01", item_id: "item_002", score: "B", updated_at: new Date().toISOString() },
        ],
      });
      assert.equal(typeof res.json.count, "number");
      assert.equal(res.json.count, 2);
      assert.equal(typeof res.json.updated, "number");
      assert.equal(res.json.updated, 2);
    });

    it("F3-02: Sync response returns valid ISO 8601 serverTime", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items: [] });
      assert.ok(res.json.serverTime);
      const parsedTime = Date.parse(res.json.serverTime);
      assert.ok(!isNaN(parsedTime));
    });

    it("F3-03: Bootstrap response returns all required metadata and arrays", async () => {
      const res = await callWorker(env, "GET", "/api/bootstrap");
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.ok(Array.isArray(res.json.staff));
      assert.ok(Array.isArray(res.json.advisors));
      assert.ok(Array.isArray(res.json.evaluations));
      assert.ok(res.json.serverTime);
      assert.equal(res.json.staff.length, 8); // 8 initial staff
      assert.equal(res.json.advisors.length, 4); // 4 floors
    });

    it("F3-04: Advisor POST response includes updated record and serverTime", async () => {
      const res = await callWorker(env, "POST", "/api/advisors", {
        floor: "3F",
        advisor_name: "山田アドバイザー",
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.ok(res.json.advisor);
      assert.equal(res.json.advisor.advisor_name, "山田アドバイザー");
      assert.ok(res.json.serverTime);
    });

    it("F3-05: CORS headers returned on OPTIONS preflight and GET endpoints", async () => {
      const optionsRes = await callWorker(env, "OPTIONS", "/api/evaluations/sync");
      assert.equal(optionsRes.headers.get("Access-Control-Allow-Origin"), "*");
      assert.ok(optionsRes.headers.get("Access-Control-Allow-Methods").includes("POST"));

      const getRes = await callWorker(env, "GET", "/api/health");
      assert.equal(getRes.headers.get("Access-Control-Allow-Origin"), "*");
      assert.ok(getRes.headers.get("Content-Type").includes("application/json"));
    });
  });

  // =========================================================================
  // F4: LocalStorage Persistent Queue
  // =========================================================================
  describe("F4: LocalStorage Persistent Queue", () => {
    it("F4-01: Offline mutations are written to localStorage under TECHNICAL_SHEET_QUEUE_V2", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A", check_eval: "circle" });

      const rawQueue = client.localStorage.getItem("TECHNICAL_SHEET_QUEUE_V2");
      assert.ok(rawQueue);
      const queue = JSON.parse(rawQueue);
      assert.equal(queue.length, 1);
      assert.equal(queue[0].type, "evaluation");
      assert.equal(queue[0].data.score, "A");
    });

    it("F4-02: Rapid edits to the same item collapse into a single latest mutation", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "B" });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A", memo: "最終メモ" });

      const queue = JSON.parse(client.localStorage.getItem("TECHNICAL_SHEET_QUEUE_V2"));
      assert.equal(queue.length, 1);
      assert.equal(queue[0].data.score, "A");
      assert.equal(queue[0].data.memo, "最終メモ");
    });

    it("F4-03: Queue survives client restart / reload from persistent storage", async () => {
      const client1 = createSimulatedClient(env, { online: false });
      client1.saveEvaluation("staff_2f_01", "item_001", { score: "B" });

      // Create new client sharing same localStorage
      const client2 = createSimulatedClient(env, { online: false });
      client2.localStorage.store = client1.localStorage.store;
      client2.loadFromStorage();

      assert.equal(client2.syncQueue.length, 1);
      assert.equal(client2.syncQueue[0].data.score, "B");
    });

    it("F4-04: Successful flush clears queue from localStorage", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      assert.equal(client.syncQueue.length, 1);

      // Go online and flush
      await client.setOnline(true);
      assert.equal(client.syncQueue.length, 0);
      const rawQueue = client.localStorage.getItem("TECHNICAL_SHEET_QUEUE_V2");
      assert.equal(JSON.parse(rawQueue).length, 0);
    });

    it("F4-05: Corrupt storage recovery initializes gracefully to empty queue", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.localStorage.setItem("TECHNICAL_SHEET_QUEUE_V2", "{invalid-json-content###");
      client.loadFromStorage();
      assert.deepEqual(client.syncQueue, []);
    });
  });

  // =========================================================================
  // F5: Exponential Backoff & Offline Pause
  // =========================================================================
  describe("F5: Exponential Backoff & Offline Pause", () => {
    it("F5-01: Consecutive failures increase backoff delay exponentially", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001", score: "A" } });

      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 1);
      assert.equal(client.backoffDelayMs, 2000);

      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 2);
      assert.equal(client.backoffDelayMs, 4000);

      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 3);
      assert.equal(client.backoffDelayMs, 8000);
    });

    it("F5-02: Offline state halts sync attempts completely without network requests", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      const ok = await client.flushSyncQueue();
      assert.equal(ok, false);
      assert.equal(client.syncStatus, "local_safe");
    });

    it("F5-03: Backoff delay is capped at 30,000ms", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      for (let i = 0; i < 8; i++) {
        await client.flushSyncQueue();
      }
      assert.ok(client.backoffDelayMs <= 30000);
      assert.equal(client.backoffDelayMs, 30000);
    });

    it("F5-04: Successful sync resets backoff failures and delay to baseline", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001", score: "A" } });
      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 1);

      // Server recovers
      client.simulateServerError = false;
      const ok = await client.flushSyncQueue();
      assert.equal(ok, true);
      assert.equal(client.backoffFailures, 0);
      assert.equal(client.backoffDelayMs, 2000);
    });

    it("F5-05: Manual retry resets backoff counters immediately", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 1);

      client.simulateServerError = false;
      await client.retrySyncManual();
      assert.equal(client.backoffFailures, 0);
      assert.equal(client.backoffDelayMs, 2000);
    });
  });

  // =========================================================================
  // F6: Instant Network Event Listener Auto-Flush
  // =========================================================================
  describe("F6: Instant Network Event Listener Auto-Flush", () => {
    it("F6-01: setOnline(true) triggers immediate queue flush without waiting", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      assert.equal(client.syncQueue.length, 1);

      await client.setOnline(true);
      assert.equal(client.syncQueue.length, 0);
      const row = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01'").first("score");
      assert.equal(row, "A");
    });

    it("F6-02: Reconnection triggers state bootstrap to sync remote changes", async () => {
      // Modify advisor in D1
      await d1.prepare("UPDATE advisors SET advisor_name = '新任フロア長' WHERE floor = '4F'").run();

      const client = createSimulatedClient(env, { online: false });
      assert.notEqual(client.data.advisors["4F"], "新任フロア長");

      await client.setOnline(true);
      assert.equal(client.data.advisors["4F"], "新任フロア長");
    });

    it("F6-03: Status transitions from local_safe to synced upon reconnection", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      assert.equal(client.syncStatus, "local_safe");

      await client.setOnline(true);
      assert.equal(client.syncStatus, "synced");
    });

    it("F6-04: Reconnection with empty queue executes bootstrap cleanly", async () => {
      const client = createSimulatedClient(env, { online: false });
      assert.equal(client.syncQueue.length, 0);

      await client.setOnline(true);
      assert.equal(client.syncStatus, "synced");
      assert.equal(client.data.staff.length, 8);
    });

    it("F6-05: Redundant online events do not cause concurrent double-flush errors", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

      // Trigger two online reconnects simultaneously
      await Promise.all([client.setOnline(true), client.setOnline(true)]);
      assert.equal(client.syncQueue.length, 0);
      assert.equal(client.syncStatus, "synced");
    });
  });

  // =========================================================================
  // F7: Full Mutation Queuing (Staff Add/Delete, Advisor)
  // =========================================================================
  describe("F7: Full Mutation Queuing", () => {
    it("F7-01: Offline staff creation is queued and synced upon reconnection", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveStaff({
        id: "staff_new_01",
        floor: "3F",
        name: "新人介護士 (3F)",
        role: "general",
        order_num: 5,
      });
      assert.equal(client.syncQueue.length, 1);
      assert.equal(client.syncQueue[0].type, "staff_save");

      await client.setOnline(true);
      assert.equal(client.syncQueue.length, 0);

      const staffRow = await d1.prepare("SELECT name FROM staff WHERE id = 'staff_new_01'").first("name");
      assert.equal(staffRow, "新人介護士 (3F)");
    });

    it("F7-02: Offline staff deletion is queued and cascades upon reconnection", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.deleteStaff("staff_2f_02");
      assert.equal(client.syncQueue.length, 1);
      assert.equal(client.syncQueue[0].type, "staff_delete");

      await client.setOnline(true);
      const staffRow = await d1.prepare("SELECT * FROM staff WHERE id = 'staff_2f_02'").first();
      assert.equal(staffRow, null);
    });

    it("F7-03: Offline advisor update is queued and synced upon reconnection", async () => {
      const client = createSimulatedClient(env, { online: false });
      await client.setAdvisorName("5F", "5F特命アドバイザー");
      assert.equal(client.syncQueue.length, 1);
      assert.equal(client.syncQueue[0].type, "advisor_save");

      await client.setOnline(true);
      const adv = await d1.prepare("SELECT advisor_name FROM advisors WHERE floor = '5F'").first("advisor_name");
      assert.equal(adv, "5F特命アドバイザー");
    });

    it("F7-04: FIFO ordering of mixed mutations is preserved during flush", async () => {
      const client = createSimulatedClient(env, { online: false });
      // 1. Add staff
      client.saveStaff({ id: "staff_seq_01", floor: "2F", name: "Sequential Staff" });
      // 2. Add evaluation for new staff
      client.saveEvaluation("staff_seq_01", "item_001", { score: "A" });

      assert.equal(client.syncQueue.length, 2);
      assert.equal(client.syncQueue[0].type, "staff_save");
      assert.equal(client.syncQueue[1].type, "evaluation");

      await client.setOnline(true);
      assert.equal(client.syncQueue.length, 0);

      const evalRow = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_seq_01'")
        .first("score");
      assert.equal(evalRow, "A");
    });

    it("F7-05: Recreating staff after deletion processes cleanly", async () => {
      const client = createSimulatedClient(env, { online: true });
      await client.fetchBootstrap();

      client.deleteStaff("staff_3f_02");
      await client.flushSyncQueue();

      client.saveStaff({ id: "staff_3f_02", floor: "3F", name: "再登録スタッフ" });
      await client.flushSyncQueue();

      const name = await d1.prepare("SELECT name FROM staff WHERE id = 'staff_3f_02'").first("name");
      assert.equal(name, "再登録スタッフ");
    });
  });

  // =========================================================================
  // F8: Zombie Evaluation Purge & Clock Skew Compensation
  // =========================================================================
  describe("F8: Zombie Evaluation Purge & Clock Skew Drift Handling", () => {
    it("F8-01: Bootstrap purges local evaluations for deleted staff", async () => {
      const client = createSimulatedClient(env, { online: true });
      await client.fetchBootstrap();

      // Put evaluation into client local state for staff_2f_01
      client.data.evaluations["staff_2f_01_item_001"] = {
        staff_id: "staff_2f_01",
        item_id: "item_001",
        score: "A",
        updated_at: new Date().toISOString(),
      };

      // Server deletes staff_2f_01
      await d1.prepare("DELETE FROM staff WHERE id = 'staff_2f_01'").run();

      // Client performs bootstrap
      await client.fetchBootstrap();

      // Zombie evaluation should be purged
      assert.equal(client.data.evaluations["staff_2f_01_item_001"], undefined);
    });

    it("F8-02: Client with +1 hour positive clock skew calculates drift offset", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: 3600000 }); // +1 hour ahead
      await client.fetchBootstrap();
      // Server clock offset should be around -3600000 ms to compensate
      assert.ok(client.serverClockOffsetMs < -3500000 && client.serverClockOffsetMs > -3700000);
    });

    it("F8-03: Client with -1 hour negative clock skew calculates drift offset", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: -3600000 }); // -1 hour behind
      await client.fetchBootstrap();
      assert.ok(client.serverClockOffsetMs > 3500000 && client.serverClockOffsetMs < 3700000);
    });

    it("F8-04: Compensated timestamps prevent future domination", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: 3600000 });
      await client.fetchBootstrap();

      const adjustedTime = new Date(client.now()).getTime();
      const currentRealTime = Date.now();
      // Drift should be normalized within 10 seconds of real time
      assert.ok(Math.abs(adjustedTime - currentRealTime) < 10000);
    });

    it("F8-05: Minor clock drift (< 5 seconds) operates smoothly without error", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: 2500 }); // +2.5s drift
      await client.fetchBootstrap();
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      await client.flushSyncQueue();
      const row = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01'").first("score");
      assert.equal(row, "A");
    });
  });

  // =========================================================================
  // F9: Four-State Visual Sync Indicators (🟢 🟡 💾 ⚠️)
  // =========================================================================
  describe("F9: Four-State Visual Sync Indicators", () => {
    it("F9-01: Bootstrap sync transitions to 'synced'", async () => {
      const client = createSimulatedClient(env, { online: true });
      await client.fetchBootstrap();
      assert.equal(client.syncStatus, "synced");
    });

    it("F9-02: Offline mutation transitions to 'local_safe'", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      assert.equal(client.syncStatus, "local_safe");
    });

    it("F9-03: Server error transitions to 'error'", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      await client.flushSyncQueue();
      assert.equal(client.syncStatus, "error");
    });

    it("F9-04: Transitions pass through 'syncing' during flush", async () => {
      const client = createSimulatedClient(env, { online: true });
      const states = [];
      client.onSyncStatusChange((status) => states.push(status));

      client.syncQueue.push({
        type: "evaluation",
        data: { staff_id: "staff_2f_01", item_id: "item_001", score: "B", updated_at: new Date().toISOString() },
      });
      await client.flushSyncQueue();

      assert.ok(states.includes("syncing"));
      assert.equal(states[states.length - 1], "synced");
    });

    it("F9-05: Status listener unsubscribe functions cleanly", async () => {
      const client = createSimulatedClient(env);
      let count = 0;
      const unsubscribe = client.onSyncStatusChange(() => count++);

      client.setSyncStatus("local_safe");
      assert.equal(count, 1);

      unsubscribe();
      client.setSyncStatus("synced");
      assert.equal(count, 1); // Not called after unsubscribe
    });
  });

  // =========================================================================
  // F10: Click-to-Retry Manual Sync
  // =========================================================================
  describe("F10: Click-to-Retry Manual Sync", () => {
    it("F10-01: Manual retry flushes pending queue immediately and returns true", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.syncQueue.push({
        type: "evaluation",
        data: { staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
      });
      const ok = await client.retrySyncManual();
      assert.equal(ok, true);
      assert.equal(client.syncQueue.length, 0);
      assert.equal(client.syncStatus, "synced");
    });

    it("F10-02: Manual retry during error state recovers cleanly", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({
        type: "evaluation",
        data: { staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
      });
      await client.flushSyncQueue();
      assert.equal(client.syncStatus, "error");

      // Recover server and manual retry
      client.simulateServerError = false;
      const ok = await client.retrySyncManual();
      assert.equal(ok, true);
      assert.equal(client.syncStatus, "synced");
    });

    it("F10-03: Manual retry failure when still offline returns false", async () => {
      const client = createSimulatedClient(env, { online: false });
      const ok = await client.retrySyncManual();
      assert.equal(ok, false);
      assert.equal(client.syncStatus, "local_safe");
    });

    it("F10-04: Manual retry fetches fresh bootstrap data from server", async () => {
      await d1.prepare("UPDATE advisors SET advisor_name = '更新後アドバイザー' WHERE floor = '2F'").run();
      const client = createSimulatedClient(env, { online: true });
      await client.retrySyncManual();
      assert.equal(client.data.advisors["2F"], "更新後アドバイザー");
    });

    it("F10-05: Rapid repeated manual retry calls resolve without promise rejection", async () => {
      const client = createSimulatedClient(env, { online: true });
      const results = await Promise.all([client.retrySyncManual(), client.retrySyncManual()]);
      assert.ok(results.every((r) => r === true));
    });
  });

  // =========================================================================
  // F11: Master Questionnaire & Layout Immutability
  // =========================================================================
  describe("F11: Master Questionnaire & Layout Immutability", () => {
    it("F11-01: Exactly 21 mid-items exist with correct format", () => {
      const master = getTechnicalSheetMaster();
      let midCount = 0;
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          midCount += sub.mid_items.length;
        });
      });
      assert.equal(midCount, 21);
    });

    it("F11-02: Exactly 89 checkpoints and 175 subchecks exist", () => {
      const master = getTechnicalSheetMaster();
      let cpCount = 0;
      let subCheckCount = 0;
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          sub.mid_items.forEach((mid) => {
            cpCount += mid.checkpoints.length;
            mid.checkpoints.forEach((cp) => {
              subCheckCount += (cp.sub_checks ? cp.sub_checks.length : 0);
            });
          });
        });
      });
      assert.equal(cpCount, 89);
      assert.equal(subCheckCount, 175);
    });

    it("F11-03: All mid-items have has_check_eval, has_score, and has_memo enabled", () => {
      const master = getTechnicalSheetMaster();
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          sub.mid_items.forEach((mid) => {
            assert.equal(mid.has_check_eval, true);
            assert.equal(mid.has_score, true);
            assert.equal(mid.has_memo, true);
          });
        });
      });
    });

    it("F11-04: Staff progress calculation reaches 100% when all 21 items evaluated", () => {
      const client = createSimulatedClient(env);
      const master = getTechnicalSheetMaster();
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          sub.mid_items.forEach((mid) => {
            client.data.evaluations[`staff_2f_01_${mid.id}`] = { score: "A" };
          });
        });
      });
      const prog = client.calcStaffProgress("staff_2f_01");
      assert.equal(prog.completed, 21);
      assert.equal(prog.total, 21);
      assert.equal(prog.percent, 100);
    });

    it("F11-05: Floor progress calculates percentage of staff members at 100%", () => {
      const client = createSimulatedClient(env);
      client.data.staff = [
        { id: "s1", floor: "2F", name: "Staff 1" },
        { id: "s2", floor: "2F", name: "Staff 2" },
      ];
      // s1 has 100%
      const master = getTechnicalSheetMaster();
      master.forEach((c) => c.subcategories.forEach((s) => s.mid_items.forEach((m) => {
        client.data.evaluations[`s1_${m.id}`] = { score: "A" };
      })));
      // s2 has 0%
      const floorProg = client.calcFloorProgress("2F");
      assert.equal(floorProg.completed, 1);
      assert.equal(floorProg.total, 2);
      assert.equal(floorProg.percent, 50);
    });
  });

  // =========================================================================
  // F12: Multi-Device Concurrent Simulation
  // =========================================================================
  describe("F12: Multi-Device Concurrent Simulation", () => {
    it("F12-01: Two devices updating different items of same staff both persist", async () => {
      const devA = createSimulatedClient(env, { name: "Device_A" });
      const devB = createSimulatedClient(env, { name: "Device_B" });

      devA.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      devB.saveEvaluation("staff_2f_01", "item_002", { score: "B" });

      await Promise.all([devA.flushSyncQueue(), devB.flushSyncQueue()]);

      const r1 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first("score");
      const r2 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_002'").first("score");
      assert.equal(r1, "A");
      assert.equal(r2, "B");
    });

    it("F12-02: Two devices updating same item resolves deterministically via LWW", async () => {
      const devA = createSimulatedClient(env, { name: "Device_A" });
      const devB = createSimulatedClient(env, { name: "Device_B" });

      devA.saveEvaluation("staff_2f_01", "item_001", { score: "C", updated_at: "2026-09-26T10:00:00Z" });
      devB.saveEvaluation("staff_2f_01", "item_001", { score: "A", updated_at: "2026-09-26T10:05:00Z" });

      await devA.flushSyncQueue();
      await devB.flushSyncQueue();

      const winner = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first("score");
      assert.equal(winner, "A");
    });

    it("F12-03: Four floor advisors (2F, 3F, 4F, 5F) sync simultaneously without collision", async () => {
      const advisors = ["2F", "3F", "4F", "5F"].map((floor) =>
        createSimulatedClient(env, { name: `Advisor_${floor}` })
      );

      advisors.forEach((adv, i) => {
        const floor = ["2F", "3F", "4F", "5F"][i];
        const staffId = `staff_${floor.toLowerCase()}_01`;
        adv.saveEvaluation(staffId, "item_001", { score: "A", memo: `${floor}完了` });
      });

      const results = await Promise.all(advisors.map((adv) => adv.flushSyncQueue()));
      assert.ok(results.every((r) => r === true));

      const count = await d1.prepare("SELECT count(*) as c FROM evaluations").first("c");
      assert.equal(count, 4);
    });

    it("F12-04: Simultaneous staff addition and advisor modification both persist", async () => {
      const devA = createSimulatedClient(env, { name: "Admin_PC" });
      const devB = createSimulatedClient(env, { name: "Advisor_Tablet" });

      await devA.saveStaff({ id: "staff_extra_1", floor: "4F", name: "特別スタッフ" });
      await devB.setAdvisorName("4F", "新アドバイザー4F");

      const staff = await d1.prepare("SELECT name FROM staff WHERE id = 'staff_extra_1'").first("name");
      const adv = await d1.prepare("SELECT advisor_name FROM advisors WHERE floor = '4F'").first("advisor_name");
      assert.equal(staff, "特別スタッフ");
      assert.equal(adv, "新アドバイザー4F");
    });

    it("F12-05: Concurrent sync updates and bootstrap reads execute without database lock", async () => {
      const writeDev = createSimulatedClient(env);
      const readDev = createSimulatedClient(env);

      writeDev.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

      await Promise.all([
        writeDev.flushSyncQueue(),
        readDev.fetchBootstrap(),
        readDev.fetchBootstrap(),
      ]);

      assert.equal(readDev.data.staff.length, 8);
    });
  });
});
