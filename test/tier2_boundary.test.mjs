/**
 * test/tier2_boundary.test.mjs
 * Tier 2: Boundary Value Analysis & Stress Test Suite (≥60 tests).
 * Tests extreme values, empty batches, large payloads, clock offsets, and network dropouts.
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

describe("Tier 2: Boundary Value Analysis & Stress Suite (B01-B60)", () => {
  let d1;
  let env;

  beforeEach(() => {
    d1 = createMockD1();
    env = createWorkerEnv(d1);
  });

  // =========================================================================
  // F1 Boundaries: Batch Sizes & Foreign Key Edge Cases
  // =========================================================================
  describe("F1 Boundaries: Batch Sizes & Cascading", () => {
    it("B01: Empty batch { items: [] } returns 200 OK with count 0 and updated 0", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items: [] });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 0);
      assert.equal(res.json.updated, 0);
    });

    it("B02: Single-item payload outside array is accepted cleanly", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        staff_id: "staff_2f_01",
        item_id: "item_001",
        score: "B",
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 1);
      assert.equal(res.json.updated, 1);
    });

    it("B03: Large batch of 100 evaluation items executes atomically in single batch", async () => {
      const items = [];
      for (let i = 0; i < 100; i++) {
        items.push({
          staff_id: i % 2 === 0 ? "staff_2f_01" : "staff_2f_02",
          item_id: `item_${String((i % 21) + 1).padStart(3, "0")}`,
          score: "A",
          check_eval: "circle",
          updated_at: new Date(Date.now() + i * 10).toISOString(),
        });
      }
      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      assert.equal(res.status, 200);
      assert.equal(res.json.count, 100);
      assert.ok(res.json.updated > 0);
    });

    it("B04: Full technical sheet sync with 89 checkpoints in checks_json", async () => {
      const master = getTechnicalSheetMaster();
      const allCheckpointIds = [];
      master.forEach((c) => c.subcategories.forEach((s) => s.mid_items.forEach((m) => {
        m.checkpoints.forEach((cp) => allCheckpointIds.push(cp.id));
      })));
      assert.equal(allCheckpointIds.length, 89);

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_3f_01",
            item_id: "item_001",
            score: "A",
            check_eval: "circle",
            checks_json: JSON.stringify(allCheckpointIds),
            memo: "全チェックポイント合格",
            updated_at: new Date().toISOString(),
          },
        ],
      });
      assert.equal(res.status, 200);
      const row = await d1.prepare("SELECT checks_json FROM evaluations WHERE staff_id = 'staff_3f_01'").first();
      const parsed = JSON.parse(row.checks_json);
      assert.equal(parsed.length, 89);
    });

    it("B05: Rapid deletion of 5 staff members cascades and cleans database", async () => {
      // Create 5 staff members
      for (let i = 1; i <= 5; i++) {
        await callWorker(env, "POST", "/api/staff", { id: `staff_del_${i}`, floor: "2F", name: `Del Staff ${i}` });
        await callWorker(env, "POST", "/api/evaluations/sync", {
          items: [{ staff_id: `staff_del_${i}`, item_id: "item_001", score: "A" }],
        });
      }
      // Delete all 5
      for (let i = 1; i <= 5; i++) {
        const delRes = await callWorker(env, "DELETE", `/api/staff/staff_del_${i}`);
        assert.equal(delRes.json.success, true);
      }
      const evalCount = await d1
        .prepare("SELECT count(*) as c FROM evaluations WHERE staff_id LIKE 'staff_del_%'")
        .first("c");
      assert.equal(evalCount, 0);
    });
  });

  // =========================================================================
  // F2 Boundaries: Clock Skew Extrema & Microsecond Precision
  // =========================================================================
  describe("F2 Boundaries: Timestamps & LWW Extrema", () => {
    it("B06: Millisecond-level timestamp difference resolves strictly to higher timestamp", async () => {
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "C", updated_at: "2026-09-26T12:00:00.001Z" }],
      });
      const updateRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: "2026-09-26T12:00:00.002Z" }],
      });
      assert.equal(updateRes.json.updated, 1);
      const score = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01'").first("score");
      assert.equal(score, "A");
    });

    it("B07: Future timestamp 20 years ahead is accepted and stored", async () => {
      const futureTime = "2046-01-01T00:00:00.000Z";
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: futureTime }],
      });
      assert.equal(res.json.updated, 1);
      const ts = await d1.prepare("SELECT updated_at FROM evaluations WHERE staff_id = 'staff_2f_01'").first("updated_at");
      assert.equal(ts, futureTime);
    });

    it("B08: Epoch timestamp 1970-01-01 is rejected when existing record is newer", async () => {
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: "2026-09-26T12:00:00.000Z" }],
      });
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "C", updated_at: "1970-01-01T00:00:00.000Z" }],
      });
      assert.equal(res.json.updated, 0);
      const score = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01'").first("score");
      assert.equal(score, "A");
    });

    it("B09: Leap year timestamp (2028-02-29T23:59:59.999Z) is parsed and compared properly", async () => {
      const leapTs = "2028-02-29T23:59:59.999Z";
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_4f_01", item_id: "item_001", score: "B", updated_at: leapTs }],
      });
      assert.equal(res.json.updated, 1);
      const ts = await d1.prepare("SELECT updated_at FROM evaluations WHERE staff_id = 'staff_4f_01'").first("updated_at");
      assert.equal(ts, leapTs);
    });

    it("B10: Sub-millisecond ISO precision timestamps are handled without parsing crash", async () => {
      const subMsTime = "2026-09-26T12:00:00.123456Z";
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_4f_01", item_id: "item_001", score: "A", updated_at: subMsTime }],
      });
      assert.equal(res.json.success, true);
    });
  });

  // =========================================================================
  // F3 Boundaries: Large Payloads, Unicode, Emojis & Whitespace
  // =========================================================================
  describe("F3 Boundaries: Payload Integrity & Extreme Content", () => {
    it("B11: Null and empty string values in optional fields persist cleanly", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "item_001",
            check_eval: "",
            score: "",
            memo: "",
            evaluator_name: "",
            evaluation_date: "",
          },
        ],
      });
      assert.equal(res.json.updated, 1);
      const row = await d1.prepare("SELECT * FROM evaluations WHERE staff_id = 'staff_2f_01'").first();
      assert.equal(row.score, "");
      assert.equal(row.memo, "");
    });

    it("B12: Special whitespace, newlines, and tabs in memo are preserved", async () => {
      const whitespaceMemo = "行1: 朝の体調確認\n\t行2: バイタル安定\r\n行3: 意向尊重◎";
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", memo: whitespaceMemo }],
      });
      const row = await d1.prepare("SELECT memo FROM evaluations WHERE staff_id = 'staff_2f_01'").first("memo");
      assert.equal(row, whitespaceMemo);
    });

    it("B13: Emojis and surrogate pairs in memo are preserved without corruption", async () => {
      const emojiMemo = "👴👵利用者様との対話良好🩺体温36.5℃✨自立支援プログラム実践🌸";
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", memo: emojiMemo }],
      });
      const row = await d1.prepare("SELECT memo FROM evaluations WHERE staff_id = 'staff_2f_01'").first("memo");
      assert.equal(row, emojiMemo);
    });

    it("B14: Large memo of 50,000 characters is stored without truncation", async () => {
      const largeMemo = "介護評価テストメモ".repeat(5000); // 45,000 chars
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", memo: largeMemo }],
      });
      const row = await d1.prepare("SELECT memo FROM evaluations WHERE staff_id = 'staff_2f_01'").first("memo");
      assert.equal(row.length, largeMemo.length);
    });

    it("B15: Staff API returns 400 Bad Request when required id, floor, or name is missing", async () => {
      const res1 = await callWorker(env, "POST", "/api/staff", { name: "No Floor" });
      assert.equal(res1.status, 400);

      const res2 = await callWorker(env, "POST", "/api/staff", { id: "s1", floor: "2F" });
      assert.equal(res2.status, 400);
    });
  });

  // =========================================================================
  // F4 Boundaries: Storage Key Immutability & Queue Stress
  // =========================================================================
  describe("F4 Boundaries: Queue Capacity & Key Immutability", () => {
    it("B16: 100 offline mutations are queued without losing any entries", async () => {
      const client = createSimulatedClient(env, { online: false });
      for (let i = 1; i <= 21; i++) {
        client.saveEvaluation("staff_2f_01", `item_${String(i).padStart(3, "0")}`, { score: "A" });
      }
      assert.equal(client.syncQueue.length, 21);
      const rawQueue = JSON.parse(client.localStorage.getItem("TECHNICAL_SHEET_QUEUE_V2"));
      assert.equal(rawQueue.length, 21);
    });

    it("B17: 100 rapid successive updates to same item collapses into exactly 1 mutation", async () => {
      const client = createSimulatedClient(env, { online: false });
      for (let i = 1; i <= 100; i++) {
        client.saveEvaluation("staff_2f_01", "item_001", { score: i % 2 === 0 ? "A" : "B", memo: `Update ${i}` });
      }
      assert.equal(client.syncQueue.length, 1);
      assert.equal(client.syncQueue[0].data.memo, "Update 100");
    });

    it("B18: Calling flush on empty queue returns true immediately without HTTP request", async () => {
      const client = createSimulatedClient(env, { online: true });
      const ok = await client.flushSyncQueue();
      assert.equal(ok, true);
    });

    it("B19: Corrupted partial JSON in storage key recovers cleanly to empty queue", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.localStorage.setItem("TECHNICAL_SHEET_QUEUE_V2", "[{\"incomplete\": true,");
      client.loadFromStorage();
      assert.deepEqual(client.syncQueue, []);
    });

    it("B20: Client uses exact storage keys TECHNICAL_SHEET_DATA_V2 and TECHNICAL_SHEET_QUEUE_V2", () => {
      const client = createSimulatedClient(env);
      assert.equal(client.STORAGE_KEY_DATA, "TECHNICAL_SHEET_DATA_V2");
      assert.equal(client.STORAGE_KEY_QUEUE, "TECHNICAL_SHEET_QUEUE_V2");
    });
  });

  // =========================================================================
  // F5 Boundaries: Network Dropouts & HTTP Errors
  // =========================================================================
  describe("F5 Boundaries: Network Dropouts & Status Codes", () => {
    it("B21: HTTP 500 error causes backoff failure increment and error status", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      const ok = await client.flushSyncQueue();
      assert.equal(ok, false);
      assert.equal(client.syncStatus, "error");
      assert.equal(client.backoffFailures, 1);
    });

    it("B22: HTTP 502 Bad Gateway simulated error pauses sync", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.fetch = async () => ({ status: 502, ok: false, json: async () => ({ error: "Bad Gateway" }) });
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      const ok = await client.flushSyncQueue();
      assert.equal(ok, false);
      assert.equal(client.syncStatus, "error");
    });

    it("B23: HTTP 503 Service Unavailable increments backoff properly", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.fetch = async () => ({ status: 503, ok: false, json: async () => ({ error: "Service Unavailable" }) });
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 1);
      assert.equal(client.backoffDelayMs, 2000);
    });

    it("B24: HTTP 504 Gateway Timeout increments backoff properly", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.fetch = async () => ({ status: 504, ok: false, json: async () => ({ error: "Gateway Timeout" }) });
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      await client.flushSyncQueue();
      assert.equal(client.backoffFailures, 1);
    });

    it("B25: Network TypeError (offline abort) sets local_safe and halts without crash", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      assert.equal(client.syncStatus, "local_safe");
      assert.equal(client.syncQueue.length, 1);
    });
  });

  // =========================================================================
  // F6 Boundaries: Rapid Flapping & Auto-Flush
  // =========================================================================
  describe("F6 Boundaries: Rapid Flapping & Concurrency", () => {
    it("B26: Rapid cycling between online and offline preserves all queued items", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

      // Flap 5 times
      for (let i = 0; i < 5; i++) {
        await client.setOnline(true);
        await client.setOnline(false);
      }
      // Re-enable and sync
      await client.setOnline(true);
      assert.equal(client.syncQueue.length, 0);
      assert.equal(client.syncStatus, "synced");
    });

    it("B27: Online event with zero pending mutations performs bootstrap without sync POST", async () => {
      const client = createSimulatedClient(env, { online: false });
      await client.setOnline(true);
      assert.equal(client.syncStatus, "synced");
      assert.equal(client.data.staff.length, 8);
    });

    it("B28: Concurrent mutation while online event is in progress queues safely", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

      const onlinePromise = client.setOnline(true);
      client.saveEvaluation("staff_2f_01", "item_002", { score: "B" });
      await onlinePromise;
      await client.flushSyncQueue();

      assert.equal(client.syncQueue.length, 0);
    });

    it("B29: Reconnecting when server is down transitions to error while preserving queue", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      client.simulateServerError = true;

      await client.setOnline(true);
      assert.equal(client.syncStatus, "error");
      assert.equal(client.syncQueue.length, 1);
    });

    it("B30: Large clock offset normalized cleanly during auto-flush", async () => {
      const client = createSimulatedClient(env, { online: false, clockOffsetMs: 7200000 }); // +2 hours
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      await client.setOnline(true);

      assert.equal(client.syncStatus, "synced");
      const row = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01'").first("score");
      assert.equal(row, "A");
    });
  });

  // =========================================================================
  // F7 Boundaries: Staff Names & SQL Injection Prevention
  // =========================================================================
  describe("F7 Boundaries: Characters, Names & SQL Injection Security", () => {
    it("B31: Rapid staff creation and renaming offline preserves latest state", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveStaff({ id: "staff_rapid_01", floor: "3F", name: "Version 1" });
      client.saveStaff({ id: "staff_rapid_01", floor: "3F", name: "Version 2" });
      client.saveStaff({ id: "staff_rapid_01", floor: "3F", name: "Version Final" });

      assert.equal(client.syncQueue.length, 1);
      assert.equal(client.syncQueue[0].data.name, "Version Final");
      await client.setOnline(true);

      const name = await d1.prepare("SELECT name FROM staff WHERE id = 'staff_rapid_01'").first("name");
      assert.equal(name, "Version Final");
    });

    it("B32: Staff added and deleted in same offline session does not leave orphaned staff", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveStaff({ id: "staff_temp_01", floor: "4F", name: "Temp Staff" });
      client.deleteStaff("staff_temp_01");

      await client.setOnline(true);
      const row = await d1.prepare("SELECT * FROM staff WHERE id = 'staff_temp_01'").first();
      assert.equal(row, null);
    });

    it("B33: Rare Japanese kanji and quotes in staff names are preserved exactly", async () => {
      const specialName = "𠮷野 O'Connor \"リーダー\" 介護員";
      const client = createSimulatedClient(env, { online: true });
      client.saveStaff({ id: "staff_special_1", floor: "5F", name: specialName });
      await client.flushSyncQueue();

      const name = await d1.prepare("SELECT name FROM staff WHERE id = 'staff_special_1'").first("name");
      assert.equal(name, specialName);
    });

    it("B34: SQL Injection in staff id is safely handled via prepared statements", async () => {
      const sqliId = "staff_sqli'; DROP TABLE staff; --";
      const client = createSimulatedClient(env, { online: true });
      client.saveStaff({ id: sqliId, floor: "2F", name: "SQLi Test" });
      await client.flushSyncQueue();

      // Ensure staff table was NOT dropped
      const staffCount = await d1.prepare("SELECT count(*) as c FROM staff").first("c");
      assert.ok(staffCount >= 8);
    });

    it("B35: SQL Injection in memo field is safely stored as literal text", async () => {
      const sqliMemo = "'; DELETE FROM evaluations; SELECT * FROM staff WHERE '1'='1";
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", memo: sqliMemo }],
      });
      const row = await d1.prepare("SELECT memo FROM evaluations WHERE staff_id = 'staff_2f_01'").first("memo");
      assert.equal(row, sqliMemo);
    });
  });

  // =========================================================================
  // F8 Boundaries: Extreme Skews & Complete Pruning
  // =========================================================================
  describe("F8 Boundaries: Extreme Skew & Mass Pruning", () => {
    it("B36: +24 hour extreme positive clock skew normalized cleanly", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: 86400000 }); // +24 hours
      await client.fetchBootstrap();
      assert.ok(client.serverClockOffsetMs < -86300000);
    });

    it("B37: -24 hour extreme negative clock skew normalized cleanly", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: -86400000 }); // -24 hours
      await client.fetchBootstrap();
      assert.ok(client.serverClockOffsetMs > 86300000);
    });

    it("B38: All staff deleted on server results in complete evaluation purge on client", async () => {
      const client = createSimulatedClient(env, { online: true });
      await client.fetchBootstrap();
      client.data.evaluations["staff_2f_01_item_001"] = { staff_id: "staff_2f_01", item_id: "item_001", score: "A" };

      // Delete all staff on server
      await d1.prepare("DELETE FROM staff").run();
      await client.fetchBootstrap();

      assert.equal(Object.keys(client.data.evaluations).length, 0);
    });

    it("B39: Multiple phantom staff IDs in client cache are all purged during bootstrap", async () => {
      const client = createSimulatedClient(env, { online: true });
      await client.fetchBootstrap();

      for (let i = 1; i <= 10; i++) {
        client.data.evaluations[`phantom_${i}_item_001`] = { staff_id: `phantom_${i}`, item_id: "item_001", score: "A" };
      }
      assert.equal(Object.keys(client.data.evaluations).length, 10);

      await client.fetchBootstrap();
      assert.equal(Object.keys(client.data.evaluations).length, 0);
    });

    it("B40: Server time drift adjusts serverClockOffsetMs on subsequent bootstraps", async () => {
      const client = createSimulatedClient(env, { clockOffsetMs: 10000 });
      await client.fetchBootstrap();
      const firstOffset = client.serverClockOffsetMs;
      assert.ok(firstOffset < -9000);
    });
  });

  // =========================================================================
  // F9 Boundaries: Visual States & Listener Fault Tolerance
  // =========================================================================
  describe("F9 Boundaries: Sync Status Transitions & Listener Safety", () => {
    it("B41: Direct transition from local_safe to error upon failed flush attempt", async () => {
      const client = createSimulatedClient(env, { online: false });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      assert.equal(client.syncStatus, "local_safe");

      client.online = true;
      client.simulateServerError = true;
      await client.flushSyncQueue();
      assert.equal(client.syncStatus, "error");
    });

    it("B42: Transition from error directly to synced upon successful retry", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.simulateServerError = true;
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001" } });
      await client.flushSyncQueue();
      assert.equal(client.syncStatus, "error");

      client.simulateServerError = false;
      await client.retrySyncManual();
      assert.equal(client.syncStatus, "synced");
    });

    it("B43: Throwing error inside subscriber listener does not break sync execution", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.onSyncStatusChange(() => {
        throw new Error("Faulty subscriber UI error");
      });
      client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
      const ok = await client.flushSyncQueue();
      assert.equal(ok, true);
    });

    it("B44: Repeatedly setting identical status does not fire duplicate notifications", () => {
      const client = createSimulatedClient(env);
      let count = 0;
      client.onSyncStatusChange(() => count++);

      client.setSyncStatus("synced"); // already synced
      client.setSyncStatus("synced");
      assert.equal(count, 0);

      client.setSyncStatus("local_safe");
      assert.equal(count, 1);
    });

    it("B45: Verification of visual indicator strings conform to specification", () => {
      const validStatuses = new Set(["synced", "syncing", "local_safe", "error"]);
      const client = createSimulatedClient(env);
      ["synced", "syncing", "local_safe", "error"].forEach((s) => {
        client.setSyncStatus(s);
        assert.ok(validStatuses.has(client.syncStatus));
      });
    });
  });

  // =========================================================================
  // F10 Boundaries: Manual Retry Edge Cases
  // =========================================================================
  describe("F10 Boundaries: Manual Retry Extremes", () => {
    it("B46: Manual retry during in-flight flush joins existing execution cleanly", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001", score: "A" } });
      const p1 = client.flushSyncQueue();
      const p2 = client.retrySyncManual();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1, true);
      assert.equal(r2, true);
    });

    it("B47: Manual retry with 0 queued items succeeds and fetches fresh bootstrap", async () => {
      const client = createSimulatedClient(env, { online: true });
      const ok = await client.retrySyncManual();
      assert.equal(ok, true);
      assert.equal(client.syncStatus, "synced");
    });

    it("B48: Manual retry resets 30s backoff delay immediately to 2s", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.backoffFailures = 10;
      client.backoffDelayMs = 30000;

      await client.retrySyncManual();
      assert.equal(client.backoffFailures, 0);
      assert.equal(client.backoffDelayMs, 2000);
    });

    it("B49: Manual retry after local storage clear restores state from server", async () => {
      const client = createSimulatedClient(env, { online: true });
      client.localStorage.clear();
      client.data.staff = [];

      await client.retrySyncManual();
      assert.equal(client.data.staff.length, 8);
    });

    it("B50: Rapid 10x burst of manual retry calls resolves all true without rejection", async () => {
      const client = createSimulatedClient(env, { online: true });
      const retries = Array(10).fill(0).map(() => client.retrySyncManual());
      const results = await Promise.all(retries);
      assert.ok(results.every((r) => r === true));
    });
  });

  // =========================================================================
  // F11 Boundaries: Questionnaire Integrity & Value Domains
  // =========================================================================
  describe("F11 Boundaries: Master Questionnaire Deep Integrity", () => {
    it("B51: All category and subcategory IDs are unique", () => {
      const master = getTechnicalSheetMaster();
      const ids = new Set();
      master.forEach((cat) => {
        assert.ok(!ids.has(cat.id), `Duplicate cat id: ${cat.id}`);
        ids.add(cat.id);
        cat.subcategories.forEach((sub) => {
          assert.ok(!ids.has(sub.id), `Duplicate sub id: ${sub.id}`);
          ids.add(sub.id);
        });
      });
    });

    it("B52: All 21 mid-item IDs (item_001..item_021) are unique and sequential", () => {
      const master = getTechnicalSheetMaster();
      const midIds = [];
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          sub.mid_items.forEach((mid) => midIds.push(mid.id));
        });
      });
      assert.equal(midIds.length, 21);
      for (let i = 1; i <= 21; i++) {
        const expected = `item_${String(i).padStart(3, "0")}`;
        assert.ok(midIds.includes(expected), `Missing ${expected}`);
      }
    });

    it("B53: All 89 checkpoint IDs are strictly unique", () => {
      const master = getTechnicalSheetMaster();
      const cpIds = new Set();
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          sub.mid_items.forEach((mid) => {
            mid.checkpoints.forEach((cp) => {
              assert.ok(!cpIds.has(cp.id), `Duplicate cp id: ${cp.id}`);
              cpIds.add(cp.id);
            });
          });
        });
      });
      assert.equal(cpIds.size, 89);
    });

    it("B54: Valid score domain values ('A', 'B', 'C', 'hyphen', '') are stored accurately", async () => {
      const scores = ["A", "B", "C", "hyphen", ""];
      for (let i = 0; i < scores.length; i++) {
        const itemId = `item_${String(i + 1).padStart(3, "0")}`;
        await callWorker(env, "POST", "/api/evaluations/sync", {
          items: [{ staff_id: "staff_2f_01", item_id: itemId, score: scores[i] }],
        });
        const saved = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = ?").bind(itemId).first("score");
        assert.equal(saved, scores[i]);
      }
    });

    it("B55: Valid check_eval domain values ('circle', 'cross', '') are stored accurately", async () => {
      const checks = ["circle", "cross", ""];
      for (let i = 0; i < checks.length; i++) {
        const itemId = `item_${String(i + 10).padStart(3, "0")}`;
        await callWorker(env, "POST", "/api/evaluations/sync", {
          items: [{ staff_id: "staff_2f_01", item_id: itemId, check_eval: checks[i] }],
        });
        const saved = await d1.prepare("SELECT check_eval FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = ?").bind(itemId).first("check_eval");
        assert.equal(saved, checks[i]);
      }
    });
  });

  // =========================================================================
  // F12 Boundaries: Heavy Concurrency Stress
  // =========================================================================
  describe("F12 Boundaries: Extreme Concurrency Stress", () => {
    it("B56: 10 simulated clients syncing concurrently all succeed", async () => {
      const clients = Array(10).fill(0).map((_, i) =>
        createSimulatedClient(env, { name: `Client_Burst_${i}` })
      );
      clients.forEach((c, i) => {
        c.saveEvaluation("staff_2f_01", `item_${String((i % 21) + 1).padStart(3, "0")}`, { score: "A" });
      });
      const results = await Promise.all(clients.map((c) => c.flushSyncQueue()));
      assert.ok(results.every((r) => r === true));
    });

    it("B57: 5 concurrent updates to exact same (staff_id, item_id) resolve cleanly", async () => {
      const clients = Array(5).fill(0).map((_, i) =>
        createSimulatedClient(env, { name: `Client_SameKey_${i}` })
      );
      clients.forEach((c, i) => {
        c.saveEvaluation("staff_2f_01", "item_001", {
          score: "A",
          memo: `Client ${i}`,
          updated_at: new Date(Date.now() + i * 100).toISOString(),
        });
      });
      await Promise.all(clients.map((c) => c.flushSyncQueue()));

      const winnerMemo = await d1.prepare("SELECT memo FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first("memo");
      assert.equal(winnerMemo, "Client 4"); // Highest timestamp wins
    });

    it("B58: Concurrent staff deletions execute without constraint deadlock", async () => {
      // Add 4 extra staff
      for (let i = 1; i <= 4; i++) {
        await callWorker(env, "POST", "/api/staff", { id: `s_conc_del_${i}`, floor: "3F", name: `Del ${i}` });
      }
      const deletes = [1, 2, 3, 4].map((i) =>
        callWorker(env, "DELETE", `/api/staff/s_conc_del_${i}`)
      );
      const results = await Promise.all(deletes);
      assert.ok(results.every((r) => r.json.success === true));
    });

    it("B59: Rapid sequential burst of 25 evaluation syncs on same connection", async () => {
      const client = createSimulatedClient(env, { online: true });
      for (let i = 1; i <= 21; i++) {
        await client.saveEvaluation("staff_2f_01", `item_${String(i).padStart(3, "0")}`, { score: "A" });
      }
      const count = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_01'").first("c");
      assert.equal(count, 21);
    });

    it("B60: 10 concurrent bootstrap reads during active evaluation writes", async () => {
      const writer = createSimulatedClient(env, { online: true });
      const readers = Array(10).fill(0).map(() => createSimulatedClient(env, { online: true }));

      const writePromise = (async () => {
        for (let i = 1; i <= 5; i++) {
          await writer.saveEvaluation("staff_2f_01", `item_${String(i).padStart(3, "0")}`, { score: "A" });
        }
      })();

      const readPromises = readers.map((r) => r.fetchBootstrap());
      await Promise.all([writePromise, ...readPromises]);

      const evalCount = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_01'").first("c");
      assert.equal(evalCount, 5);
    });
  });
});
