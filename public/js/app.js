/**
 * テクニカルシート評価システム: アプリケーションUI制御
 * デジタル庁デザインシステム準拠 & モバイル/iPad/PCレスポンシブ
 */

document.addEventListener("DOMContentLoaded", () => {
  const store = window.store;
  const master = window.TECHNICAL_SHEET_MASTER;

  // 内部状態
  let currentFloor = "2F";
  let currentStaffId = null;

  // DOM要素
  const syncStatusEl = document.getElementById("sync-status");
  const floorTabsContainer = document.getElementById("floor-tabs");
  const staffListContainer = document.getElementById("staff-list");
  const evalAreaContainer = document.getElementById("eval-area");
  const targetBanner = document.getElementById("target-banner");

  // モーダル要素
  const staffModal = document.getElementById("staff-modal");
  const staffForm = document.getElementById("staff-form");
  const advisorModal = document.getElementById("advisor-modal");
  const advisorForm = document.getElementById("advisor-form");

  // ----------------------------------------------------
  // 1. 同期ステータスバッジの更新
  // ----------------------------------------------------
  function updateSyncStatus(status) {
    if (!syncStatusEl) return;
    syncStatusEl.className = `sync-status ${status}`;
    const textEl = syncStatusEl.querySelector(".sync-text");
    if (status === "synced") {
      textEl.textContent = "クラウド同期済";
    } else if (status === "syncing") {
      textEl.textContent = "同期中...";
    } else {
      textEl.textContent = "ローカル保存中";
    }
  }

  // ----------------------------------------------------
  // 2. フロアタブの描画
  // ----------------------------------------------------
  function renderFloorTabs() {
    floorTabsContainer.innerHTML = "";
    ["2F", "3F", "4F", "5F"].forEach((floor) => {
      const advName = store.getAdvisorName(floor);
      const prog = store.calcFloorProgress(floor);

      const btn = document.createElement("button");
      btn.className = `floor-tab-btn ${floor === currentFloor ? "active" : ""}`;
      btn.innerHTML = `
        <span>${floor}（${prog.completed}/${prog.total}名完了）</span>
        <span class="floor-tab-advisor">担当: ${escapeHtml(advName)}</span>
      `;
      btn.addEventListener("click", () => {
        currentFloor = floor;
        const floorStaff = store.getStaffByFloor(currentFloor);
        currentStaffId = floorStaff.length > 0 ? floorStaff[0].id : null;
        renderFloorTabs();
        renderStaffList();
        renderEvaluationSheet();
      });
      floorTabsContainer.appendChild(btn);
    });
  }

  // ----------------------------------------------------
  // 3. スタッフリストの描画
  // ----------------------------------------------------
  function renderStaffList() {
    staffListContainer.innerHTML = "";
    const staffMembers = store.getStaffByFloor(currentFloor);

    if (staffMembers.length === 0) {
      staffListContainer.innerHTML = `
        <div style="text-align: center; padding: 2rem 1rem; color: var(--da-text-muted);">
          <p>このフロアに登録されたスタッフはいません。</p>
          <button class="btn btn-outline btn-sm" id="btn-add-first-staff" style="margin-top: 0.5rem;">＋ スタッフを登録</button>
        </div>
      `;
      document.getElementById("btn-add-first-staff")?.addEventListener("click", () => openStaffModal());
      return;
    }

    // 初回に選択スタッフが未設定または別フロアの場合、先頭スタッフを選択
    if (!currentStaffId || !staffMembers.find((s) => s.id === currentStaffId)) {
      currentStaffId = staffMembers[0].id;
    }

    staffMembers.forEach((staff) => {
      const prog = store.calcStaffProgress(staff.id);
      const isSelected = staff.id === currentStaffId;

      const card = document.createElement("div");
      card.className = `staff-card ${isSelected ? "active" : ""}`;
      card.innerHTML = `
        <div class="staff-card-header">
          <span class="staff-name">${escapeHtml(staff.name)}</span>
          <span class="role-badge ${staff.role}">${staff.role === "s_class" ? "Sクラス" : "一般"}</span>
        </div>
        <div class="progress-container">
          <div class="progress-bar-fill" style="width: ${prog.percent}%"></div>
        </div>
        <div class="progress-label">
          <span>進捗: ${prog.completed}/${prog.total} 項目</span>
          <span>${prog.percent}%</span>
        </div>
      `;

      card.addEventListener("click", () => {
        currentStaffId = staff.id;
        renderStaffList();
        renderEvaluationSheet();
      });

      staffListContainer.appendChild(card);
    });
  }

  // ----------------------------------------------------
  // 4. 評価シートの描画
  // ----------------------------------------------------
  function renderEvaluationSheet() {
    const staff = store.getStaffById(currentStaffId);
    if (!staff) {
      targetBanner.style.display = "none";
      evalAreaContainer.innerHTML = `
        <div style="background: white; border-radius: 12px; padding: 3rem; text-align: center; color: var(--da-text-muted);">
          <h2>評価対象スタッフを選択してください</h2>
          <p style="margin-top: 0.5rem;">左の一覧からスタッフを選択するか、「＋ スタッフ追加」から新規登録してください。</p>
        </div>
      `;
      return;
    }

    const prog = store.calcStaffProgress(staff.id);
    const advName = store.getAdvisorName(currentFloor);

    // 固定対象者バーの更新
    targetBanner.style.display = "flex";
    targetBanner.innerHTML = `
      <div class="target-info">
        <span class="target-floor-badge">${escapeHtml(staff.floor)}</span>
        <span class="target-name">${escapeHtml(staff.name)}</span>
        <span class="role-badge ${staff.role}">${staff.role === "s_class" ? "Sクラス (全項目対象)" : "一般スタッフ"}</span>
        <span class="target-meta">担当アドバイザー: <strong>${escapeHtml(advName)}</strong></span>
        <span class="target-meta">進捗率: <strong>${prog.percent}%</strong> (${prog.completed}/${prog.total})</span>
      </div>
      <div class="target-actions no-print">
        <button class="btn btn-outline btn-sm" id="btn-edit-staff">スタッフ情報編集</button>
        <button class="btn btn-primary btn-sm" id="btn-print-sheet">🖨️ A4印刷 / PDF</button>
      </div>
    `;

    document.getElementById("btn-edit-staff")?.addEventListener("click", () => openStaffModal(staff));
    document.getElementById("btn-print-sheet")?.addEventListener("click", () => window.print());

    // 大項目・中項目の描画
    evalAreaContainer.innerHTML = "";

    master.forEach((cat, catIdx) => {
      // Sクラス限定項目の判定（Ⅲ. 指導育成）
      if (cat.id === "cat_3" && staff.role !== "s_class") {
        return; // 一般スタッフには表示しない
      }

      const catBlock = document.createElement("div");
      catBlock.className = "category-block";

      const catHeader = document.createElement("div");
      catHeader.className = "category-header";
      catHeader.innerHTML = `
        <span>${escapeHtml(cat.title)}</span>
        <span class="accordion-icon" style="font-size: 0.85rem; color: var(--da-text-muted);">▼</span>
      `;

      const catBody = document.createElement("div");
      catBody.className = "category-body";

      cat.subcategories.forEach((subcat) => {
        // サブカテゴリータイトル（入浴介助、食事介助など）
        if (subcat.title && subcat.title !== cat.title) {
          const subTitle = document.createElement("div");
          subTitle.className = "subcat-title";
          subTitle.textContent = subcat.title;
          catBody.appendChild(subTitle);
        }

        // 中項目リスト
        subcat.mid_items.forEach((mid) => {
          const ev = store.getEvaluation(staff.id, mid.id);
          const checkedCps = new Set(ev.checks_json || []);

          const card = document.createElement("div");
          card.className = "mid-item-card";
          card.id = `card-${mid.id}`;

          // カード上部: タイトル & 評価ボタングループ
          const header = document.createElement("div");
          header.className = "mid-item-header";
          header.innerHTML = `
            <div class="mid-item-title">${escapeHtml(mid.title)}</div>
            <div class="eval-button-groups no-print">
              <!-- 〇・×評価ボタン -->
              <div class="eval-btn-group" title="チェック評価">
                <button type="button" class="eval-btn ${ev.check_eval === "circle" ? "active" : ""}" data-val="circle">〇</button>
                <button type="button" class="eval-btn ${ev.check_eval === "cross" ? "active" : ""}" data-val="cross">×</button>
              </div>

              <!-- A・B・C・―小項目ボタン -->
              <div class="eval-btn-group" title="小項目評価">
                <button type="button" class="eval-btn ${ev.score === "A" ? "active" : ""}" data-val="A">A</button>
                <button type="button" class="eval-btn ${ev.score === "B" ? "active" : ""}" data-val="B">B</button>
                <button type="button" class="eval-btn ${ev.score === "C" ? "active" : ""}" data-val="C">C</button>
                <button type="button" class="eval-btn ${ev.score === "hyphen" ? "active" : ""}" data-val="hyphen">―</button>
              </div>
            </div>
          `;

          // ボタンクリックイベント設定
          header.querySelectorAll(".eval-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
              const val = btn.dataset.val;
              if (val === "circle" || val === "cross") {
                const newVal = ev.check_eval === val ? "" : val; // トグル解除対応
                store.saveEvaluation(staff.id, mid.id, { check_eval: newVal });
              } else {
                const newVal = ev.score === val ? "" : val;
                store.saveEvaluation(staff.id, mid.id, { score: newVal });
              }
              // ボタンのactive表示切り替え
              const group = btn.closest(".eval-btn-group");
              group.querySelectorAll(".eval-btn").forEach((b) => b.classList.remove("active"));
              const currentEv = store.getEvaluation(staff.id, mid.id);
              if (val === "circle" || val === "cross") {
                if (currentEv.check_eval) group.querySelector(`[data-val="${currentEv.check_eval}"]`)?.classList.add("active");
              } else {
                if (currentEv.score) group.querySelector(`[data-val="${currentEv.score}"]`)?.classList.add("active");
              }
              updateProgressUI(staff.id);
            });
          });

          card.appendChild(header);

          // 点検項目（根拠チェックボックス）
          if (mid.checkpoints && mid.checkpoints.length > 0) {
            const cpContainer = document.createElement("div");
            cpContainer.className = "checkpoints-list";

            mid.checkpoints.forEach((cp) => {
              const isChecked = checkedCps.has(cp.id);
              const cpRow = document.createElement("label");
              cpRow.className = "checkpoint-row";

              const subChecksHtml =
                cp.sub_checks && cp.sub_checks.length > 0
                  ? `<ul class="checkpoint-subchecks">${cp.sub_checks.map((sc) => `<li>${escapeHtml(sc)}</li>`).join("")}</ul>`
                  : "";

              cpRow.innerHTML = `
                <input type="checkbox" class="checkpoint-checkbox" ${isChecked ? "checked" : ""} data-cp-id="${cp.id}">
                <div class="checkpoint-body">
                  <div class="checkpoint-main"><strong>${escapeHtml(cp.num)}</strong> ${escapeHtml(cp.text)}</div>
                  ${subChecksHtml}
                </div>
              `;

              const checkbox = cpRow.querySelector(".checkpoint-checkbox");
              checkbox.addEventListener("change", () => {
                const currentRecord = store.getEvaluation(staff.id, mid.id);
                const currentSet = new Set(currentRecord.checks_json || []);
                if (checkbox.checked) {
                  currentSet.add(cp.id);
                } else {
                  currentSet.delete(cp.id);
                }
                store.saveEvaluation(staff.id, mid.id, { checks_json: Array.from(currentSet) });
              });

              cpContainer.appendChild(cpRow);
            });

            card.appendChild(cpContainer);
          }

          // 自由記載欄
          const memoBox = document.createElement("div");
          memoBox.className = "memo-box";
          memoBox.innerHTML = `
            <textarea class="memo-input" placeholder="【自由記載欄】指導事項、気づき、具体的エビデンスなど（入力と同時に自動保存）">${escapeHtml(ev.memo || "")}</textarea>
          `;

          const memoInput = memoBox.querySelector(".memo-input");
          let memoTimeout = null;
          memoInput.addEventListener("input", () => {
            if (memoTimeout) clearTimeout(memoTimeout);
            memoTimeout = setTimeout(() => {
              store.saveEvaluation(staff.id, mid.id, { memo: memoInput.value });
            }, 500);
          });

          card.appendChild(memoBox);
          catBody.appendChild(card);
        });
      });

      // アコーディオン開閉
      catHeader.addEventListener("click", () => {
        const isCollapsed = catBody.style.display === "none";
        catBody.style.display = isCollapsed ? "block" : "none";
        catHeader.querySelector(".accordion-icon").textContent = isCollapsed ? "▼" : "▲";
      });

      catBlock.appendChild(catHeader);
      catBlock.appendChild(catBody);
      evalAreaContainer.appendChild(catBlock);
    });
  }

  // 進捗状況のUI部分更新（全再描画せずにサクサク更新）
  function updateProgressUI(staffId) {
    const prog = store.calcStaffProgress(staffId);
    const staffMembers = store.getStaffByFloor(currentFloor);
    const staff = staffMembers.find((s) => s.id === staffId);
    if (!staff) return;

    // サイドバーのカード更新
    renderStaffList();

    // 固定ヘッダーの進捗率更新
    const targetMetaProg = targetBanner.querySelectorAll(".target-meta")[1];
    if (targetMetaProg) {
      targetMetaProg.innerHTML = `進捗率: <strong>${prog.percent}%</strong> (${prog.completed}/${prog.total})`;
    }

    // フロアタブの件数更新
    renderFloorTabs();
  }

  // ----------------------------------------------------
  // 5. モーダル制御（スタッフ追加・編集 / アドバイザー名変更）
  // ----------------------------------------------------
  function openStaffModal(staff = null) {
    staffForm.reset();
    document.getElementById("staff-modal-title").textContent = staff ? "スタッフ情報編集" : "新規スタッフ追加";
    document.getElementById("staff-id").value = staff ? staff.id : `staff_${currentFloor.toLowerCase()}_${Date.now()}`;
    document.getElementById("staff-floor").value = staff ? staff.floor : currentFloor;
    document.getElementById("staff-name").value = staff ? staff.name : "";
    document.getElementById("staff-role").value = staff ? staff.role : "general";

    const deleteBtn = document.getElementById("btn-delete-staff");
    if (deleteBtn) {
      deleteBtn.style.display = staff ? "inline-flex" : "none";
      deleteBtn.onclick = () => {
        if (confirm(`本当に「${staff.name}」の登録および評価データを削除しますか？`)) {
          store.deleteStaff(staff.id);
          closeStaffModal();
        }
      };
    }

    staffModal.classList.add("active");
  }

  function closeStaffModal() {
    staffModal.classList.remove("active");
  }

  staffForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("staff-id").value;
    const floor = document.getElementById("staff-floor").value;
    const name = document.getElementById("staff-name").value.trim();
    const role = document.getElementById("staff-role").value;

    if (!name) {
      alert("氏名を入力してください");
      return;
    }

    store.saveStaff({ id, floor, name, role });
    currentStaffId = id;
    closeStaffModal();
  });

  document.getElementById("btn-cancel-staff")?.addEventListener("click", closeStaffModal);

  // アドバイザー編集モーダル
  function openAdvisorModal() {
    advisorForm.reset();
    document.getElementById("adv-2f").value = store.getAdvisorName("2F");
    document.getElementById("adv-3f").value = store.getAdvisorName("3F");
    document.getElementById("adv-4f").value = store.getAdvisorName("4F");
    document.getElementById("adv-5f").value = store.getAdvisorName("5F");
    advisorModal.classList.add("active");
  }

  function closeAdvisorModal() {
    advisorModal.classList.remove("active");
  }

  advisorForm.addEventListener("submit", (e) => {
    e.preventDefault();
    store.setAdvisorName("2F", document.getElementById("adv-2f").value.trim() || "2F担当アドバイザー");
    store.setAdvisorName("3F", document.getElementById("adv-3f").value.trim() || "3F担当アドバイザー");
    store.setAdvisorName("4F", document.getElementById("adv-4f").value.trim() || "4F担当アドバイザー");
    store.setAdvisorName("5F", document.getElementById("adv-5f").value.trim() || "5F担当アドバイザー");
    closeAdvisorModal();
    renderFloorTabs();
    renderEvaluationSheet();
  });

  document.getElementById("btn-cancel-advisor")?.addEventListener("click", closeAdvisorModal);
  document.getElementById("btn-open-advisor-modal")?.addEventListener("click", openAdvisorModal);
  document.getElementById("btn-add-staff")?.addEventListener("click", () => openStaffModal());

  // ----------------------------------------------------
  // 6. JSONバックアップ / エクスポート
  // ----------------------------------------------------
  document.getElementById("btn-export-json")?.addEventListener("click", () => {
    const jsonStr = JSON.stringify(store.data, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `テクニカルシート評価データ_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("file-import-json")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const imported = JSON.parse(evt.target.result);
        if (imported.staff && imported.evaluations) {
          if (confirm("インポートしたデータで現在のデータを上書き統合しますか？")) {
            store.data = { ...store.data, ...imported };
            store.saveToLocal();
            renderFloorTabs();
            renderStaffList();
            renderEvaluationSheet();
            alert("データをインポートしました！");
          }
        } else {
          alert("不正なデータ形式です。");
        }
      } catch (err) {
        alert("JSONファイルの解析に失敗しました: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  // ----------------------------------------------------
  // 7. ストア変更通知のハンドリング（他端末更新のリアルタイム反映）
  // ----------------------------------------------------
  store.subscribe((event, payload) => {
    if (event === "sync_status_changed") {
      updateSyncStatus(payload);
    } else if (event === "data_updated" || event === "staff_changed" || event === "advisor_changed") {
      renderFloorTabs();
      renderStaffList();
      renderEvaluationSheet();
    }
  });

  // ユーティリティ
  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ----------------------------------------------------
  // 初期描画 & クラウドリアルタイム同期開始
  // ----------------------------------------------------
  renderFloorTabs();
  renderStaffList();
  renderEvaluationSheet();
  store.startRealtimeSync();
});
