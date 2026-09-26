/**
 * テクニカルシート評価システム: データストア & リアルタイム同期エンジン
 * - LocalStorage即時永続化（オフライン二重防壁）
 * - Cloudflare D1 クラウドAPI即時同期
 * - 定期ポーリングによる他端末更新のリアルタイム反映
 * ※評価対象は一般介護スタッフ専用（リーダー評価なし）
 */

class DataStore {
  constructor() {
    this.STORAGE_KEY = "TECHNICAL_SHEET_DATA_V2"; // V2に更新して介護スタッフ専用データをクリーンに初期化
    this.data = {
      staff: [],
      advisors: {
        "2F": "2F担当アドバイザー",
        "3F": "3F担当アドバイザー",
        "4F": "4F担当アドバイザー",
        "5F": "5F担当アドバイザー",
      },
      evaluations: {}, // key: `${staff_id}_${item_id}` => { staff_id, item_id, check_eval, score, checks_json, memo, evaluator_name, evaluation_date, updated_at }
      lastSyncedAt: null,
    };

    this.syncQueue = [];
    this.isSyncing = false;
    this.syncStatus = "synced"; // 'synced' | 'syncing' | 'offline'
    this.listeners = [];
    this.pollInterval = null;

    // 初期化: LocalStorageから読み込み
    this.loadFromLocal();
  }

  // リスナー登録（UI更新通知用）
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  notify(event, payload) {
    this.listeners.forEach((l) => l(event, payload));
  }

  setSyncStatus(status) {
    if (this.syncStatus !== status) {
      this.syncStatus = status;
      this.notify("sync_status_changed", status);
    }
  }

  // LocalStorageからロード
  loadFromLocal() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.staff && parsed.staff.length > 0) {
          // リーダー表記があれば介護スタッフにノーマライズ
          this.data.staff = parsed.staff.map((s) => ({
            ...s,
            name: s.name.replace(/リーダー/g, "介護スタッフ"),
            role: "general",
          }));
        } else {
          this.initDefaultData();
        }
        if (parsed.advisors) this.data.advisors = { ...this.data.advisors, ...parsed.advisors };
        if (parsed.evaluations) this.data.evaluations = parsed.evaluations;
        if (parsed.lastSyncedAt) this.data.lastSyncedAt = parsed.lastSyncedAt;
      } else {
        // 初回初期サンプルデータ
        this.initDefaultData();
      }
    } catch (e) {
      console.warn("Failed to load from local storage:", e);
      this.initDefaultData();
    }
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
    this.saveToLocal();
  }

  // LocalStorageへ即時書き込み
  saveToLocal() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.error("LocalStorage save error:", e);
    }
  }

  // 起動時のクラウド同期 & 定期ポーリング開始
  async startRealtimeSync() {
    // file:// プロトコル（ローカル直接起動）の場合はクラウドAPIが存在しないためローカル保存モードで安定稼働
    if (window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    await this.fetchBootstrap();

    if (!this.pollInterval) {
      this.pollInterval = setInterval(() => {
        this.fetchBootstrap(true);
      }, 8000); // 穏やかなポーリング間隔
    }
  }

  // クラウドから全データ取得 & ローカルとのマージ
  async fetchBootstrap(isBackground = false) {
    if (window.location.protocol === "file:") {
      this.setSyncStatus("local_safe");
      return;
    }

    try {
      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Sync failed");

      if (result.staff && result.staff.length > 0) {
        this.data.staff = result.staff.map((s) => ({
          ...s,
          name: s.name.replace(/リーダー/g, "介護スタッフ"),
          role: "general",
        }));
      }

      if (result.advisors) {
        result.advisors.forEach((adv) => {
          this.data.advisors[adv.floor] = adv.advisor_name;
        });
      }

      let hasUpdate = false;
      if (result.evaluations) {
        result.evaluations.forEach((remoteEval) => {
          const key = `${remoteEval.staff_id}_${remoteEval.item_id}`;
          const localEval = this.data.evaluations[key];

          if (!localEval || (remoteEval.updated_at && (!localEval.updated_at || remoteEval.updated_at > localEval.updated_at))) {
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

      this.data.lastSyncedAt = result.serverTime || new Date().toISOString();
      this.saveToLocal();
      this.setSyncStatus("synced");

      if (hasUpdate || !isBackground) {
        this.notify("data_updated");
      }
    } catch (err) {
      // サーバー未起動やローカル時は静止のローカル保存モードにする（点滅させない）
      this.setSyncStatus("local_safe");
    }
  }

  getStaffByFloor(floor) {
    return this.data.staff.filter((s) => s.floor === floor);
  }

  getStaffById(staffId) {
    return this.data.staff.find((s) => s.id === staffId);
  }

  async saveStaff(staffMember) {
    const cleanStaff = { ...staffMember, role: "general" };
    const existingIndex = this.data.staff.findIndex((s) => s.id === cleanStaff.id);
    if (existingIndex >= 0) {
      this.data.staff[existingIndex] = { ...this.data.staff[existingIndex], ...cleanStaff };
    } else {
      this.data.staff.push(cleanStaff);
    }
    this.saveToLocal();
    this.notify("staff_changed");

    try {
      await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cleanStaff),
      });
    } catch (e) {
      console.warn("Cloud sync failed for staff, saved locally");
    }
  }

  async deleteStaff(staffId) {
    this.data.staff = this.data.staff.filter((s) => s.id !== staffId);
    Object.keys(this.data.evaluations).forEach((k) => {
      if (k.startsWith(`${staffId}_`)) delete this.data.evaluations[k];
    });
    this.saveToLocal();
    this.notify("staff_changed");

    try {
      await fetch(`/api/staff/${encodeURIComponent(staffId)}`, { method: "DELETE" });
    } catch (e) {
      console.warn("Cloud delete failed, deleted locally");
    }
  }

  async setAdvisorName(floor, name) {
    this.data.advisors[floor] = name;
    this.saveToLocal();
    this.notify("advisor_changed", { floor, name });

    try {
      await fetch("/api/advisors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floor, advisor_name: name }),
      });
    } catch (e) {
      console.warn("Cloud sync failed for advisor, saved locally");
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

  saveEvaluation(staffId, itemId, updates) {
    const key = `${staffId}_${itemId}`;
    const current = this.getEvaluation(staffId, itemId);
    const now = new Date().toISOString();

    const updated = {
      ...current,
      ...updates,
      staff_id: staffId,
      item_id: itemId,
      updated_at: now,
    };

    this.data.evaluations[key] = updated;
    this.saveToLocal();
    this.notify("eval_updated", { staffId, itemId, record: updated });

    this.queueSync(updated);
  }

  queueSync(evalRecord) {
    this.syncQueue = this.syncQueue.filter(
      (item) => !(item.staff_id === evalRecord.staff_id && item.item_id === evalRecord.item_id)
    );
    this.syncQueue.push(evalRecord);
    this.triggerSyncDebounced();
  }

  triggerSyncDebounced() {
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.flushSyncQueue();
    }, 400);
  }

  async flushSyncQueue() {
    if (this.syncQueue.length === 0 || this.isSyncing) return;

    if (window.location.protocol === "file:") {
      this.syncQueue = [];
      this.setSyncStatus("local_safe");
      return;
    }

    const batch = [...this.syncQueue];
    this.syncQueue = [];
    this.isSyncing = true;

    try {
      const res = await fetch("/api/evaluations/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: batch }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.setSyncStatus("synced");
    } catch (err) {
      this.syncQueue = [...batch, ...this.syncQueue];
      this.setSyncStatus("local_safe");
    } finally {
      this.isSyncing = false;
      if (this.syncQueue.length > 0 && window.location.protocol !== "file:") {
        this.triggerSyncDebounced();
      }
    }
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
