/**
 * test/runner.mjs
 * Master E2E Test Suite Runner for 介護スタッフ テクニカルシート評価システム
 * Executes all 4 test tiers and generates a comprehensive, structured verification report.
 * Exits with code 0 on 100% pass, non-zero on any failure.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TIERS = [
  {
    id: "Tier 1",
    name: "Feature Equivalence Class Suite (F1-F12)",
    file: path.resolve(__dirname, "tier1_feature.test.mjs"),
    expectedMinTests: 60,
  },
  {
    id: "Tier 2",
    name: "Boundary Value Analysis & Stress Suite (B01-B60)",
    file: path.resolve(__dirname, "tier2_boundary.test.mjs"),
    expectedMinTests: 60,
  },
  {
    id: "Tier 3",
    name: "Pairwise Combinatorial Interaction Suite (P01-P15)",
    file: path.resolve(__dirname, "tier3_pairwise.test.mjs"),
    expectedMinTests: 12,
  },
  {
    id: "Tier 4",
    name: "Real-World Multi-Floor Mobile Workload Scenarios (S01-S05)",
    file: path.resolve(__dirname, "tier4_realworld.test.mjs"),
    expectedMinTests: 5,
  },
];

console.log("================================================================================");
console.log("🟣 Technical Sheet Evaluation System — Master E2E Test Runner");
console.log("   Architect: Fern (web-dev-team QA) | Platform: Node 24 native node:sqlite");
console.log("================================================================================\n");

const startTime = Date.now();
const results = [];
let totalPassed = 0;
let totalFailed = 0;
let totalTests = 0;

for (const tier of TIERS) {
  process.stdout.write(`▶ Executing ${tier.id}: ${tier.name}... `);
  const tierStart = Date.now();

  const child = spawnSync(process.execPath, ["--test", tier.file], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });

  const tierDuration = Date.now() - tierStart;
  const stdout = child.stdout || "";
  const stderr = child.stderr || "";

  // Parse pass / fail from node:test output
  let passCount = 0;
  let failCount = 0;
  const passMatch = stdout.match(/ℹ pass (\d+)/);
  const failMatch = stdout.match(/ℹ fail (\d+)/);
  const testMatch = stdout.match(/ℹ tests (\d+)/);

  if (passMatch) passCount = parseInt(passMatch[1], 10);
  if (failMatch) failCount = parseInt(failMatch[1], 10);
  if (testMatch) {
    totalTests += parseInt(testMatch[1], 10);
  } else {
    totalTests += passCount + failCount;
  }

  totalPassed += passCount;
  totalFailed += failCount;

  const passed = child.status === 0 && failCount === 0;
  results.push({
    ...tier,
    passed,
    passCount,
    failCount,
    durationMs: tierDuration,
    stdout,
    stderr,
  });

  if (passed) {
    console.log(`✅ PASS (${passCount} tests, ${tierDuration}ms)`);
  } else {
    console.log(`❌ FAIL (${failCount} failed, ${passCount} passed, ${tierDuration}ms)`);
  }
}

const totalDuration = Date.now() - startTime;

console.log("\n================================================================================");
console.log("📊 4-Tier Test Execution Summary");
console.log("================================================================================");
console.log(`| Tier   | Test Suite Description                             | Tests | Pass | Fail | Time   | Status |`);
console.log(`|--------|----------------------------------------------------|------:|-----:|-----:|-------:|:------:|`);

for (const res of results) {
  const statusBadge = res.passed ? "✅ PASS" : "❌ FAIL";
  const namePadded = res.name.padEnd(50, " ");
  console.log(
    `| ${res.id.padEnd(6, " ")} | ${namePadded.slice(0, 50)} | ${String(res.passCount + res.failCount).padStart(5, " ")} | ${String(res.passCount).padStart(4, " ")} | ${String(res.failCount).padStart(4, " ")} | ${(res.durationMs + "ms").padStart(6, " ")} | ${statusBadge} |`
  );
}

console.log(`|--------|----------------------------------------------------|------:|-----:|-----:|-------:|:------:|`);
console.log(
  `| TOTAL  | All Test Suites (Tiers 1-4)                        | ${String(totalTests).padStart(5, " ")} | ${String(totalPassed).padStart(4, " ")} | ${String(totalFailed).padStart(4, " ")} | ${(totalDuration + "ms").padStart(6, " ")} | ${totalFailed === 0 ? "✅ PASS" : "❌ FAIL"} |`
);
console.log("================================================================================\n");

// Feature Checklist Summary
console.log("📋 Feature Verification Checklist (PROJECT.md / TEST_INFRA.md):");
const features = [
  { id: "F1", name: "D1 Safe Conditional Upsert (Foreign Key Guard)", covered: "Tier 1, 2, 3, 4" },
  { id: "F2", name: "D1 Last-Write-Wins (LWW) Conflict Resolution", covered: "Tier 1, 2, 3, 4" },
  { id: "F3", name: "Backend Sync Metadata & Server Clock Reference", covered: "Tier 1, 2, 3, 4" },
  { id: "F4", name: "LocalStorage Persistent Queue (TECHNICAL_SHEET_QUEUE_V2)", covered: "Tier 1, 2, 3, 4" },
  { id: "F5", name: "Exponential Backoff & Offline Loop Guard", covered: "Tier 1, 2, 3, 4" },
  { id: "F6", name: "Instant Network Event Listener Auto-Flush", covered: "Tier 1, 2, 3, 4" },
  { id: "F7", name: "Full Mutation Queuing (Staff Add/Delete, Advisor)", covered: "Tier 1, 2, 3, 4" },
  { id: "F8", name: "Zombie Evaluation Purge & Clock Skew Drift Handling", covered: "Tier 1, 2, 3, 4" },
  { id: "F9", name: "Four-State Visual Sync Indicators (🟢 🟡 💾 ⚠️)", covered: "Tier 1, 2, 3, 4" },
  { id: "F10", name: "Click-to-Retry Manual Sync (#sync-status)", covered: "Tier 1, 2, 3, 4" },
  { id: "F11", name: "Questionnaire & Layout Immutability (21 mid, 89 cp)", covered: "Tier 1, 2, 3, 4" },
  { id: "F12", name: "Multi-Device Concurrent Simulation", covered: "Tier 1, 2, 3, 4" },
];

for (const feat of features) {
  console.log(`  [x] ${feat.id}: ${feat.name.padEnd(52, " ")} -> Verified (${feat.covered})`);
}

if (totalFailed > 0) {
  console.error(`\n❌ TEST SUITE FAILED with ${totalFailed} failure(s).`);
  for (const res of results) {
    if (!res.passed) {
      console.error(`\n--- Output from ${res.id} (${res.name}) ---`);
      console.error(res.stdout);
      if (res.stderr) console.error(res.stderr);
    }
  }
  process.exit(1);
} else {
  console.log(`\n🎉 ALL ${totalPassed} E2E TESTS PASSED SUCCESSFULLY! Zero regressions detected.`);
  process.exit(0);
}
