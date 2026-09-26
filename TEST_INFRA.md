# E2E Test Infra: 介護スタッフ テクニカルシート評価システム

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation design.
- Zero npm runtime dependencies: utilizes Node 24 built-in `node:sqlite` (`DatabaseSync`), `node:test`, and `node:assert`.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Real-World Workload Testing.

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| F1 | D1 Safe Conditional Upsert (Foreign Key Guard) | ORIGINAL_REQUEST §R1 & Survey | 5 | 5 | ✓ |
| F2 | D1 Last-Write-Wins (LWW) Conflict Resolution | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| F3 | Sync Metadata & Server Clock Reference | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| F4 | LocalStorage Persistent Queue (`TECHNICAL_SHEET_QUEUE_V2`) | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| F5 | Exponential Backoff & Loop Guard | ORIGINAL_REQUEST §R1, R3 | 5 | 5 | ✓ |
| F6 | Instant Network Event Listener Auto-Flush | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| F7 | Full Mutation Queuing (Staff Add/Delete, Advisor) | ORIGINAL_REQUEST §R1, R2 | 5 | 5 | ✓ |
| F8 | Zombie Evaluation Purge & Clock Skew Compensation | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| F9 | Four-State Visual Sync Indicators (🟢 🟡 💾 ⚠️) | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| F10 | Click-to-Retry Manual Sync | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| F11 | Master Questionnaire & Layout Immutability | ORIGINAL_REQUEST §Stability | 5 | 5 | ✓ |
| F12 | Multi-Device Concurrent Simulation | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |

## Test Architecture
- **Test Runner**: `node test/runner.mjs`
  - Exit code 0 on all tests passing, non-zero on any failure.
  - Generates TAP / Spec test summary output.
- **Mock D1 / Worker Engine**: `test/d1_mock.mjs`
  - Replicates Cloudflare Workers `env.DB` API (`prepare`, `bind`, `run`, `all`, `batch`) using Node 24 `node:sqlite`.
  - Executes exact D1 schema from `schema.sql`.
- **Test Suite Files**:
  - `test/tier1_feature.test.mjs`: Equivalence class coverage for all 12 features (≥5 cases per feature).
  - `test/tier2_boundary.test.mjs`: Extreme values, empty batches, large payloads, clock offsets, network dropouts.
  - `test/tier3_pairwise.test.mjs`: Cross-feature combinatorial interactions (e.g. offline queue + staff deletion + clock skew).
  - `test/tier4_realworld.test.mjs`: Multi-advisor floor evaluation scenarios across 2F-5F simulating real mobile usage.
  - `test/tier5_adversarial.test.mjs`: Adversarial stress tests (race conditions, rapid reconnection storms, malicious payloads).

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | 2F Advisor mobile evaluation during WiFi dropouts | F1, F4, F5, F6, F9 | High |
| 2 | Concurrent 3F and 4F evaluations on shared staff | F2, F3, F8, F12 | High |
| 3 | Staff deletion on PC while mobile advisor edits evaluations offline | F1, F7, F8, F9 | Extreme |
| 4 | Offline staff addition and full evaluation across 21 mid-items | F4, F6, F7, F11 | High |
| 5 | Large batch synchronization recovery with network flapping | F4, F5, F6, F10 | High |

## Coverage Thresholds
- Tier 1: ≥5 per feature (60+ tests)
- Tier 2: ≥5 per feature (60+ tests)
- Tier 3: Pairwise coverage of major feature interactions (12+ tests)
- Tier 4: ≥5 realistic application scenarios
- Tier 5: Adversarial edge cases and coverage gap hardening
