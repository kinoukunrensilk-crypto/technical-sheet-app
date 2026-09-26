/**
 * test/tier5_adversarial.test.mjs
 * Tier 5: Adversarial SQL/D1 Challenge Suite for Milestone 1
 * 
 * Tests:
 * 1. Concurrency & High Volume Races
 * 2. Deletions Mid-Sync & Orphan Prevention
 * 3. Foreign Key Boundaries & Malformed Payloads
 * 4. LWW Conflict Resolution Precision & Edge Cases
 * 
 * Uses node:test and node:assert/strict with zero external npm dependencies.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createMockD1,
  createWorkerEnv,
  callWorker,
} from "./d1_mock.mjs";

describe("Tier 5: Adversarial SQL/D1 Challenge Suite (Milestone 1)", () => {
  let d1;
  let env;

  beforeEach(() => {
    d1 = createMockD1();
    env = createWorkerEnv(d1);
  });

  // =========================================================================
  // 1. Concurrency & High Volume Races
  // =========================================================================
  describe("1. Concurrency & High-Volume Races", () => {
    it("ADV-C01: 10 parallel batch syncs across different staff members all succeed with zero collision", async () => {
      const staffIds = [
        "staff_2f_01", "staff_2f_02",
        "staff_3f_01", "staff_3f_02",
        "staff_4f_01", "staff_4f_02",
        "staff_5f_01", "staff_5f_02",
      ];

      const syncTasks = staffIds.map((id, index) => {
        const items = [
          {
            staff_id: id,
            item_id: "item_001",
            score: "A",
            check_eval: "circle",
            memo: `Parallel test for ${id}`,
            updated_at: new Date(Date.now() + index * 1000).toISOString(),
          },
          {
            staff_id: id,
            item_id: "item_002",
            score: "B",
            check_eval: "cross",
            memo: `Second item for ${id}`,
            updated_at: new Date(Date.now() + index * 1000).toISOString(),
          },
        ];
        return callWorker(env, "POST", "/api/evaluations/sync", { items });
      });

      const results = await Promise.all(syncTasks);

      for (const res of results) {
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        assert.equal(res.json.count, 2);
        assert.equal(res.json.updated, 2);
      }

      // Verify all 16 rows were persisted in the database
      const rowCount = await d1
        .prepare("SELECT COUNT(*) as cnt FROM evaluations")
        .first("cnt");
      assert.equal(rowCount, 16);
    });

    it("ADV-C02: 10 concurrent writes to the EXACT SAME staff and item converge strictly to highest timestamp (LWW Race)", async () => {
      const baseTime = Date.parse("2026-09-26T12:00:00.000Z");
      const scores = ["A", "B", "C", "A", "B", "C", "A", "B", "C", "A"];
      const times = [
        baseTime + 10000, // 10s
        baseTime + 5000,  // 5s
        baseTime + 90000, // 90s -> HIGHEST (Winner!)
        baseTime + 2000,  // 2s
        baseTime + 30000, // 30s
        baseTime + 15000, // 15s
        baseTime + 80000, // 80s
        baseTime + 45000, // 45s
        baseTime + 7000,  // 7s
        baseTime + 60000, // 60s
      ];

      const expectedWinningIndex = 2; // 90s has score "C"
      const expectedWinningScore = scores[expectedWinningIndex];
      const expectedWinningTime = new Date(times[expectedWinningIndex]).toISOString();

      const requests = times.map((t, idx) => {
        return callWorker(env, "POST", "/api/evaluations/sync", {
          items: [
            {
              staff_id: "staff_2f_01",
              item_id: "item_005",
              score: scores[idx],
              memo: `Race worker ${idx}`,
              updated_at: new Date(t).toISOString(),
            },
          ],
        });
      });

      const responses = await Promise.all(requests);
      for (const res of responses) {
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
      }

      const finalRow = await d1
        .prepare("SELECT score, memo, updated_at FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_005'")
        .first();

      assert.ok(finalRow, "Row must exist");
      assert.equal(finalRow.score, expectedWinningScore, `Winner must be score ${expectedWinningScore}`);
      assert.equal(finalRow.updated_at, expectedWinningTime, `Winner timestamp must match highest timestamp`);
    });

    it("ADV-C03: Concurrent bootstrap read during heavy evaluation writes executes cleanly without lock aborts", async () => {
      // Launch 5 batch sync writes and 5 bootstrap reads concurrently
      const writes = Array.from({ length: 5 }).map((_, i) =>
        callWorker(env, "POST", "/api/evaluations/sync", {
          items: [
            {
              staff_id: "staff_3f_01",
              item_id: `item_0${10 + i}`,
              score: "A",
              updated_at: new Date().toISOString(),
            },
          ],
        })
      );

      const reads = Array.from({ length: 5 }).map(() =>
        callWorker(env, "GET", "/api/bootstrap")
      );

      const [writeResults, readResults] = await Promise.all([
        Promise.all(writes),
        Promise.all(reads),
      ]);

      for (const res of writeResults) {
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
      }

      for (const res of readResults) {
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
        assert.ok(Array.isArray(res.json.staff));
        assert.ok(Array.isArray(res.json.evaluations));
        assert.ok(res.json.serverTime);
      }
    });
  });

  // =========================================================================
  // 2. Deletions Mid-Sync & Orphan Prevention
  // =========================================================================
  describe("2. Deletions Mid-Sync & Orphan Prevention", () => {
    it("ADV-D01: Evaluations for deleted staff are ignored and never cause SQLITE_CONSTRAINT_FOREIGNKEY", async () => {
      // Staff staff_4f_01 is deleted
      const delRes = await callWorker(env, "DELETE", "/api/staff/staff_4f_01");
      assert.equal(delRes.status, 200);

      // Now a delayed offline client flushes 3 evaluations for that deleted staff
      const syncRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_4f_01", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
          { staff_id: "staff_4f_01", item_id: "item_002", score: "B", updated_at: new Date().toISOString() },
          { staff_id: "staff_4f_01", item_id: "item_003", score: "C", updated_at: new Date().toISOString() },
        ],
      });

      assert.equal(syncRes.status, 200);
      assert.equal(syncRes.json.success, true);
      assert.equal(syncRes.json.count, 3);
      assert.equal(syncRes.json.updated, 0); // 0 rows updated/inserted!

      // Confirm no orphan records exist
      const orphans = await d1
        .prepare("SELECT COUNT(*) as cnt FROM evaluations WHERE staff_id = 'staff_4f_01'")
        .first("cnt");
      assert.equal(orphans, 0);
    });

    it("ADV-D02: Interleaved batch with valid staff and deleted staff isolates failures gracefully", async () => {
      // staff_5f_01 exists, ghost_staff_99 does NOT exist
      const syncRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_5f_01", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
          { staff_id: "ghost_staff_99", item_id: "item_001", score: "B", updated_at: new Date().toISOString() },
          { staff_id: "staff_5f_01", item_id: "item_002", score: "C", updated_at: new Date().toISOString() },
          { staff_id: "ghost_staff_88", item_id: "item_002", score: "A", updated_at: new Date().toISOString() },
        ],
      });

      assert.equal(syncRes.status, 200);
      assert.equal(syncRes.json.success, true);
      assert.equal(syncRes.json.count, 4);
      assert.equal(syncRes.json.updated, 2); // Only the 2 valid items for staff_5f_01

      // Verify the 2 valid items were inserted
      const validItems = await d1
        .prepare("SELECT item_id, score FROM evaluations WHERE staff_id = 'staff_5f_01' ORDER BY item_id")
        .all();
      assert.equal(validItems.results.length, 2);
      assert.equal(validItems.results[0].score, "A");
      assert.equal(validItems.results[1].score, "C");

      // Verify ghost staff rows were not created
      const ghostCount = await d1
        .prepare("SELECT COUNT(*) as cnt FROM evaluations WHERE staff_id LIKE 'ghost_%'")
        .first("cnt");
      assert.equal(ghostCount, 0);
    });

    it("ADV-D03: Concurrent DELETE /api/staff and POST /api/evaluations/sync leaves zero orphan evaluations", async () => {
      // First populate some evaluations for staff_2f_02
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_2f_02", item_id: "item_001", score: "A", updated_at: "2026-09-26T10:00:00.000Z" },
        ],
      });

      // Fire concurrent delete and sync
      const [delRes, syncRes] = await Promise.all([
        callWorker(env, "DELETE", "/api/staff/staff_2f_02"),
        callWorker(env, "POST", "/api/evaluations/sync", {
          items: [
            { staff_id: "staff_2f_02", item_id: "item_002", score: "B", updated_at: "2026-09-26T10:05:00.000Z" },
            { staff_id: "staff_2f_02", item_id: "item_003", score: "C", updated_at: "2026-09-26T10:05:00.000Z" },
          ],
        }),
      ]);

      assert.equal(delRes.status, 200);
      assert.equal(syncRes.status, 200);

      // Regardless of which completed first, staff_2f_02 MUST have 0 evaluations and 0 staff records in DB
      const staffExists = await d1
        .prepare("SELECT * FROM staff WHERE id = 'staff_2f_02'")
        .first();
      assert.equal(staffExists, null);

      const evalsCount = await d1
        .prepare("SELECT COUNT(*) as cnt FROM evaluations WHERE staff_id = 'staff_2f_02'")
        .first("cnt");
      assert.equal(evalsCount, 0, "No orphan evaluations can remain for deleted staff");
    });
  });

  // =========================================================================
  // 3. Foreign Key Boundaries & Malformed / Boundary Payloads
  // =========================================================================
  describe("3. Foreign Key Boundaries & Malformed Payloads", () => {
    it("ADV-B01: Empty string staff_id is treated as nonexistent and rejected safely", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "", item_id: "item_001", score: "A", updated_at: new Date().toISOString() },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.updated, 0);
    });

    it("ADV-B02: SQL injection strings in staff_id and item_id are safely bound without executing", async () => {
      const maliciousStaffId = "'; DROP TABLE evaluations; --";
      const maliciousItemId = "item_001' OR '1'='1";

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: maliciousStaffId,
            item_id: maliciousItemId,
            score: "A",
            updated_at: new Date().toISOString(),
          },
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.updated, 0);

      // Verify evaluations table still exists and is untouched
      const tableCheck = await d1
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'")
        .first("name");
      assert.equal(tableCheck, "evaluations");
    });

    it("ADV-B03: Single object payload instead of array wrapped in { items } is accepted", async () => {
      // src/index.js line 191 handles body as single object
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        staff_id: "staff_2f_01",
        item_id: "item_010",
        score: "B",
        updated_at: new Date().toISOString(),
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 1);
      assert.equal(res.json.updated, 1);

      const row = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_010'")
        .first("score");
      assert.equal(row, "B");
    });

    it("ADV-B04: Empty items array returns count 0, updated 0, valid serverTime", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items: [] });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 0);
      assert.equal(res.json.updated, 0);
      assert.ok(res.json.serverTime);
    });

    it("ADV-B05: Japanese text, emojis, and JSON subchecks survive sync without corruption", async () => {
      const complexMemo = "利用者様「排泄介助支援🚽、車椅子移乗🦽良好。体温36.5℃」\n特記事項: 継続観察。";
      const checksArray = ["item_001_cp_1", "item_001_cp_2", "特記: 異常なし"];

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "item_011",
            check_eval: "circle",
            score: "A",
            checks_json: checksArray,
            memo: complexMemo,
            evaluator_name: "アドバイザー山田（介護福祉士・指導員）",
            evaluation_date: "2026-09-26",
            updated_at: new Date().toISOString(),
          },
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.updated, 1);

      const row = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_011'")
        .first();

      assert.equal(row.memo, complexMemo);
      assert.equal(row.evaluator_name, "アドバイザー山田（介護福祉士・指導員）");
      assert.equal(row.evaluation_date, "2026-09-26");
      assert.equal(row.checks_json, JSON.stringify(checksArray));
    });

    it("ADV-B06: Vulnerability Check: item with updated_at = null triggers NOT NULL failure (500)", async () => {
      // In src/index.js line 216: updated_at = now does not catch null because default destructuring only replaces undefined.
      // evaluations.updated_at is TEXT NOT NULL in schema.sql.
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "item_012",
            score: "A",
            updated_at: null, // null instead of undefined
          },
        ],
      });

      // Empirical challenger finding: Worker catches this error and returns 500
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /NOT NULL constraint failed: evaluations\.updated_at/);
    });

    it("ADV-B07: Vulnerability Check: item with missing item_id triggers SQLite bind error (500)", async () => {
      // In src/index.js, evaluations/sync does not validate that item_id is present before binding
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            score: "A",
            // missing item_id
          },
        ],
      });

      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.match(res.json.error, /Provided value cannot be bound to SQLite parameter 2/);
    });
  });

  // =========================================================================
  // 4. LWW Conflict Resolution Precision & Edge Cases
  // =========================================================================
  describe("4. LWW Conflict Resolution Precision & Edge Cases", () => {
    it("ADV-L01: Intra-batch out-of-order duplicate items resolve deterministically to latest timestamp", async () => {
      // In a single batch, item 1 is older, item 2 is newest, item 3 is intermediate
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_3f_01", item_id: "item_020", score: "A", updated_at: "2026-09-26T10:00:00.000Z" },
          { staff_id: "staff_3f_01", item_id: "item_020", score: "C", updated_at: "2026-09-26T10:10:00.000Z" }, // NEWEST WINNER
          { staff_id: "staff_3f_01", item_id: "item_020", score: "B", updated_at: "2026-09-26T10:05:00.000Z" }, // INTERMEDIATE
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.count, 3);
      assert.equal(res.json.updated, 2); // 1st inserted, 2nd updated, 3rd rejected by LWW

      const row = await d1
        .prepare("SELECT score, updated_at FROM evaluations WHERE staff_id = 'staff_3f_01' AND item_id = 'item_020'")
        .first();
      assert.equal(row.score, "C");
      assert.equal(row.updated_at, "2026-09-26T10:10:00.000Z");
    });

    it("ADV-L02: Intra-batch reverse order (newest first, older second) preserves newest data", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          { staff_id: "staff_3f_01", item_id: "item_021", score: "C", updated_at: "2026-09-26T10:10:00.000Z" }, // NEWEST WINNER
          { staff_id: "staff_3f_01", item_id: "item_021", score: "A", updated_at: "2026-09-26T10:00:00.000Z" }, // STALE
        ],
      });

      assert.equal(res.status, 200);
      assert.equal(res.json.count, 2);
      assert.equal(res.json.updated, 1); // Only 1st applied, 2nd rejected by LWW

      const row = await d1
        .prepare("SELECT score, updated_at FROM evaluations WHERE staff_id = 'staff_3f_01' AND item_id = 'item_021'")
        .first();
      assert.equal(row.score, "C");
      assert.equal(row.updated_at, "2026-09-26T10:10:00.000Z");
    });

    it("ADV-L03: Millisecond precision LWW (1ms difference) is strictly respected", async () => {
      const t1 = "2026-09-26T15:30:00.100Z";
      const t2 = "2026-09-26T15:30:00.101Z"; // 1ms newer

      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "A", updated_at: t1 }],
      });

      // Attempt older by 1ms
      const olderRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "B", updated_at: "2026-09-26T15:30:00.099Z" }],
      });
      assert.equal(olderRes.json.updated, 0);

      // Now apply newer by 1ms
      const newerRes = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "item_001", score: "C", updated_at: t2 }],
      });
      assert.equal(newerRes.json.updated, 1);

      const row = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'item_001'")
        .first("score");
      assert.equal(row, "C");
    });

    it("ADV-L04: Advisor LWW guard rejects older timestamp and accepts newer timestamp", async () => {
      // Initial advisor in schema.sql is '2F担当アドバイザー'
      // 1. Update with T = 2026-09-26T12:00:00.000Z
      await callWorker(env, "POST", "/api/advisors", {
        floor: "2F",
        advisor_name: "アドバイザー2F (最新)",
        updated_at: "2026-09-26T12:00:00.000Z",
      });

      // 2. Stale update with T = 2026-09-26T11:00:00.000Z
      const staleRes = await callWorker(env, "POST", "/api/advisors", {
        floor: "2F",
        advisor_name: "アドバイザー2F (過去・誤り)",
        updated_at: "2026-09-26T11:00:00.000Z",
      });
      assert.equal(staleRes.status, 200);

      // Database must retain the newer advisor name
      const advRow = await d1
        .prepare("SELECT advisor_name FROM advisors WHERE floor = '2F'")
        .first("advisor_name");
      assert.equal(advRow, "アドバイザー2F (最新)");
    });

    it("ADV-L05: Staff LWW guard rejects older timestamp and preserves database record", async () => {
      // 1. Update staff with T = 2026-09-26T14:00:00.000Z
      await callWorker(env, "POST", "/api/staff", {
        id: "staff_2f_01",
        floor: "2F",
        name: "介護スタッフ A (新氏名)",
        role: "general",
        order_num: 1,
        updated_at: "2026-09-26T14:00:00.000Z",
      });

      // 2. Stale update with T = 2026-09-26T13:00:00.000Z
      const staleRes = await callWorker(env, "POST", "/api/staff", {
        id: "staff_2f_01",
        floor: "2F",
        name: "介護スタッフ A (旧氏名・上書き不可)",
        role: "general",
        order_num: 1,
        updated_at: "2026-09-26T13:00:00.000Z",
      });
      assert.equal(staleRes.status, 200);

      // Database must retain the newer staff name
      const staffRow = await d1
        .prepare("SELECT name FROM staff WHERE id = 'staff_2f_01'")
        .first("name");
      assert.equal(staffRow, "介護スタッフ A (新氏名)");
    });
  });
});
