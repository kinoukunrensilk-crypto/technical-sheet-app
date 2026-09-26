-- ========================================================
-- テクニカルシート評価システム Cloudflare D1 データベーススキーマ
-- ========================================================

-- 1. スタッフマスターテーブル
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  floor TEXT NOT NULL,          -- '2F', '3F', '4F', '5F'
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'general', -- 'general' (一般), 's_class' (Sクラス・リーダー層)
  order_num INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 2. フロア担当アドバイザー設定テーブル
CREATE TABLE IF NOT EXISTS advisors (
  floor TEXT PRIMARY KEY,       -- '2F', '3F', '4F', '5F'
  advisor_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 3. 評価データテーブル
CREATE TABLE IF NOT EXISTS evaluations (
  staff_id TEXT NOT NULL,
  item_id TEXT NOT NULL,        -- 'item_001' 〜 'item_025'
  check_eval TEXT,              -- 'circle' (〇), 'cross' (×), ''
  score TEXT,                   -- 'A', 'B', 'C', 'hyphen' (―), ''
  checks_json TEXT,             -- JSON配列: ["item_001_cp_1", ...]
  memo TEXT,                    -- 自由記載欄
  evaluator_name TEXT,
  evaluation_date TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (staff_id, item_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
);

-- インデックス作成
CREATE INDEX IF NOT EXISTS idx_staff_floor ON staff(floor);
CREATE INDEX IF NOT EXISTS idx_eval_staff ON evaluations(staff_id);

-- 初期アドバイザーデータ（存在しない場合のみ登録）
INSERT OR IGNORE INTO advisors (floor, advisor_name, updated_at) VALUES
('2F', '2F担当アドバイザー', datetime('now', 'localtime')),
('3F', '3F担当アドバイザー', datetime('now', 'localtime')),
('4F', '4F担当アドバイザー', datetime('now', 'localtime')),
('5F', '5F担当アドバイザー', datetime('now', 'localtime'));

-- 初期スタッフサンプルデータ（各フロア2名ずつ、画面から追加・編集可能）
INSERT OR IGNORE INTO staff (id, floor, name, role, order_num, created_at, updated_at) VALUES
('staff_2f_01', '2F', '介護スタッフ A (2F)', 'general', 1, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_2f_02', '2F', 'リーダー B (2F)', 's_class', 2, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_3f_01', '3F', '介護スタッフ C (3F)', 'general', 1, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_3f_02', '3F', 'リーダー D (3F)', 's_class', 2, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_4f_01', '4F', '介護スタッフ E (4F)', 'general', 1, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_4f_02', '4F', 'リーダー F (4F)', 's_class', 2, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_5f_01', '5F', '介護スタッフ G (5F)', 'general', 1, datetime('now', 'localtime'), datetime('now', 'localtime')),
('staff_5f_02', '5F', 'リーダー H (5F)', 's_class', 2, datetime('now', 'localtime'), datetime('now', 'localtime'));
