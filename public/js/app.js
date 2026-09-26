/**
 * テクニカルシート評価システム: アプリケーションUI制御
 * デジタル庁デザインシステム準拠 & モバイル/iPad/PCレスポンシブ
 * ※評価対象は一般介護スタッフ専用（リーダー評価なし）
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
  // 3. スタッフリストの描画（介護スタッフ専用）
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
          <span class="role-badge general">介護スタッフ</span>
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
  // 4. 評価シートの描画（全21中項目）
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
        <span class="target-meta">担当アドバイザー: <strong>${escapeHtml(advName)}</strong></span>
        <span class="target-meta">進捗率: <strong>${prog.percent}%</strong> (${prog.completed}/${prog.total} 項目)</span>
      </div>
      <div class="target-actions no-print">
        <button class="btn btn-outline btn-sm" id="btn-edit-staff">スタッフ名変更</button>
        <button class="btn btn-primary btn-sm" id="btn-print-sheet">🖨️ A4印刷 / PDF</button>
      </div>
    `;

    document.getElementById("btn-edit-staff")?.addEventListener("click", () => openStaffModal(staff));
    document.getElementById("btn-print-sheet")?.addEventListener("click", () => window.print());

    // 大項目・中項目の描画
    evalAreaContainer.innerHTML = "";

    master.forEach((cat) => {
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
        if (subcat.title && subcat.title !== cat.title) {
          const subTitle = document.createElement("div");
          subTitle.className = "subcat-title";
          subTitle.textContent = subcat.title;
          catBody.appendChild(subTitle);
        }

        subcat.mid_items.forEach((mid) => {
          const ev = store.getEvaluation(staff.id, mid.id);
          const checkedCps = new Set(ev.checks_json || []);

          // 中項目配下の全小項目ID（判定基準）を算出
          const allItemCheckIds = [];
          if (mid.checkpoints) {
            mid.checkpoints.forEach((cp) => {
              if (cp.sub_checks && cp.sub_checks.length > 0) {
                cp.sub_checks.forEach((_, idx) => allItemCheckIds.push(`${cp.id}_sc_${idx}`));
              } else {
                allItemCheckIds.push(cp.id);
              }
            });
          }

          // 小項目の埋まり具合から 〇・× を自動判定する関数
          function calcAutoCheckEval(checksSet) {
            if (allItemCheckIds.length === 0) return "";
            let checkedCount = 0;
            allItemCheckIds.forEach((id) => {
              if (checksSet.has(id)) checkedCount++;
            });
            if (checkedCount === 0) return ""; // 未チェック
            if (checkedCount === allItemCheckIds.length) return "circle"; // 全て埋まったら〇
            return "cross"; // 1つでも埋まらなければ×
          }

          // 現在の〇×状態（保存値またはチェックボックスから自動算出）
          let currentAutoEval = ev.check_eval || calcAutoCheckEval(checkedCps);

          const card = document.createElement("div");
          card.className = "mid-item-card";
          card.id = `card-${mid.id}`;

          const header = document.createElement("div");
          header.className = "mid-item-header";
          header.innerHTML = `
            <div class="mid-item-title">${escapeHtml(mid.title)}</div>
            <div class="eval-button-groups no-print">
              <!-- 〇× 自動判定バッジ -->
              <div class="auto-eval-container">
                <span class="eval-group-label">チェック評価:</span>
                <div class="auto-eval-badge ${currentAutoEval === "circle" ? "circle" : (currentAutoEval === "cross" ? "cross" : "")}" id="auto-badge-${mid.id}" title="小項目が埋まると自動判定（クリックで手動切替も可能）">
                  <span class="auto-eval-icon">${currentAutoEval === "circle" ? "〇" : (currentAutoEval === "cross" ? "×" : "―")}</span>
                  <span class="auto-eval-badge-sub">${currentAutoEval === "circle" ? "クリア" : (currentAutoEval === "cross" ? "未達あり" : "未判定")}</span>
                </div>
              </div>

              <!-- A・B・C・― 小項目評価ボタン（内容ラベル付き） -->
              <div class="score-eval-container">
                <span class="eval-group-label">小項目評価:</span>
                <div class="eval-btn-group">
                  <button type="button" class="eval-btn ${ev.score === "A" ? "active" : ""}" data-val="A" title="できる">
                    <span class="eval-btn-key">A</span>
                    <span class="eval-btn-desc">できる</span>
                  </button>
                  <button type="button" class="eval-btn ${ev.score === "B" ? "active" : ""}" data-val="B" title="指導を要する">
                    <span class="eval-btn-key">B</span>
                    <span class="eval-btn-desc">指導要</span>
                  </button>
                  <button type="button" class="eval-btn ${ev.score === "C" ? "active" : ""}" data-val="C" title="できない">
                    <span class="eval-btn-key">C</span>
                    <span class="eval-btn-desc">できない</span>
                  </button>
                  <button type="button" class="eval-btn ${ev.score === "hyphen" ? "active" : ""}" data-val="hyphen" title="対象外">
                    <span class="eval-btn-key">―</span>
                    <span class="eval-btn-desc">対象外</span>
                  </button>
                </div>
              </div>
            </div>
          `;

          // バッジUI更新ヘルパー
          function updateBadgeUI(evalVal) {
            const badge = header.querySelector(`#auto-badge-${mid.id}`);
            if (!badge) return;
            badge.className = `auto-eval-badge ${evalVal === "circle" ? "circle" : (evalVal === "cross" ? "cross" : "")}`;
            badge.querySelector(".auto-eval-icon").textContent = evalVal === "circle" ? "〇" : (evalVal === "cross" ? "×" : "―");
            badge.querySelector(".auto-eval-badge-sub").textContent = evalVal === "circle" ? "クリア" : (evalVal === "cross" ? "未達あり" : "未判定");
          }

          // バッジの手動クリック（必要時の手動オーバーライド対応）
          const autoBadgeEl = header.querySelector(`#auto-badge-${mid.id}`);
          autoBadgeEl.addEventListener("click", () => {
            const currentEv = store.getEvaluation(staff.id, mid.id);
            let nextVal = "";
            if (!currentEv.check_eval || currentEv.check_eval === "cross") {
              nextVal = "circle";
            } else if (currentEv.check_eval === "circle") {
              nextVal = "cross";
            }
            store.saveEvaluation(staff.id, mid.id, { check_eval: nextVal });
            updateBadgeUI(nextVal);
            updateProgressUI(staff.id);
          });

          // ABCボタンのクリックイベント
          header.querySelectorAll(".eval-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
              const val = btn.dataset.val;
              const currentEv = store.getEvaluation(staff.id, mid.id);
              const newVal = currentEv.score === val ? "" : val;
              store.saveEvaluation(staff.id, mid.id, { score: newVal });

              const group = btn.closest(".eval-btn-group");
              group.querySelectorAll(".eval-btn").forEach((b) => b.classList.remove("active"));
              if (newVal) group.querySelector(`[data-val="${newVal}"]`)?.classList.add("active");
              updateProgressUI(staff.id);
            });
          });

          card.appendChild(header);

          if (mid.checkpoints && mid.checkpoints.length > 0) {
            const cpContainer = document.createElement("div");
            cpContainer.className = "checkpoints-list";

            mid.checkpoints.forEach((cp) => {
              const cpGroup = document.createElement("div");
              cpGroup.className = "checkpoint-group";
              cpGroup.style.display = "flex";
              cpGroup.style.flexDirection = "column";
              cpGroup.style.gap = "0.35rem";

              const hasSubChecks = cp.sub_checks && cp.sub_checks.length > 0;
              const subCheckIds = hasSubChecks ? cp.sub_checks.map((_, idx) => `${cp.id}_sc_${idx}`) : [];

              const allSubsChecked = hasSubChecks && subCheckIds.every((scId) => checkedCps.has(scId));
              const isParentChecked = checkedCps.has(cp.id) || allSubsChecked;

              // 親の点検項目行
              const cpRow = document.createElement("label");
              cpRow.className = "checkpoint-row";
              cpRow.innerHTML = `
                <input type="checkbox" class="checkpoint-checkbox" ${isParentChecked ? "checked" : ""} data-cp-id="${cp.id}">
                <div class="checkpoint-body">
                  <div class="checkpoint-main"><strong>${escapeHtml(cp.num)}</strong> ${escapeHtml(cp.text)}</div>
                </div>
              `;

              const parentCheckbox = cpRow.querySelector(".checkpoint-checkbox");
              let subCheckboxes = [];
              let subContainer = null;

              if (hasSubChecks) {
                subContainer = document.createElement("div");
                subContainer.className = "checkpoint-subchecks";

                cp.sub_checks.forEach((sc, scIdx) => {
                  const scId = `${cp.id}_sc_${scIdx}`;
                  const isScChecked = checkedCps.has(scId) || isParentChecked;

                  const scRow = document.createElement("label");
                  scRow.className = "subcheck-row";
                  scRow.innerHTML = `
                    <input type="checkbox" class="subcheck-checkbox" ${isScChecked ? "checked" : ""} data-sc-id="${scId}">
                    <span class="subcheck-text">${escapeHtml(sc)}</span>
                  `;

                  const scCheckbox = scRow.querySelector(".subcheck-checkbox");
                  subCheckboxes.push({ id: scId, el: scCheckbox });

                  // 小項目チェック変更時：自動〇×判定連動
                  scCheckbox.addEventListener("change", () => {
                    const currentRecord = store.getEvaluation(staff.id, mid.id);
                    const currentSet = new Set(currentRecord.checks_json || []);

                    if (scCheckbox.checked) {
                      currentSet.add(scId);
                    } else {
                      currentSet.delete(scId);
                      currentSet.delete(cp.id);
                      parentCheckbox.checked = false;
                    }

                    const allNowChecked = subCheckIds.every((id) => currentSet.has(id));
                    if (allNowChecked) {
                      currentSet.add(cp.id);
                      parentCheckbox.checked = true;
                    }

                    // 埋まり具合から 〇・× を自動判定
                    const autoResult = calcAutoCheckEval(currentSet);
                    store.saveEvaluation(staff.id, mid.id, {
                      checks_json: Array.from(currentSet),
                      check_eval: autoResult,
                    });
                    updateBadgeUI(autoResult);
                    updateProgressUI(staff.id);
                  });

                  subContainer.appendChild(scRow);
                });
              }

              // 親チェック変更時（配下の小項目と全連動 & 〇×自動判定）
              parentCheckbox.addEventListener("change", () => {
                const currentRecord = store.getEvaluation(staff.id, mid.id);
                const currentSet = new Set(currentRecord.checks_json || []);

                if (parentCheckbox.checked) {
                  currentSet.add(cp.id);
                  subCheckboxes.forEach((sc) => {
                    sc.el.checked = true;
                    currentSet.add(sc.id);
                  });
                } else {
                  currentSet.delete(cp.id);
                  subCheckboxes.forEach((sc) => {
                    sc.el.checked = false;
                    currentSet.delete(sc.id);
                  });
                }

                // 埋まり具合から 〇・× を自動判定
                const autoResult = calcAutoCheckEval(currentSet);
                store.saveEvaluation(staff.id, mid.id, {
                  checks_json: Array.from(currentSet),
                  check_eval: autoResult,
                });
                updateBadgeUI(autoResult);
                updateProgressUI(staff.id);
              });

              cpGroup.appendChild(cpRow);
              if (subContainer) cpGroup.appendChild(subContainer);
              cpContainer.appendChild(cpGroup);
            });

            card.appendChild(cpContainer);
          }

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

  function updateProgressUI(staffId) {
    const prog = store.calcStaffProgress(staffId);
    renderStaffList();

    const targetMetaProg = targetBanner.querySelectorAll(".target-meta")[1];
    if (targetMetaProg) {
      targetMetaProg.innerHTML = `進捗率: <strong>${prog.percent}%</strong> (${prog.completed}/${prog.total} 項目)`;
    }

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

    if (!name) {
      alert("氏名を入力してください");
      return;
    }

    store.saveStaff({ id, floor, name, role: "general" });
    currentStaffId = id;
    closeStaffModal();
  });

  document.getElementById("btn-cancel-staff")?.addEventListener("click", closeStaffModal);

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
  // 7. ストア変更通知のハンドリング
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

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // 初期化
  renderFloorTabs();
  renderStaffList();
  renderEvaluationSheet();
  store.startRealtimeSync();
});
