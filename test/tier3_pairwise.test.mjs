/**
 * test/tier3_pairwise.test.mjs
 * Tier 3: Pairwise Combinatorial Interaction Suite (15 comprehensive interaction tests).
 * Tests multi-feature interactions (offline queue + staff deletion + clock skew, etc.)
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

describe("Tier 3: Pairwise Combinatorial Interaction Suite (P01-P15)", () => {
  let d1;
  let env;

  beforeEach(() => {
    d1 = createMockD1();
    env = createWorkerEnv(d1);
  });

  it("P01: Offline Queue (F4) + Staff Deletion on Server (F1) + Clock Skew (+1h) (F8)", async () => {
    // 1. Mobile client goes offline with +1 hour clock skew
    const client = createSimulatedClient(env, { online: false, clockOffsetMs: 3600000 });
    // 2. Server deletes staff_2f_01
    await callWorker(env, "DELETE", "/api/staff/staff_2f_01");

    // 3. Client edits evaluations for deleted staff_2f_01 while offline
    client.saveEvaluation("staff_2f_01", "item_001", { score: "A", memo: "オフライン入力" });
    assert.equal(client.syncQueue.length, 1);

    // 4. Client reconnects: auto-flush does NOT crash (F1 safe upsert), bootstrap prunes zombie (F8)
    await client.setOnline(true);

    assert.equal(client.syncStatus, "synced");
    assert.equal(client.syncQueue.length, 0);
    // Zombie evaluation is purged from client local cache
    assert.equal(client.data.evaluations["staff_2f_01_item_001"], undefined);
    // D1 evaluations table has 0 records for staff_2f_01
    const count = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_01'").first("c");
    assert.equal(count, 0);
  });

  it("P02: Offline Queue (F4) + Network Flapping 503 (F5) + Auto-Flush (F6)", async () => {
    const client = createSimulatedClient(env, { online: false });
    client.saveEvaluation("staff_2f_02", "item_001", { score: "B" });
    client.saveEvaluation("staff_2f_02", "item_002", { score: "A" });
    assert.equal(client.syncQueue.length, 2);

    // Flap 1: Server errors out with 503
    client.online = true;
    client.fetch = async () => ({ status: 503, ok: false, json: async () => ({ error: "Unavailable" }) });
    await client.flushSyncQueue();
    assert.equal(client.syncStatus, "error");
    assert.equal(client.syncQueue.length, 2); // Queue preserved
    assert.equal(client.backoffFailures, 1);

    // Flap 2: Server recovers, network event triggers auto-flush
    client.online = false;
    client.fetch = createSimulatedClient(env).fetch.bind(client);
    await client.setOnline(true);
    assert.equal(client.syncStatus, "synced");
    assert.equal(client.syncQueue.length, 0);

    const r1 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_02' AND item_id = 'item_001'").first("score");
    const r2 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_02' AND item_id = 'item_002'").first("score");
    assert.equal(r1, "B");
    assert.equal(r2, "A");
  });

  it("P03: Staff Addition Offline (F7) + Instant Evaluation (F4) + Server LWW (F2)", async () => {
    const client = createSimulatedClient(env, { online: false });
    // 1. Add staff offline
    client.saveStaff({ id: "staff_new_floor3", floor: "3F", name: "新人介護士 (ローカル名)" });
    // 2. Add evaluation for new staff offline
    client.saveEvaluation("staff_new_floor3", "item_001", { score: "A" });

    // 3. Concurrently on server, admin added staff_new_floor3 with newer timestamp
    await callWorker(env, "POST", "/api/staff", {
      id: "staff_new_floor3",
      floor: "3F",
      name: "新人介護士 (本名確定版)",
      updated_at: new Date(Date.now() + 50000).toISOString(),
    });

    // 4. Client reconnects and flushes
    await client.setOnline(true);
    assert.equal(client.syncQueue.length, 0);

    // Evaluation persisted
    const evalRow = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_new_floor3'").first("score");
    assert.equal(evalRow, "A");
  });

  it("P04: Multi-item Mixed Batch (F1) + Stale vs Fresh Timestamp (F2) + Metadata Accounting (F3)", async () => {
    // Setup existing evaluation with known timestamp
    await callWorker(env, "POST", "/api/evaluations/sync", {
      items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "B", updated_at: "2026-09-26T12:00:00Z" }],
    });

    // Batch with 4 items:
    // 1) staff_2f_01, item_002 (valid, fresh) -> inserted
    // 2) staff_2f_01, item_001 (valid, stale) -> ignored by LWW
    // 3) staff_phantom_99 (nonexistent) -> ignored by FK guard
    // 4) staff_2f_02, item_001 (valid, fresh) -> inserted
    const res = await callWorker(env, "POST", "/api/evaluations/sync", {
      items: [
        { staff_id: "staff_2f_01", item_id: "item_002", score: "A", updated_at: "2026-09-26T12:05:00Z" },
        { staff_id: "staff_2f_01", item_id: "item_001", score: "C", updated_at: "2026-09-26T11:55:00Z" },
        { staff_id: "staff_phantom_99", item_id: "item_001", score: "A", updated_at: "2026-09-26T12:05:00Z" },
        { staff_id: "staff_2f_02", item_id: "item_001", score: "A", updated_at: "2026-09-26T12:05:00Z" },
      ],
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.count, 4);
    assert.equal(res.json.updated, 2); // exactly 2 updated

    const r1 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first("score");
    assert.equal(r1, "B"); // kept original "B", not stale "C"
  });

  it("P05: Advisor Rename Offline (F7) + Remote Advisor Rename (F2) + Clock Skew (F8)", async () => {
    const devA = createSimulatedClient(env, { online: false, clockOffsetMs: -1800000 }); // 30m behind
    const devB = createSimulatedClient(env, { online: true });

    // Device A renames offline
    devA.setAdvisorName("2F", "アドバイザーA (旧)");

    // Device B renames online later
    await devB.setAdvisorName("2F", "アドバイザーB (最新)");

    // Device A comes online
    await devA.setOnline(true);

    const winner = await d1.prepare("SELECT advisor_name FROM advisors WHERE floor = '2F'").first("advisor_name");
    assert.equal(winner, "アドバイザーB (最新)");
  });

  it("P06: Exponential Backoff Max (F5) + Manual Click-to-Retry (F10) + State Transition (F9)", async () => {
    const client = createSimulatedClient(env, { online: true });
    client.simulateServerError = true;
    client.syncQueue.push({ type: "evaluation", data: { staff_id: "staff_2f_01", item_id: "item_001", score: "A" } });

    // Accumulate failures to reach max backoff
    for (let i = 0; i < 6; i++) {
      await client.flushSyncQueue();
    }
    assert.equal(client.backoffDelayMs, 30000);
    assert.equal(client.syncStatus, "error");

    // Click retry
    client.simulateServerError = false;
    const ok = await client.retrySyncManual();
    assert.equal(ok, true);
    assert.equal(client.backoffDelayMs, 2000);
    assert.equal(client.backoffFailures, 0);
    assert.equal(client.syncStatus, "synced");
  });

  it("P07: Staff Re-order Offline (F7) + Floor Change Offline (F7) + Progress Calculation (F11)", async () => {
    const client = createSimulatedClient(env, { online: false });
    await client.fetchBootstrap();

    // Reassign staff_2f_01 to 3F with order 9
    client.saveStaff({
      id: "staff_2f_01",
      floor: "3F",
      name: "介護スタッフ A (フロア異動)",
      order_num: 9,
    });
    // Add evaluation
    client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

    // Progress
    const prog = client.calcStaffProgress("staff_2f_01");
    assert.equal(prog.completed, 1);

    // Sync online
    await client.setOnline(true);
    const dbStaff = await d1.prepare("SELECT floor, order_num FROM staff WHERE id = 'staff_2f_01'").first();
    assert.equal(dbStaff.floor, "3F");
    assert.equal(dbStaff.order_num, 9);
  });

  it("P08: Rapid Double-Tap / Debounce (F4) + Status Indicator Callback (F9)", async () => {
    const client = createSimulatedClient(env, { online: false });
    const statuses = [];
    client.onSyncStatusChange((s) => statuses.push(s));

    // Rapid toggle
    client.saveEvaluation("staff_2f_01", "item_001", { check_eval: "circle" });
    client.saveEvaluation("staff_2f_01", "item_001", { check_eval: "cross" });
    client.saveEvaluation("staff_2f_01", "item_001", { check_eval: "circle" });

    assert.equal(client.syncQueue.length, 1);
    assert.equal(client.syncQueue[0].data.check_eval, "circle");
    assert.equal(client.syncStatus, "local_safe");
  });

  it("P09: Negative Clock Skew (-2h) (F8) + Multi-Device Concurrent Simulation (F12)", async () => {
    const devNegative = createSimulatedClient(env, { online: true, clockOffsetMs: -7200000 }); // -2 hours
    const devNormal = createSimulatedClient(env, { online: true });

    // Both bootstrap
    await devNegative.fetchBootstrap();
    await devNormal.fetchBootstrap();

    // Normal client sets score B
    await devNormal.saveEvaluation("staff_2f_01", "item_001", { score: "B" });

    // Ensure distinct millisecond in wall-clock time
    await new Promise((r) => setTimeout(r, 20));

    // Negative client sets score A (drift is normalized so its real-time action counts)
    await devNegative.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

    const finalScore = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first("score");
    assert.equal(finalScore, "A");
  });

  it("P10: LocalStorage Corrupted Restart (F4) + Empty Queue (F6) + Fresh Bootstrap (F3)", async () => {
    const client = createSimulatedClient(env, { online: true });
    // Write corrupted data
    client.localStorage.setItem("TECHNICAL_SHEET_DATA_V2", "!!corrupted!!");
    client.localStorage.setItem("TECHNICAL_SHEET_QUEUE_V2", "!!corrupted!!");

    client.loadFromStorage();
    assert.deepEqual(client.syncQueue, []);

    // Fresh bootstrap restores data
    await client.fetchBootstrap();
    assert.equal(client.data.staff.length, 8);
    assert.equal(client.data.advisors["2F"], "2F担当アドバイザー");
  });

  it("P11: Cascading Staff Deletion (F1) + Active Offline Queue (F4) + Zombie Evaluation Purge (F8)", async () => {
    const client = createSimulatedClient(env, { online: false });
    await client.fetchBootstrap();

    // Queued evaluation for staff_2f_01
    client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });
    // Then staff_2f_01 deleted locally
    client.deleteStaff("staff_2f_01");

    // Queue should NOT contain evaluation for staff_2f_01 anymore
    const evalInQueue = client.syncQueue.find((m) => m.type === "evaluation" && m.data.staff_id === "staff_2f_01");
    assert.equal(evalInQueue, undefined);

    await client.setOnline(true);
    const count = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_01'").first("c");
    assert.equal(count, 0);
  });

  it("P12: In-Flight Auto-Flush (F6) + New Offline Mutation (F4) + Concurrency Lock (F12)", async () => {
    const client = createSimulatedClient(env, { online: true });
    await client.saveEvaluation("staff_2f_01", "item_001", { score: "A" });

    // Trigger flush and simultaneously add another evaluation
    const pFlush = client.flushSyncQueue();
    await client.saveEvaluation("staff_2f_01", "item_002", { score: "B" });
    await pFlush;

    const r1 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first("score");
    const r2 = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_002'").first("score");
    assert.equal(r1, "A");
    assert.equal(r2, "B");
  });

  it("P13: Offline Queue (F4) + All 21 Items Completed (F11) + Floor Progress (F11)", async () => {
    const client = createSimulatedClient(env, { online: false });
    const master = getTechnicalSheetMaster();

    // Complete all 21 items for staff_3f_01 offline
    master.forEach((cat) => cat.subcategories.forEach((sub) => sub.mid_items.forEach((mid) => {
      client.saveEvaluation("staff_3f_01", mid.id, { score: "A", check_eval: "circle" });
    })));

    const staffProg = client.calcStaffProgress("staff_3f_01");
    assert.equal(staffProg.percent, 100);

    // Reconnect and sync all 21
    await client.setOnline(true);
    const dbCount = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_3f_01'").first("c");
    assert.equal(dbCount, 21);
  });

  it("P14: Multi-Advisor Independent Floor Editing (F12) + Advisor Setting (F3) + Status Transition (F9)", async () => {
    const floors = ["2F", "3F", "4F", "5F"];
    const advisors = floors.map((fl) => createSimulatedClient(env, { name: `Advisor_${fl}`, online: true }));

    // Each updates their own floor advisor name and 1 evaluation
    await Promise.all(advisors.map(async (adv, i) => {
      const fl = floors[i];
      await adv.setAdvisorName(fl, `${fl}マスター指導員`);
      await adv.saveEvaluation(`staff_${fl.toLowerCase()}_01`, "item_001", { score: "A" });
    }));

    // Check all floors in D1
    for (const fl of floors) {
      const adv = await d1.prepare("SELECT advisor_name FROM advisors WHERE floor = ?").bind(fl).first("advisor_name");
      assert.equal(adv, `${fl}マスター指導員`);
      const ev = await d1.prepare("SELECT score FROM evaluations WHERE staff_id = ?").bind(`staff_${fl.toLowerCase()}_01`).first("score");
      assert.equal(ev, "A");
    }
  });

  it("P15: Manual Retry (F10) + Server Flapping (F5) + Eventual Consistency (F2)", async () => {
    const client = createSimulatedClient(env, { online: true });
    client.saveEvaluation("staff_2f_01", "item_001", { score: "A", memo: "最終整合性テスト" });

    // Transient failure
    client.simulateServerError = true;
    const ok1 = await client.retrySyncManual();
    assert.equal(ok1, false);
    assert.equal(client.syncStatus, "error");

    // Server recovers
    client.simulateServerError = false;
    const ok2 = await client.retrySyncManual();
    assert.equal(ok2, true);
    assert.equal(client.syncStatus, "synced");

    const memo = await d1.prepare("SELECT memo FROM evaluations WHERE staff_id = 'staff_2f_01'").first("memo");
    assert.equal(memo, "最終整合性テスト");
  });
});
