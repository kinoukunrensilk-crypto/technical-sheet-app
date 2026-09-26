/**
 * test/challenger_m1_2_edge.test.mjs
 * Adversarial Edge Case Verification Suite for Milestone 1 (src/index.js).
 * Challenger 2 (Edge Case Explorer) empirical testing harness.
 *
 * Tests edge cases:
 * - Empty batches, degenerated bodies, missing fields
 * - Batch sizes near and at Cloudflare D1 limit (1, 89, 127, 128, 129, 200)
 * - Large payloads (10KB - 100KB strings, deeply nested JSON, 175 sub-checks)
 * - Malformed JSON, non-JSON bodies, type anomalies
 * - Unexpected fields, prototype pollution, SQL injection vectors
 * - Timestamp formatting, ISO 8601 UTC string comparison nuances
 * - Staff and advisor boundary inputs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createMockD1,
  createWorkerEnv,
  callWorker,
} from "./d1_mock.mjs";

describe("Challenger 2: Adversarial Edge Cases for Milestone 1 (src/index.js)", () => {
  let d1;
  let env;

  beforeEach(() => {
    d1 = createMockD1();
    env = createWorkerEnv(d1);
  });

  // =========================================================================
  // 1. Empty and Degenerate Batches
  // =========================================================================
  describe("1. Empty and Degenerate Batches", () => {
    it("EDGE-01: Empty items array { items: [] } returns 200, count: 0, updated: 0", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 0);
      assert.equal(res.json.updated, 0);
      assert.ok(typeof res.json.serverTime === "string");
      assert.ok(!isNaN(Date.parse(res.json.serverTime)));
    });

    it("EDGE-02: Top-level empty array [] returns 200, count: 0, updated: 0", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", []);
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 0);
      assert.equal(res.json.updated, 0);
      assert.ok(typeof res.json.serverTime === "string");
    });

    it("EDGE-03: Null body JSON ('null') handled gracefully without unhandled exception", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", "null");
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 0);
      assert.equal(res.json.updated, 0);
    });

    it("EDGE-04: Empty object body {} fails gracefully without crashing worker process", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {});
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(typeof res.json.error === "string");
      assert.ok(res.json.error.includes("SQLite parameter") || res.json.error.includes("cannot be bound"));
    });

    it("EDGE-05: Single evaluation item passed directly as root object (non-array body)", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        staff_id: "staff_2f_01",
        item_id: "item_001",
        check_eval: "circle",
        score: "A",
        memo: "Direct root object",
        updated_at: new Date().toISOString(),
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 1);
      assert.equal(res.json.updated, 1);

      const row = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "item_001")
        .first();
      assert.ok(row);
      assert.equal(row.memo, "Direct root object");
    });
  });

  // =========================================================================
  // 2. Batch Size Boundaries (Near 128 Statement Limit)
  // =========================================================================
  describe("2. Batch Size Boundaries (Near 128 Limit)", () => {
    it("EDGE-06: Full technical sheet batch (89 items for single staff) succeeds completely", async () => {
      const now = new Date().toISOString();
      const items = [];
      for (let i = 1; i <= 89; i++) {
        items.push({
          staff_id: "staff_2f_01",
          item_id: `item_${String(i).padStart(3, "0")}`,
          check_eval: i % 2 === 0 ? "circle" : "cross",
          score: ["A", "B", "C"][i % 3],
          memo: `89-item batch checkpoint #${i}`,
          updated_at: now,
        });
      }

      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 89);
      assert.equal(res.json.updated, 89);

      const countRow = await d1
        .prepare("SELECT COUNT(*) as cnt FROM evaluations WHERE staff_id = ?")
        .bind("staff_2f_01")
        .first();
      assert.equal(countRow.cnt, 89);
    });

    it("EDGE-07: Boundary 127 items (1 below D1 statement limit) succeeds completely", async () => {
      const now = new Date().toISOString();
      const items = [];
      for (let i = 1; i <= 127; i++) {
        items.push({
          staff_id: "staff_2f_01",
          item_id: `b127_item_${i}`,
          check_eval: "circle",
          score: "B",
          memo: `Boundary 127 item ${i}`,
          updated_at: now,
        });
      }

      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 127);
      assert.equal(res.json.updated, 127);
    });

    it("EDGE-08: Boundary 128 items (exact D1 statement limit) succeeds completely", async () => {
      const now = new Date().toISOString();
      const items = [];
      for (let i = 1; i <= 128; i++) {
        items.push({
          staff_id: "staff_2f_01",
          item_id: `b128_item_${i}`,
          check_eval: "circle",
          score: "A",
          memo: `Boundary 128 item ${i}`,
          updated_at: now,
        });
      }

      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 128);
      assert.equal(res.json.updated, 128);
    });

    it("EDGE-09: Over-limit batch (129 items) behavior analysis", async () => {
      const now = new Date().toISOString();
      const items = [];
      for (let i = 1; i <= 129; i++) {
        items.push({
          staff_id: "staff_2f_01",
          item_id: `b129_item_${i}`,
          check_eval: "circle",
          score: "A",
          memo: `Boundary 129 item ${i}`,
          updated_at: now,
        });
      }

      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      // In d1_mock (DatabaseSync), batch has no artificial 128 cap, so it processes 129
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 129);
      assert.equal(res.json.updated, 129);
    });

    it("EDGE-10: Large batch across multiple staff (200 items)", async () => {
      const now = new Date().toISOString();
      const items = [];
      // 100 for staff_2f_01, 100 for staff_2f_02
      for (let i = 1; i <= 100; i++) {
        items.push({
          staff_id: "staff_2f_01",
          item_id: `multi_01_${i}`,
          score: "A",
          updated_at: now,
        });
        items.push({
          staff_id: "staff_2f_02",
          item_id: `multi_02_${i}`,
          score: "B",
          updated_at: now,
        });
      }

      const res = await callWorker(env, "POST", "/api/evaluations/sync", { items });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 200);
      assert.equal(res.json.updated, 200);
    });
  });

  // =========================================================================
  // 3. Large Payloads & Data Extremes
  // =========================================================================
  describe("3. Large Payloads & Data Extremes", () => {
    it("EDGE-11: Large memo (10,000 characters multibyte Japanese) persists accurately", async () => {
      const sampleText = "特養介護における自立支援と安全配慮の実践。車椅子移乗時の足引き確認および見守り体制の強化。";
      const hugeMemo = sampleText.repeat(200); // ~10,000 chars
      const now = new Date().toISOString();

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "huge_memo_test",
            score: "A",
            memo: hugeMemo,
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);

      const row = await d1
        .prepare("SELECT memo FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "huge_memo_test")
        .first();
      assert.equal(row.memo.length, hugeMemo.length);
      assert.equal(row.memo, hugeMemo);
    });

    it("EDGE-12: Special characters, emojis, newlines, and quotes in memo", async () => {
      const complexMemo = `【特記事項】\r\n・車椅子♿️＆歩行器🚶‍♂️の併用指導を実施🌟\n・"クォート"と'シングルクォート'、<script>タグの混在テスト\n・\\エスケープ文字\\とタブ\tを含む行\n・外字・異体字：髙橋・﨑山・𠮷野`;
      const now = new Date().toISOString();

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "complex_memo_test",
            memo: complexMemo,
            evaluator_name: "担当アドバイザー 👨‍⚕️",
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);

      const row = await d1
        .prepare("SELECT memo, evaluator_name FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "complex_memo_test")
        .first();
      assert.equal(row.memo, complexMemo);
      assert.equal(row.evaluator_name, "担当アドバイザー 👨‍⚕️");
    });

    it("EDGE-13: checks_json with 175 boolean sub-checks persists and retrieves correctly", async () => {
      const subChecks = Array.from({ length: 175 }, (_, i) => i % 2 === 0);
      const now = new Date().toISOString();

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "subchecks_175_test",
            checks_json: subChecks,
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);

      const row = await d1
        .prepare("SELECT checks_json FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "subchecks_175_test")
        .first();
      const parsed = JSON.parse(row.checks_json);
      assert.equal(parsed.length, 175);
      assert.deepEqual(parsed, subChecks);
    });

    it("EDGE-14: checks_json formats (already stringified vs object vs null)", async () => {
      const now = new Date().toISOString();
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "fmt_str",
            checks_json: '["already", "stringified"]',
            updated_at: now,
          },
          {
            staff_id: "staff_2f_01",
            item_id: "fmt_obj",
            checks_json: { nested: { a: 1, b: "hello" } },
            updated_at: now,
          },
          {
            staff_id: "staff_2f_01",
            item_id: "fmt_null",
            checks_json: null,
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.updated, 3);

      const rows = (
        await d1
          .prepare("SELECT item_id, checks_json FROM evaluations WHERE staff_id = ? AND item_id LIKE 'fmt_%'")
          .bind("staff_2f_01")
          .all()
      ).results;

      const map = Object.fromEntries(rows.map((r) => [r.item_id, r.checks_json]));
      assert.equal(map.fmt_str, '["already", "stringified"]');
      assert.equal(map.fmt_obj, JSON.stringify({ nested: { a: 1, b: "hello" } }));
      assert.equal(map.fmt_null, "[]");
    });
  });

  // =========================================================================
  // 4. Malformed JSON, Non-JSON Bodies, and Type Anomalies
  // =========================================================================
  describe("4. Malformed JSON, Non-JSON Bodies, and Type Anomalies", () => {
    it("EDGE-15: Malformed JSON syntax in sync request returns 500 JSON error without crashing worker", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", "{items: [broken json");
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(typeof res.json.error === "string");
    });

    it("EDGE-16: Primitive string JSON payload returns 500 JSON error without crashing worker", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", JSON.stringify("unexpected string"));
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(typeof res.json.error === "string");
    });

    it("EDGE-17: Primitive number JSON payload returns 500 JSON error without crashing worker", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", JSON.stringify(12345));
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(typeof res.json.error === "string");
    });

    it("EDGE-18: Batch with null element caught gracefully by Worker error handler", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [null],
      });
      // In JS, destructuring null throws TypeError, which Worker try/catch catches and returns 500 JSON
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(res.json.error.includes("null") || res.json.error.includes("destructure"));
    });

    it("EDGE-19: Evaluation item with null item_id fails with NOT NULL constraint error gracefully", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: null,
            score: "A",
          },
        ],
      });
      // SQLite NOT NULL constraint on evaluations.item_id triggers catch block
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(res.json.error.includes("NOT NULL") || res.json.error.includes("constraint failed"));
    });

    it("EDGE-20: Evaluation item with null staff_id safely skipped by WHERE EXISTS clause", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: null,
            item_id: "item_001",
            score: "A",
          },
        ],
      });
      // WHERE EXISTS (SELECT 1 FROM staff WHERE id = NULL) evaluates to FALSE
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.count, 1);
      assert.equal(res.json.updated, 0);
    });

    it("EDGE-20B: Evaluation item with undefined property caught by parameter binding error handler", async () => {
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            // missing staff_id (undefined)
            item_id: "item_001",
            score: "A",
          },
        ],
      });
      assert.equal(res.status, 500);
      assert.equal(res.json.success, false);
      assert.ok(res.json.error.includes("SQLite parameter") || res.json.error.includes("cannot be bound"));
    });
  });

  // =========================================================================
  // 5. Unexpected Fields & Injection Vectors
  // =========================================================================
  describe("5. Unexpected Fields & Injection Vectors", () => {
    it("EDGE-21: Prototype pollution attempts (__proto__, constructor) are safely neutralized", async () => {
      const maliciousPayload = JSON.parse(
        '{"__proto__":{"isAdmin":true},"items":[{"staff_id":"staff_2f_01","item_id":"item_proto","constructor":{"prototype":{"polluted":true}},"score":"A"}]}'
      );
      const res = await callWorker(env, "POST", "/api/evaluations/sync", maliciousPayload);
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(Object.prototype.isAdmin, undefined);
      assert.equal(Object.prototype.polluted, undefined);
    });

    it("EDGE-22: Extraneous unexpected columns/properties do not break insertion", async () => {
      const now = new Date().toISOString();
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "item_extra_props",
            score: "B",
            unknown_column_1: "hacker_value",
            admin_privileges: 999,
            sql_debug: "DROP TABLE staff",
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.updated, 1);

      const row = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "item_extra_props")
        .first();
      assert.equal(row.score, "B");
    });

    it("EDGE-23: SQL Injection in item_id parameter binding is safely treated as literal text", async () => {
      const sqlInjectionItemId = "item_01'; DROP TABLE evaluations; --";
      const now = new Date().toISOString();

      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: sqlInjectionItemId,
            score: "C",
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);

      // Verify table still exists and record was stored with exact literal text
      const row = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", sqlInjectionItemId)
        .first();
      assert.ok(row);
      assert.equal(row.item_id, sqlInjectionItemId);
    });

    it("EDGE-24: SQL Injection in staff_id parameter binding is safely neutralized", async () => {
      const sqlInjectionStaffId = "staff_2f_01' OR '1'='1";
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: sqlInjectionStaffId,
            item_id: "item_001",
            score: "A",
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      // Because staff with ID "staff_2f_01' OR '1'='1" does not exist, WHERE EXISTS returns 0 rows
      assert.equal(res.json.updated, 0);
    });

    it("EDGE-25: SQL Injection in DELETE /api/staff/:id path is safely parameterized", async () => {
      const maliciousId = "staff_2f_01' OR '1'='1";
      const res = await callWorker(env, "DELETE", `/api/staff/${encodeURIComponent(maliciousId)}`);
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.deletedId, maliciousId);

      // Verify real staff_2f_01 was NOT deleted
      const realStaff = await d1
        .prepare("SELECT * FROM staff WHERE id = 'staff_2f_01'")
        .first();
      assert.ok(realStaff, "Real staff must NOT be deleted by SQL injection payload");
    });
  });

  // =========================================================================
  // 6. Timestamps, Dates, and LWW Edge Cases
  // =========================================================================
  describe("6. Timestamps, Dates, and LWW Edge Cases", () => {
    it("EDGE-26: Microsecond precision ISO timestamps compare correctly in LWW", async () => {
      const t1 = "2026-09-26T12:00:00.100000Z";
      const t2 = "2026-09-26T12:00:00.200000Z";
      const t3_stale = "2026-09-26T12:00:00.150000Z";

      // Insert t1
      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "ts_precision", score: "C", updated_at: t1 }],
      });

      // Update with t2 (newer)
      const resNewer = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "ts_precision", score: "A", updated_at: t2 }],
      });
      assert.equal(resNewer.json.updated, 1);

      // Attempt update with t3_stale (older than t2)
      const resStale = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "ts_precision", score: "B", updated_at: t3_stale }],
      });
      assert.equal(resStale.json.updated, 0);

      const row = await d1
        .prepare("SELECT score, updated_at FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "ts_precision")
        .first();
      assert.equal(row.score, "A");
      assert.equal(row.updated_at, t2);
    });

    it("EDGE-27: Far past timestamp (epoch 1970) rejected by LWW when existing record has current timestamp", async () => {
      const current = new Date().toISOString();
      const past = "1970-01-01T00:00:00.000Z";

      await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "epoch_test", score: "A", updated_at: current }],
      });

      const resStale = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [{ staff_id: "staff_2f_01", item_id: "epoch_test", score: "C", updated_at: past }],
      });
      assert.equal(resStale.json.updated, 0);

      const row = await d1
        .prepare("SELECT score FROM evaluations WHERE staff_id = ? AND item_id = ?")
        .bind("staff_2f_01", "epoch_test")
        .first();
      assert.equal(row.score, "A");
    });

    it("EDGE-28: Varied evaluation_date representations (YYYY-MM-DD, JP era, empty)", async () => {
      const now = new Date().toISOString();
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "d_iso",
            evaluation_date: "2026-09-26",
            updated_at: now,
          },
          {
            staff_id: "staff_2f_01",
            item_id: "d_jp",
            evaluation_date: "令和8年9月26日",
            updated_at: now,
          },
          {
            staff_id: "staff_2f_01",
            item_id: "d_empty",
            evaluation_date: "",
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.updated, 3);
    });
  });

  // =========================================================================
  // 7. Staff and Advisors API Edge Cases
  // =========================================================================
  describe("7. Staff and Advisors API Edge Cases", () => {
    it("EDGE-29: POST /api/staff with missing required fields returns 400", async () => {
      const resNoName = await callWorker(env, "POST", "/api/staff", { id: "s1", floor: "2F" });
      assert.equal(resNoName.status, 400);
      assert.equal(resNoName.json.success, false);

      const resNoFloor = await callWorker(env, "POST", "/api/staff", { id: "s1", name: "テスト" });
      assert.equal(resNoFloor.status, 400);

      const resNoId = await callWorker(env, "POST", "/api/staff", { floor: "2F", name: "テスト" });
      assert.equal(resNoId.status, 400);
    });

    it("EDGE-30: POST /api/staff handles negative and string order_num cleanly", async () => {
      const res = await callWorker(env, "POST", "/api/staff", {
        id: "staff_neg_order",
        floor: "3F",
        name: "順序番号テスト",
        order_num: -5,
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);

      const row = await d1
        .prepare("SELECT * FROM staff WHERE id = 'staff_neg_order'")
        .first();
      assert.equal(row.order_num, -5);
    });

    it("EDGE-31: DELETE /api/staff/:id with non-existent ID returns 200 idempotently", async () => {
      const res = await callWorker(env, "DELETE", "/api/staff/nonexistent_staff_999");
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.deletedId, "nonexistent_staff_999");
    });

    it("EDGE-32: DELETE /api/staff/:id with Japanese characters and URL encoding", async () => {
      // First create a staff with Japanese ID
      await callWorker(env, "POST", "/api/staff", {
        id: "staff_山田太郎",
        floor: "2F",
        name: "山田 太郎",
      });

      // Delete using URL encoded path
      const res = await callWorker(
        env,
        "DELETE",
        `/api/staff/${encodeURIComponent("staff_山田太郎")}`
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.deletedId, "staff_山田太郎");

      const check = await d1
        .prepare("SELECT * FROM staff WHERE id = 'staff_山田太郎'")
        .first();
      assert.equal(check, null);
    });

    it("EDGE-33: POST /api/advisors with missing floor or advisor_name validation", async () => {
      const resNoFloor = await callWorker(env, "POST", "/api/advisors", { advisor_name: "佐藤" });
      assert.equal(resNoFloor.status, 400);

      const resNoAdvisor = await callWorker(env, "POST", "/api/advisors", { floor: "2F" });
      assert.equal(resNoAdvisor.status, 400);

      // Empty string is allowed
      const resEmptyAdvisor = await callWorker(env, "POST", "/api/advisors", {
        floor: "2F",
        advisor_name: "",
      });
      assert.equal(resEmptyAdvisor.status, 200);
      assert.equal(resEmptyAdvisor.json.success, true);
      assert.equal(resEmptyAdvisor.json.advisor.advisor_name, "");
    });

    it("EDGE-34: GET /api/bootstrap handles empty database cleanly", async () => {
      // Delete all staff, advisors, evaluations
      await d1.prepare("DELETE FROM evaluations").run();
      await d1.prepare("DELETE FROM staff").run();
      await d1.prepare("DELETE FROM advisors").run();

      const res = await callWorker(env, "GET", "/api/bootstrap");
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.deepEqual(res.json.staff, []);
      assert.deepEqual(res.json.advisors, []);
      assert.deepEqual(res.json.evaluations, []);
      assert.ok(typeof res.json.serverTime === "string");
    });
  });

  // =========================================================================
  // 8. Advanced Stress & Adversarial Challenges
  // =========================================================================
  describe("8. Advanced Stress & Adversarial Challenges", () => {
    it("EDGE-35: Simulating strict Cloudflare D1 128 statement limit on batch API", async () => {
      // Simulate D1 runtime throwing when statements > 128
      const d1Strict = createMockD1();
      const originalBatch = d1Strict.batch.bind(d1Strict);
      d1Strict.batch = async (statements) => {
        if (statements.length > 128) {
          throw new Error("D1_ERROR: Batch too large: batch statements count cannot exceed 128");
        }
        return originalBatch(statements);
      };
      const strictEnv = createWorkerEnv(d1Strict);

      // Batch with 128 statements -> must succeed
      const batch128 = Array.from({ length: 128 }, (_, i) => ({
        staff_id: "staff_2f_01",
        item_id: `strict_item_${i}`,
        score: "A",
      }));
      const res128 = await callWorker(strictEnv, "POST", "/api/evaluations/sync", { items: batch128 });
      assert.equal(res128.status, 200);
      assert.equal(res128.json.success, true);
      assert.equal(res128.json.count, 128);

      // Batch with 129 statements -> throws D1 limit, caught by Worker error handler returning 500
      const batch129 = Array.from({ length: 129 }, (_, i) => ({
        staff_id: "staff_2f_01",
        item_id: `strict_item_129_${i}`,
        score: "B",
      }));
      const res129 = await callWorker(strictEnv, "POST", "/api/evaluations/sync", { items: batch129 });
      assert.equal(res129.status, 500);
      assert.equal(res129.json.success, false);
      assert.ok(res129.json.error.includes("Batch too large") || res129.json.error.includes("128"));
    });

    it("EDGE-36: Stale staff POST preserves winning DB values despite response echo", async () => {
      const now = new Date().toISOString();
      const olderTime = new Date(Date.now() - 3600000).toISOString();

      // First create winning staff
      await callWorker(env, "POST", "/api/staff", {
        id: "staff_lww_verify",
        floor: "2F",
        name: "最新の氏名",
        role: "leader",
        updated_at: now,
      });

      // Attempt to overwrite with older timestamp
      const staleRes = await callWorker(env, "POST", "/api/staff", {
        id: "staff_lww_verify",
        floor: "3F",
        name: "古い氏名（先祖返り試行）",
        role: "general",
        updated_at: olderTime,
      });
      assert.equal(staleRes.status, 200);

      // Verify the database preserved the newer data
      const dbRow = await d1
        .prepare("SELECT * FROM staff WHERE id = 'staff_lww_verify'")
        .first();
      assert.equal(dbRow.name, "最新の氏名");
      assert.equal(dbRow.floor, "2F");
      assert.equal(dbRow.role, "leader");
      assert.equal(dbRow.updated_at, now);
    });

    it("EDGE-37: Stale advisor POST preserves winning DB values despite response echo", async () => {
      const now = new Date().toISOString();
      const olderTime = new Date(Date.now() - 3600000).toISOString();

      // Initial advisor
      await callWorker(env, "POST", "/api/advisors", {
        floor: "4F",
        advisor_name: "新アドバイザー",
        updated_at: now,
      });

      // Stale update
      await callWorker(env, "POST", "/api/advisors", {
        floor: "4F",
        advisor_name: "旧アドバイザー（先祖返り試行）",
        updated_at: olderTime,
      });

      const dbRow = await d1
        .prepare("SELECT * FROM advisors WHERE floor = '4F'")
        .first();
      assert.equal(dbRow.advisor_name, "新アドバイザー");
      assert.equal(dbRow.updated_at, now);
    });

    it("EDGE-38: High-concurrency rapid sync interleaving LWW timestamps", async () => {
      const baseTime = Date.now();
      const promises = [];

      for (let i = 0; i < 20; i++) {
        const itemTime = new Date(baseTime + (i % 2 === 0 ? i * 1000 : -i * 1000)).toISOString();
        promises.push(
          callWorker(env, "POST", "/api/evaluations/sync", {
            items: [
              {
                staff_id: "staff_2f_01",
                item_id: "rapid_lww_race",
                score: `SCORE_${i}`,
                memo: `Edit #${i} at ${itemTime}`,
                updated_at: itemTime,
              },
            ],
          })
        );
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.equal(res.status, 200);
        assert.equal(res.json.success, true);
      }

      // The winner must be the highest timestamp (i = 18 -> baseTime + 18000ms)
      const expectedWinningTime = new Date(baseTime + 18000).toISOString();
      const finalRow = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'rapid_lww_race'")
        .first();
      assert.ok(finalRow);
      assert.equal(finalRow.score, "SCORE_18");
      assert.equal(finalRow.updated_at, expectedWinningTime);
    });

    it("EDGE-39: Zero-character values (empty strings) in text fields preserve cleanly", async () => {
      const now = new Date().toISOString();
      const res = await callWorker(env, "POST", "/api/evaluations/sync", {
        items: [
          {
            staff_id: "staff_2f_01",
            item_id: "empty_text_fields",
            check_eval: "",
            score: "",
            memo: "",
            evaluator_name: "",
            evaluation_date: "",
            checks_json: "[]",
            updated_at: now,
          },
        ],
      });
      assert.equal(res.status, 200);
      assert.equal(res.json.success, true);
      assert.equal(res.json.updated, 1);

      const row = await d1
        .prepare("SELECT * FROM evaluations WHERE staff_id = 'staff_2f_01' AND item_id = 'empty_text_fields'")
        .first();
      assert.equal(row.check_eval, "");
      assert.equal(row.score, "");
      assert.equal(row.memo, "");
      assert.equal(row.evaluator_name, "");
      assert.equal(row.evaluation_date, "");
      assert.equal(row.checks_json, "[]");
    });

    it("EDGE-40: Non-standard Japanese floor names in staff and advisors", async () => {
      // Create staff on "デイサービス" floor
      const resStaff = await callWorker(env, "POST", "/api/staff", {
        id: "staff_day_01",
        floor: "デイサービス",
        name: "デイ 職員1",
      });
      assert.equal(resStaff.status, 200);

      // Create advisor for "デイサービス"
      const resAdvisor = await callWorker(env, "POST", "/api/advisors", {
        floor: "デイサービス",
        advisor_name: "通所リーダー",
      });
      assert.equal(resAdvisor.status, 200);

      // Verify in bootstrap
      const resBootstrap = await callWorker(env, "GET", "/api/bootstrap");
      assert.equal(resBootstrap.status, 200);
      assert.ok(resBootstrap.json.staff.some((s) => s.floor === "デイサービス"));
      assert.ok(resBootstrap.json.advisors.some((a) => a.floor === "デイサービス"));
    });
  });
});

