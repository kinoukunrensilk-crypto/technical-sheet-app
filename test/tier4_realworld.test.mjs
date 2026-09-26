/**
 * test/tier4_realworld.test.mjs
 * Tier 4: Real-World Workload Scenarios (5 comprehensive multi-floor mobile advisor simulations).
 * Simulates real-world mobile usage across 2F-5F: WiFi dropouts, concurrent advisors,
 * concurrent staff deletion, offline new hire onboarding, and network flapping recovery.
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

describe("Tier 4: Real-World Multi-Floor Mobile Workload Scenarios", () => {
  let d1;
  let env;

  beforeEach(() => {
    d1 = createMockD1();
    env = createWorkerEnv(d1);
  });

  // =========================================================================
  // Scenario 1: 2F Advisor mobile evaluation during WiFi dropouts
  // =========================================================================
  it("Scenario 1: 2F Advisor mobile evaluation during WiFi dropouts across rooms 201-205", async () => {
    // 1. Advisor opens app at nurse station (online)
    const mobile2F = createSimulatedClient(env, { name: "2F_Smartphone", online: true });
    const bootOk = await mobile2F.fetchBootstrap();
    assert.equal(bootOk, true);
    assert.equal(mobile2F.syncStatus, "synced");
    assert.equal(mobile2F.data.staff.length, 8);

    // 2. Advisor walks into room 201 (WiFi disconnects)
    await mobile2F.setOnline(false);
    assert.equal(mobile2F.syncStatus, "local_safe");

    // 3. Evaluates staff_2f_01 for item_001 (入浴前の確認)
    mobile2F.saveEvaluation("staff_2f_01", "item_001", {
      score: "A",
      check_eval: "circle",
      checks_json: ["item_001_cp_1", "item_001_cp_2"],
      memo: "バイタル確認・意向尊重ともに優良",
      evaluator_name: "2F担当アドバイザー",
      evaluation_date: "2026-09-26",
    });
    assert.equal(mobile2F.syncQueue.length, 1);
    assert.equal(mobile2F.syncStatus, "local_safe");

    // 4. Advisor walks to room 203 (still offline), evaluates item_002 (衣服の着脱)
    mobile2F.saveEvaluation("staff_2f_01", "item_002", {
      score: "B",
      check_eval: "circle",
      checks_json: ["item_002_cp_1", "item_002_cp_3"],
      memo: "健側・患側の着脱順序指導を継続",
      evaluator_name: "2F担当アドバイザー",
      evaluation_date: "2026-09-26",
    });
    assert.equal(mobile2F.syncQueue.length, 2);

    // 5. Advisor returns to nurse station (WiFi reconnects)
    await mobile2F.setOnline(true);
    assert.equal(mobile2F.syncStatus, "synced");
    assert.equal(mobile2F.syncQueue.length, 0);

    // 6. Verify D1 database state and progress
    const ev1 = await d1.prepare("SELECT * FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'").first();
    const ev2 = await d1.prepare("SELECT * FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_002'").first();
    assert.ok(ev1);
    assert.equal(ev1.score, "A");
    assert.equal(ev1.memo, "バイタル確認・意向尊重ともに優良");
    assert.ok(ev2);
    assert.equal(ev2.score, "B");

    const prog = mobile2F.calcStaffProgress("staff_2f_01");
    assert.equal(prog.completed, 2);
    assert.equal(prog.total, 21);
    assert.equal(prog.percent, 10); // 2/21 = 10%
  });

  // =========================================================================
  // Scenario 2: Concurrent 3F and 4F floor evaluations on multiple staff members
  // =========================================================================
  it("Scenario 2: Concurrent 3F and 4F evaluations on multi-floor staff with Director PC viewing", async () => {
    const adv3F = createSimulatedClient(env, { name: "3F_Advisor_iPad", online: true });
    const adv4F = createSimulatedClient(env, { name: "4F_Advisor_Android", online: true });
    const directorPC = createSimulatedClient(env, { name: "Director_PC", online: true });

    // Initial bootstrap
    await Promise.all([adv3F.fetchBootstrap(), adv4F.fetchBootstrap(), directorPC.fetchBootstrap()]);

    // 3F updates advisor name and evaluates staff_3f_01 & staff_3f_02
    const p3F = (async () => {
      await adv3F.setAdvisorName("3F", "小林主任指導員");
      for (let i = 1; i <= 5; i++) {
        const itemId = `item_${String(i).padStart(3, "0")}`;
        await adv3F.saveEvaluation("staff_3f_01", itemId, { score: "A", memo: `3F-01 item ${i}` });
        await adv3F.saveEvaluation("staff_3f_02", itemId, { score: "B", memo: `3F-02 item ${i}` });
      }
    })();

    // 4F updates advisor name and evaluates staff_4f_01 & staff_4f_02
    const p4F = (async () => {
      await adv4F.setAdvisorName("4F", "加藤副主任指導員");
      for (let i = 1; i <= 5; i++) {
        const itemId = `item_${String(i).padStart(3, "0")}`;
        await adv4F.saveEvaluation("staff_4f_01", itemId, { score: "A", memo: `4F-01 item ${i}` });
        await adv4F.saveEvaluation("staff_4f_02", itemId, { score: "C", memo: `4F-02 item ${i}` });
      }
    })();

    await Promise.all([p3F, p4F]);

    // Director PC fetches bootstrap to view combined facility state
    await directorPC.fetchBootstrap();

    assert.equal(directorPC.data.advisors["3F"], "小林主任指導員");
    assert.equal(directorPC.data.advisors["4F"], "加藤副主任指導員");

    // Total 20 evaluations recorded across 3F and 4F (4 staff * 5 items)
    const count = await d1.prepare("SELECT count(*) as c FROM evaluations").first("c");
    assert.equal(count, 20);

    // Verify director PC local evaluations match D1
    assert.equal(Object.keys(directorPC.data.evaluations).length, 20);
  });

  // =========================================================================
  // Scenario 3: Staff deletion on PC while mobile advisor edits evaluations offline
  // =========================================================================
  it("Scenario 3: Staff deletion on PC while mobile advisor edits evaluations offline in dead spot", async () => {
    const pcAdmin = createSimulatedClient(env, { name: "Admin_PC", online: true });
    const mobile = createSimulatedClient(env, { name: "Advisor_Mobile", online: true });

    // Initial state synchronized
    await Promise.all([pcAdmin.fetchBootstrap(), mobile.fetchBootstrap()]);
    assert.ok(mobile.data.staff.find((s) => s.id === "staff_2f_02"));

    // 1. Mobile advisor walks into elevator (offline dead spot)
    await mobile.setOnline(false);

    // 2. Meanwhile on PC, staff_2f_02 resigns and is deleted by Admin
    await pcAdmin.deleteStaff("staff_2f_02");

    // Verify staff deleted from D1
    const staffInDb = await d1.prepare("SELECT * FROM staff WHERE id = 'staff_2f_02'").first();
    assert.equal(staffInDb, null);

    // 3. In the elevator, mobile advisor fills out evaluation for staff_2f_02
    mobile.saveEvaluation("staff_2f_02", "item_001", {
      score: "A",
      check_eval: "circle",
      memo: "オフライン作成の評価メモ",
    });
    assert.equal(mobile.syncQueue.length, 1);
    assert.equal(mobile.syncStatus, "local_safe");

    // 4. Mobile advisor exits elevator and reconnects to WiFi
    await mobile.setOnline(true);

    // 5. Verification:
    // Safe upsert (F1) silently ignored evaluation for nonexistent staff without crashing
    // Bootstrap purged zombie evaluations for deleted staff (F8)
    assert.equal(mobile.syncStatus, "synced");
    assert.equal(mobile.syncQueue.length, 0);

    // D1 evaluations must contain 0 records for staff_2f_02
    const evalCount = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_02'").first("c");
    assert.equal(evalCount, 0);

    // Mobile local state no longer has evaluation for staff_2f_02
    assert.equal(mobile.data.evaluations["staff_2f_02_item_001"], undefined);
    assert.equal(mobile.data.staff.find((s) => s.id === "staff_2f_02"), undefined);
  });

  // =========================================================================
  // Scenario 4: Offline staff addition and full evaluation across 21 mid-items
  // =========================================================================
  it("Scenario 4: New staff onboarding offline and full evaluation across 21 mid-items", async () => {
    const adv5F = createSimulatedClient(env, { name: "5F_Advisor", online: false });
    const master = getTechnicalSheetMaster();

    // 1. Advisor on 5F creates new recruit offline
    const newStaffId = "staff_5f_newhire";
    adv5F.saveStaff({
      id: newStaffId,
      floor: "5F",
      name: "新人介護職員 佐藤",
      role: "general",
      order_num: 3,
    });

    // 2. Advisor completes full 21 mid-item assessment offline
    master.forEach((cat) => {
      cat.subcategories.forEach((sub) => {
        sub.mid_items.forEach((mid) => {
          adv5F.saveEvaluation(newStaffId, mid.id, {
            score: "A",
            check_eval: "circle",
            memo: `${mid.title} 完了`,
            evaluator_name: "5F指導員",
            evaluation_date: "2026-09-26",
          });
        });
      });
    });

    // 3. Local progress calculation confirms 100%
    const localProg = adv5F.calcStaffProgress(newStaffId);
    assert.equal(localProg.completed, 21);
    assert.equal(localProg.total, 21);
    assert.equal(localProg.percent, 100);

    // Total queue has 1 staff_save + 21 evaluations = 22 items
    assert.equal(adv5F.syncQueue.length, 22);
    assert.equal(adv5F.syncStatus, "local_safe");

    // 4. Reconnect to network and auto-flush
    await adv5F.setOnline(true);
    assert.equal(adv5F.syncStatus, "synced");
    assert.equal(adv5F.syncQueue.length, 0);

    // 5. Verify D1 database state
    const staffRow = await d1.prepare("SELECT name, floor FROM staff WHERE id = ?").bind(newStaffId).first();
    assert.ok(staffRow);
    assert.equal(staffRow.name, "新人介護職員 佐藤");
    assert.equal(staffRow.floor, "5F");

    const evalCount = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = ?").bind(newStaffId).first("c");
    assert.equal(evalCount, 21);

    // 6. Another device on 5F fetches bootstrap and confirms 佐藤 at 100%
    const peerTablet = createSimulatedClient(env, { name: "5F_Peer_Tablet", online: true });
    await peerTablet.fetchBootstrap();
    const peerProg = peerTablet.calcStaffProgress(newStaffId);
    assert.equal(peerProg.percent, 100);
  });

  // =========================================================================
  // Scenario 5: Large batch synchronization recovery with network flapping
  // =========================================================================
  it("Scenario 5: Large batch synchronization recovery with network flapping across 4 floors", async () => {
    const rovingAdvisor = createSimulatedClient(env, { name: "Roving_Advisor", online: false });
    const master = getTechnicalSheetMaster();

    // 1. Advisor accumulates 42 evaluations across 2 staff members while offline
    const staffList = ["staff_2f_01", "staff_3f_01"];
    staffList.forEach((sId) => {
      master.forEach((cat) => {
        cat.subcategories.forEach((sub) => {
          sub.mid_items.forEach((mid) => {
            rovingAdvisor.saveEvaluation(sId, mid.id, {
              score: "A",
              check_eval: "circle",
              memo: `${sId} - ${mid.id} 評価完了`,
            });
          });
        });
      });
    });
    assert.equal(rovingAdvisor.syncQueue.length, 42);
    assert.equal(rovingAdvisor.syncStatus, "local_safe");

    // 2. Advisor walks past weak WiFi zone: connection connects, fails with 504 Gateway Timeout
    rovingAdvisor.online = true;
    rovingAdvisor.fetch = async () => ({ status: 504, ok: false, json: async () => ({ error: "Gateway Timeout" }) });
    const flush1 = await rovingAdvisor.flushSyncQueue();
    assert.equal(flush1, false);
    assert.equal(rovingAdvisor.syncStatus, "error");
    assert.equal(rovingAdvisor.syncQueue.length, 42); // 0 data lost!
    assert.equal(rovingAdvisor.backoffFailures, 1);

    // 3. Advisor reaches central office with strong WiFi
    // Restore legitimate fetch handler
    rovingAdvisor.fetch = createSimulatedClient(env).fetch.bind(rovingAdvisor);

    // 4. Click-to-Retry manual sync or reconnection trigger
    const recovered = await rovingAdvisor.retrySyncManual();
    assert.equal(recovered, true);
    assert.equal(rovingAdvisor.syncStatus, "synced");
    assert.equal(rovingAdvisor.syncQueue.length, 0);

    // 5. Verify D1 database integrity
    const dbCount1 = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_2f_01'").first("c");
    const dbCount2 = await d1.prepare("SELECT count(*) as c FROM evaluations WHERE staff_id = 'staff_3f_01'").first("c");
    assert.equal(dbCount1, 21);
    assert.equal(dbCount2, 21);

    const totalCount = await d1.prepare("SELECT count(*) as c FROM evaluations").first("c");
    assert.equal(totalCount, 42);
  });
});
