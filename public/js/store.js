/**
 * テクニカルシート評価システム: データストア & リアルタイム同期エンジン (V2 堅牢化版)
 * - LocalStorage即時永続化（二重防壁・オフライン完全対応）
 * - 永続化同期キュー (TECHNICAL_SHEET_QUEUE_V2) によるリロード・タブ閉じ耐性
 * - 全ミューテーション（評価、スタッフ追加/削除、アドバイザー）のキューイング
 * - 指数バックオフ (2s, 4s, 8s, max 30s) & ネットワーク復帰時 (online) 即時自動フラッシュ
 * - ゾンビ評価パージ & 時計ズレ (Clock Skew) 補正
 * - 4状態ステータス管理 (🟢 synced, 🟡 syncing, 💾 local_safe, ⚠️ error) & 手動リトライ
 */

class DataStore {
  constructor() {
    this.STORAGE_KEY_DATA = "TECHNICAL_SHEET_DATA_V2";
    this.STORAGE_KEY_QUEUE = "TECHNICAL_SHEET_QUEUE_V2";

    this.data = {
      staff: [],
      advisors: {
        "2F": "2F担当アドバイザー",
        "3F": "3F担当アドバイザー",
        "4F": "4F担当アドバイザー",
        "5F": "5F担当アドバイザー",
      },
      evaluations: {},
      lastSyncedAt: null,
    };

    this.syncQueue = [];
    this.isSyncing = false;
    this.syncStatus = "synced"; // 'synced' | 'syncing' | 'local_safe' | 'error'
    this.syncStatusDetails = {};
    this.statusListeners = [];
    this.storeListeners = [];

    this.backoffFailures = 0;
    this.backoffDelayMs = 2000;
    this.backoffTimer = null;
    this.serverClockOffsetMs = 0;
    this.pollInterval = null;
    this._syncPromise = null;

    // 初期化: ストレージからロード & ネットワーク監視
    this.loadFromStorage();
    this.setupNetworkListeners();
  }

  // 現在時刻（サーバー時刻ズレ補正済みISO文字列）
  now() {
    return new Date(Date.now() + this.serverClockOffsetMs).toISOString();
  }

  // リスナー登録（従来のUIイベント用）
  subscribe(listener) {
    this.storeListeners.push(listener);
    return () => {
      this.storeListeners = this.storeListeners.filter((l) => l !== listener);
    };
  }

  notify(event, payload) {
    this.storeListeners.forEach((l) => {
      try {
        l(event, payload);
      } catch (e) {
        console.error("Store listener error:", e);
      }
    });
  }

  // 同期ステータスリスナー（M3 / F9対応）
  onSyncStatusChange(callback) {
    this.statusListeners.push(callback);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== callback);
    };
  }

  setSyncStatus(status, details = {}) {
    this.syncStatus = status;
    this.syncStatusDetails = details;
    this.notify("sync_status_changed", status);
    for (const listener of this.statusListeners) {
      try {
        listener(status, details);
      } catch (_) {}
    }
  }

  // LocalStorageからデータとキューを安全にロード
  loadFromStorage() {
    try {
      const rawData = localStorage.getItem(this.STORAGE_KEY_DATA);
      if (rawData) {
        const parsed = JSON.parse(rawData);
        if (parsed.staff && parsed.staff.length > 0) {
          this.data.staff = parsed.staff.map((s) => ({
            ...s,
            name: (s.name || "").replace(/リーダー/g, "介護スタッフ"),
            role: "general",
          }));
        } else {
          this.initDefaultData();
        }
        if (parsed.advisors) this.data.advisors = { ...this.data.advisors, ...parsed.advisors };
        if (parsed.evaluations) this.data.evaluations = parsed.evaluations;
        if (parsed.lastSyncedAt) this.data.lastSyncedAt = parsed.lastSyncedAt;
      } else {
        this.initDefaultData();
      }

      // 永続化された同期キューの復元
      const rawQueue = localStorage.getItem(this.STORAGE_KEY_QUEUE);
      if (rawQueue) {
        const parsedQueue = JSON.parse(rawQueue);
        if (Array.isArray(parsedQueue)) {
          this.syncQueue = parsedQueue;
        }
      }
    } catch (e) {
      console.warn("Storage recovery: initializing defaults", e);
      this.syncQueue = [];
      this.initDefaultData();
    }
  }

  // LocalStorageへデータとキューを即時永続化
  saveToStorage() {
    try {
      localStorage.setItem(this.STORAGE_KEY_DATA, JSON.stringify(this.data));
      localStorage.setItem(this.STORAGE_KEY_QUEUE, JSON.stringify(this.syncQueue));
    } catch (e) {
      console.error("LocalStorage save error:", e);
    }
  }

  saveToLocal() {
    this.saveToStorage();
  }

  // 初回デフォルトサンプルデータ（一般介護スタッフのみ）
  initDefaultData() {
    this.data.staff = [
      { id: "staff_2f_01", floor: "2F", name: "介護スタッフ A (2F)", role: "general", order_num: 1 },
      { id: "staff_2f_02", floor: "2F", name: "介護スタッフ B (2F)", role: "general", order_num: 2 },
      { id: "staff_3f_01", floor: "3F", name: "介護スタッフ C (3F)", role: "general", order_num: 1 },
      { id: "staff_3f_02", floor: "3F", name: "介護スタッフ D (3F)", role: "general", order_num: 2 },
      { id: "staff_4f_01", floor: "4F", name: "介護スタッフ E (4F)", role: "general", order_num: 1 },
      { id: "staff_4f_02", floor: "4F", name: "介護スタッフ F (4F)", role: "general", order_num: 2 },
      { id: "staff_5f_01", floor: "5F", name: "介護スタッフ G (5F)", role: "general", order_num: 1 },
      { id: "staff_5f_02", floor: "5F", name: "介護スタッフ H (5F)", role: "general", order_num: 2 },
    ];
    this.saveToStorage();
  }

  // ネットワーク状態イベントハンドラー（F6対応）
  setupNetworkListeners() {
    if (typeof window === "undefined") return;

    window.addEventListener("online", async () => {
      this.backoffFailures = 0;
      this.backoffDelayMs = 2000;
      if (this.backoffTimer) clearTimeout(this.backoffTimer);
      await this.flushSyncQueue();
      await this.fetchBootstrap(true);
    });

    window.addEventListener("offline", () => {
      if (this.backoffTimer) clearTimeout(this.backoffTimer);
      this.setSyncStatus("local_safe");
    });
  }

  // 起動時の同期開始
  async startRealtimeSync() {
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    await this.fetchBootstrap();
    if (this.syncQueue.length > 0) {
      await this.flushSyncQueue();
    }

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        if (navigator.onLine && !this.isSyncing) {
          this.fetchBootstrap(true);
        }
      }, 8000);
    }
  }

  // クラウドから最新データ取得 & ローカルとの安全マージ（F8対応）
  async fetchBootstrap(isBackground = false) {
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return false;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
      return false;
    }

    try {
      if (!isBackground) this.setSyncStatus("syncing");

      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = await res.json();
      if (!body.success) throw new Error(body.error || "Bootstrap failed");

      // 時計ズレ (Clock Skew) の補正計算
      if (body.serverTime) {
        const serverTimeMs = new Date(body.serverTime).getTime();
        this.serverClockOffsetMs = serverTimeMs - Date.now();
      }

      // スタッフの更新 & 削除済みスタッフのゾンビ評価パージ
      if (Array.isArray(body.staff)) {
        this.data.staff = body.staff.map((s) => ({
          ...s,
          name: (s.name || "").replace(/リーダー/g, "介護スタッフ"),
          role: "general",
        }));

        const validStaffIds = new Set(this.data.staff.map((s) => s.id));
        for (const key of Object.keys(this.data.evaluations)) {
          const ev = this.data.evaluations[key];
          if (ev && !validStaffIds.has(ev.staff_id)) {
            delete this.data.evaluations[key];
          }
        }
      }

      // アドバイザーの更新
      if (Array.isArray(body.advisors)) {
        body.advisors.forEach((adv) => {
          this.data.advisors[adv.floor] = adv.advisor_name;
        });
      }

      // 評価データのLast-Write-Wins (LWW) マージ
      let hasUpdate = false;
      if (Array.isArray(body.evaluations)) {
        body.evaluations.forEach((remoteEval) => {
          const key = `${remoteEval.staff_id}_${remoteEval.item_id}`;
          const localEval = this.data.evaluations[key];

          if (!localEval || !localEval.updated_at || remoteEval.updated_at >= localEval.updated_at) {
            this.data.evaluations[key] = {
              staff_id: remoteEval.staff_id,
              item_id: remoteEval.item_id,
              check_eval: remoteEval.check_eval || "",
              score: remoteEval.score || "",
              checks_json: typeof remoteEval.checks_json === "string" ? JSON.parse(remoteEval.checks_json || "[]") : remoteEval.checks_json || [],
              memo: remoteEval.memo || "",
              evaluator_name: remoteEval.evaluator_name || "",
              evaluation_date: remoteEval.evaluation_date || "",
              updated_at: remoteEval.updated_at,
            };
            hasUpdate = true;
          }
        });
      }

      this.data.lastSyncedAt = body.serverTime || this.now();
      this.saveToStorage();

      if (this.syncQueue.length === 0) {
        this.setSyncStatus("synced");
      }

      this.backoffFailures = 0;
      this.backoffDelayMs = 2000;

      if (hasUpdate || !isBackground) {
        this.notify("data_updated");
      }
      return true;
    } catch (err) {
      if (!navigator.onLine) {
        this.setSyncStatus("local_safe");
      } else {
        this.setSyncStatus("error", { error: err.message });
      }
      return false;
    }
  }

  getStaffByFloor(floor) {
    return this.data.staff.filter((s) => s.floor === floor);
  }

  getStaffById(staffId) {
    return this.data.staff.find((s) => s.id === staffId);
  }

  // スタッフの保存（ミューテーションキューイング対応）
  async saveStaff(staffMember) {
    const cleanStaff = { ...staffMember, role: "general", updated_at: this.now() };
    const existingIndex = this.data.staff.findIndex((s) => s.id === cleanStaff.id);
    if (existingIndex >= 0) {
      this.data.staff[existingIndex] = { ...this.data.staff[existingIndex], ...cleanStaff };
    } else {
      this.data.staff.push(cleanStaff);
    }

    // キューへ追加
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "staff_save" && m.data.id === cleanStaff.id)
    );
    this.syncQueue.push({
      type: "staff_save",
      data: cleanStaff,
    });
    this.saveToStorage();
    this.notify("staff_changed");

    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
    } else {
      this.flushSyncQueue();
    }
  }

  // スタッフの削除（ミューテーションキューイング対応）
  async deleteStaff(staffId) {
    this.data.staff = this.data.staff.filter((s) => s.id !== staffId);

    // 関連評価データのローカルパージ
    Object.keys(this.data.evaluations).forEach((k) => {
      if (k.startsWith(`${staffId}_`)) delete this.data.evaluations[k];
    });

    // キュー内の該当スタッフの評価送信を除去し、削除ミューテーションを追加
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "evaluation" && m.data.staff_id === staffId)
    );
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "staff_delete" && m.staffId === staffId)
    );
    this.syncQueue.push({
      type: "staff_delete",
      staffId,
    });

    this.saveToStorage();
    this.notify("staff_changed");

    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
    } else {
      this.flushSyncQueue();
    }
  }

  // アドバイザー名の設定（ミューテーションキューイング対応）
  async setAdvisorName(floor, name) {
    const updated = { floor, advisor_name: name, updated_at: this.now() };
    this.data.advisors[floor] = name;

    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "advisor_save" && m.data.floor === floor)
    );
    this.syncQueue.push({
      type: "advisor_save",
      data: updated,
    });

    this.saveToStorage();
    this.notify("advisor_changed", { floor, name });

    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
    } else {
      this.flushSyncQueue();
    }
  }

  getAdvisorName(floor) {
    return this.data.advisors[floor] || `${floor}担当アドバイザー`;
  }

  getEvaluation(staffId, itemId) {
    const key = `${staffId}_${itemId}`;
    return (
      this.data.evaluations[key] || {
        staff_id: staffId,
        item_id: itemId,
        check_eval: "",
        score: "",
        checks_json: [],
        memo: "",
        evaluator_name: "",
        evaluation_date: "",
        updated_at: null,
      }
    );
  }

  // 評価の保存（ミューテーションキューイング対応）
  saveEvaluation(staffId, itemId, updates) {
    const key = `${staffId}_${itemId}`;
    const current = this.getEvaluation(staffId, itemId);
    const nowIso = this.now();

    const updated = {
      ...current,
      ...updates,
      staff_id: staffId,
      item_id: itemId,
      updated_at: updates.updated_at || nowIso,
    };

    this.data.evaluations[key] = updated;

    // キュー内同一アイテムの重複集約
    this.syncQueue = this.syncQueue.filter(
      (m) => !(m.type === "evaluation" && m.data.staff_id === staffId && m.data.item_id === itemId)
    );
    this.syncQueue.push({
      type: "evaluation",
      data: updated,
    });

    this.saveToStorage();
    this.notify("eval_updated", { staffId, itemId, record: updated });

    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
    } else {
      this.triggerSyncDebounced();
    }
  }

  triggerSyncDebounced() {
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.flushSyncQueue();
    }, 400);
  }

  // 永続キューの一括フラッシュ処理（F5, F6, F7対応）
  async flushSyncQueue() {
    if (typeof window !== "undefined" && window.location.protocol === "file:") {
      this.syncQueue = [];
      this.saveToStorage();
      this.setSyncStatus("local_safe");
      return false;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
      return false;
    }

    if (this._syncPromise) {
      await this._syncPromise;
      if (this.syncQueue.length === 0 || !navigator.onLine) {
        return navigator.onLine;
      }
    }

    this._syncPromise = (async () => {
      try {
        while (this.syncQueue.length > 0 && navigator.onLine) {
          const ok = await this._executeFlushBatch();
          if (!ok) return false;
        }
        return true;
      } finally {
        this._syncPromise = null;
      }
    })();

    return this._syncPromise;
  }

  async _executeFlushBatch() {
    if (this.syncQueue.length === 0) {
      this.setSyncStatus("synced");
      return true;
    }

    if (!navigator.onLine) {
      this.setSyncStatus("local_safe");
      return false;
    }

    this.setSyncStatus("syncing");
    const currentBatch = [...this.syncQueue];
    this.syncQueue = [];

    const evaluationItems = [];
    const nonEvalMutations = [];

    for (const m of currentBatch) {
      if (m.type === "evaluation") {
        evaluationItems.push(m.data);
      } else {
        nonEvalMutations.push(m);
      }
    }

    try {
      // 1. スタッフ・アドバイザーのミューテーションを先に実行
      for (const mut of nonEvalMutations) {
        if (mut.type === "staff_save") {
          const res = await fetch("/api/staff", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mut.data),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else if (mut.type === "staff_delete") {
          const res = await fetch(`/api/staff/${encodeURIComponent(mut.staffId)}`, {
            method: "DELETE",
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } else if (mut.type === "advisor_save") {
          const res = await fetch("/api/advisors", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(mut.data),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }
      }

      // 2. 評価アイテムのバッチ送信
      if (evaluationItems.length > 0) {
        const res = await fetch("/api/evaluations/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: evaluationItems }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }

      this.saveToStorage();
      this.setSyncStatus("synced");
      this.backoffFailures = 0;
      this.backoffDelayMs = 2000;
      return true;
    } catch (err) {
      // 失敗時はバッチをキュー先頭へ戻し、指数バックオフで待機
      this.syncQueue = [...currentBatch, ...this.syncQueue];
      this.saveToStorage();
      this.backoffFailures++;
      this.backoffDelayMs = Math.min(30000, 2000 * Math.pow(2, this.backoffFailures - 1));

      if (!navigator.onLine) {
        this.setSyncStatus("local_safe");
      } else {
        this.setSyncStatus("error", { error: err.message, retryInMs: this.backoffDelayMs });
        if (this.backoffTimer) clearTimeout(this.backoffTimer);
        this.backoffTimer = setTimeout(() => {
          if (navigator.onLine) this.flushSyncQueue();
        }, this.backoffDelayMs);
      }
      return false;
    }
  }

  // 手動再同期リトライ（F10対応）
  async retrySyncManual() {
    this.backoffFailures = 0;
    this.backoffDelayMs = 2000;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);

    this.setSyncStatus("syncing", { manual: true });
    const flushOk = await this.flushSyncQueue();
    const bootOk = await this.fetchBootstrap();
    return flushOk && bootOk;
  }

  // スタッフ進捗率計算（全21中項目ベース）
  calcStaffProgress(staffId) {
    if (!window.TECHNICAL_SHEET_MASTER) return { completed: 0, total: 21, percent: 0 };

    let total = 0;
    let completed = 0;

    window.TECHNICAL_SHEET_MASTER.forEach((cat) => {
      cat.subcategories.forEach((sub) => {
        sub.mid_items.forEach((mid) => {
          total++;
          const ev = this.getEvaluation(staffId, mid.id);
          if (ev && (ev.check_eval || ev.score)) {
            completed++;
          }
        });
      });
    });

    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percent };
  }

  calcFloorProgress(floor) {
    const staffList = this.getStaffByFloor(floor);
    if (staffList.length === 0) return { completed: 0, total: 0, percent: 0 };

    let totalCompleted = 0;
    staffList.forEach((s) => {
      const prog = this.calcStaffProgress(s.id);
      if (prog.percent === 100) totalCompleted++;
    });

    const percent = Math.round((totalCompleted / staffList.length) * 100);
    return { completed: totalCompleted, total: staffList.length, percent };
  }
}

window.store = new DataStore();
