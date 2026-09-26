# Project: 介護スタッフ テクニカルシート評価システム (Cloudflare D1 & Sync Robustification)

## Architecture
- **Client (Frontend)**: Single Page Application (Vanilla JavaScript ES6 modules, HTML5, CSS3)
  - Persistence: Dual-layer (In-memory reactive state + LocalStorage persistent backup + `TECHNICAL_SHEET_QUEUE_V2` persistent mutation queue)
  - Network Observer: `navigator.onLine` + `window.addEventListener('online'/'offline')` + Heartbeat bootstrap
  - Design System: Digital Agency Design System (WCAG 2.1 AA compliant)
- **Backend (Edge)**: Cloudflare Workers
  - Endpoints: `/api/health`, `/api/bootstrap`, `/api/staff`, `/api/staff/:id`, `/api/advisors`, `/api/evaluations/sync`
- **Database (Cloud)**: Cloudflare D1 (Distributed SQLite)
  - Tables: `staff`, `advisors`, `evaluations`
  - Conflict Resolution: Item-level Last-Write-Wins (LWW) with ISO 8601 UTC `updated_at` timestamps
  - Integrity: Foreign key enforcement with safe conditional upsert (`WHERE EXISTS (SELECT 1 FROM staff WHERE id = ?)`)
- **Test Infrastructure**:
  - Node 24 native `node:sqlite` (`DatabaseSync`) + `node:test` + `node:assert`
  - Zero external npm runtime dependencies, deterministic opaque-box E2E test harness

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | F1: D1 Safe Conditional Upsert | `SELECT ... WHERE EXISTS (SELECT 1 FROM staff WHERE id = ?)` to prevent `SQLITE_CONSTRAINT_FOREIGNKEY` when syncing evaluations of deleted staff | M1 | Survey 1 & 3 |
| 2 | F2: D1 LWW Conflict Resolution for All Entities | Timestamp LWW check (`WHERE excluded.updated_at >= target.updated_at`) on evaluations, staff, and advisors | M1 | Survey 1 |
| 3 | F3: Backend Sync Metadata & Clock Reference | Return count of affected rows and server ISO timestamp in sync and bootstrap responses | M1 | Survey 1 & 3 |
| 4 | F4: LocalStorage Persistent Queue | `TECHNICAL_SHEET_QUEUE_V2` storage key ensuring offline queue survives page refresh and tab close | M2 | Survey 2 |
| 5 | F5: Exponential Backoff & Offline Pause | Halt queue flush when offline; apply exponential backoff (2s, 4s, 8s, max 30s) on network failures to eliminate 400ms retry storm | M2 | Survey 2 |
| 6 | F6: Instant Reconnection Auto-Flush | `window.addEventListener('online')` handler triggering immediate queue flush and state re-bootstrap | M2 | Survey 2 |
| 7 | F7: Full Mutation Queuing | Queue staff creations, renames, and deletions so offline management operations are never lost | M2 | Survey 2 & 3 |
| 8 | F8: Zombie Evaluation Purge & Clock Skew Drift Handling | Purge local evaluations for deleted staff on bootstrap sync; adjust timestamps using server time offset | M2 | Survey 1, 2 & 3 |
| 9 | F9: Four-State Visual Sync Indicators | 🟢 クラウド同期済 (synced/green), 🟡 同期中 (syncing/amber pulse), 💾 ローカル保存中 (local_safe/slate), ⚠️ 同期エラー (error/rose) | M3 | Survey 2 & R3 |
| 10 | F10: Click-to-Retry Manual Sync | Clickable `#sync-status` badge triggering immediate manual sync retry with visual feedback | M3 | Survey 2 & R3 |
| 11 | F11: Questionnaire & Layout Preservation | Maintain all 21 categories, 89 checkpoints, 175 sub-checks, ABC buttons, 〇× clear marks, A4 print styles | M1-M4 (All) | Survey 3 & R1-R3 |
| 12 | F12: E2E Test Suite (Tiers 1-4) | Systematic opaque-box test suite (Category-Partition, BVA, Pairwise, Workload) with pass criteria | E2E Track / M4 | Survey 3 & Spec |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| E2E | E2E Testing Track | Test harness (`test/runner.mjs`), test suites (Tiers 1-4), publish `TEST_READY.md` | Survey | DONE (140 tests pass across Tiers 1-4) |
| 1 | M1: Cloudflare D1 Backend Hardening | `src/index.js`, `schema.sql`: Safe upsert, LWW guards, metadata response | Survey | DONE (100% pass, 41 edge + 18 adv + 60 bnd + 15 pair) |
| 2 | M2: Frontend Store Sync & Offline Engine | `public/js/store.js`: Persistent queue, backoff, online listener, mutation queuing | M1 | DONE (F4-F8 verified in Tiers 1-4) |
| 3 | M3: UI Status Badges & Interaction | `public/js/app.js`, `public/css/style.css`, `public/index.html`: 4 visual states, click-to-retry | M2 | DONE (F9-F10 verified in Tiers 1-4) |
| 4 | M4: Final Verification & Hardening | Phase 1: 100% E2E test suite pass. Phase 2: Adversarial coverage hardening (Tier 5) | E2E, M3 | DONE (158/158 tests 100% PASS) |

## Interface Contracts

### Backend API ↔ Frontend Store
1. **`POST /api/evaluations/sync`**:
   - Request Body: `{ items: Array<{ staff_id, item_id, check_eval, score, checks_json, memo, evaluator_name, evaluation_date, updated_at }> }`
   - Response: `{ success: true, count: number, updated: number, serverTime: string }` or `{ success: false, error: string }`
   - Contract: Must ignore evaluations for nonexistent `staff_id` without failing foreign key constraints (`WHERE EXISTS`).
   - Contract: Must only overwrite when `excluded.updated_at >= evaluations.updated_at`.

2. **`POST /api/staff`**:
   - Request Body: `{ id, floor, name, role?, order_num?, updated_at? }`
   - Response: `{ success: true, staff: object, serverTime: string }`
   - Contract: Timestamp LWW guard (`WHERE excluded.updated_at >= staff.updated_at`).

3. **`DELETE /api/staff/:id`**:
   - Response: `{ success: true, deletedId: string }`
   - Contract: Atomically deletes staff and cascading evaluations.

4. **`GET /api/bootstrap`**:
   - Response: `{ success: true, staff: Array, advisors: Array, evaluations: Array, serverTime: string }`
   - Contract: Frontend purges local evaluations for staff IDs not in `staff` list.

5. **`store.js` ↔ `app.js`**:
   - Event/Callback: `store.onSyncStatusChange(callback: (status, info) => void)`
   - Status values: `"synced" | "syncing" | "local_safe" | "error"`
   - Method: `store.retrySyncManual(): Promise<boolean>`

## Code Layout
- `src/index.js`: Cloudflare Worker API & routing
- `schema.sql`: D1 database schema and indexes
- `wrangler.toml`: Cloudflare Worker and D1 binding configuration
- `public/index.html`: Main SPA application markup
- `public/css/style.css`: Application styling & Digital Agency Design System tokens
- `public/js/store.js`: Reactive state store, persistent offline queue, sync engine
- `public/js/app.js`: UI event listeners, view rendering, modal management
- `public/js/technical_sheet_data.js`: Master questionnaire definition (21 mid items, 89 checkpoints)
- `test/`:
  - `test/runner.mjs`: Test discovery and execution harness
  - `test/d1_mock.mjs`: Node 24 native SQLite D1 mock implementation
  - `test/tier1_feature.test.mjs`: Tier 1 Feature coverage tests
  - `test/tier2_boundary.test.mjs`: Tier 2 Boundary and corner case tests
  - `test/tier3_pairwise.test.mjs`: Tier 3 Cross-feature combination tests
  - `test/tier4_realworld.test.mjs`: Tier 4 Real-world offline/online workload tests
  - `test/tier5_adversarial.test.mjs`: Tier 5 Adversarial coverage hardening tests
