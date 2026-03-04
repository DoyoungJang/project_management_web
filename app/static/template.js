const DEFAULT_STAGES = [
  { key: "data_acquisition", name: "1. 데이터 획득" },
  { key: "labeling", name: "2. 라벨링" },
  { key: "development", name: "3. 개발" },
];

const els = {
  createForm: document.getElementById("template-create-form"),
  exportAllBtn: document.getElementById("export-all-btn"),
  exportSelectedBtn: document.getElementById("export-selected-btn"),
  restoreFileInput: document.getElementById("restore-file-input"),
  restoreFileName: document.getElementById("restore-file-name"),
  restoreModeSelect: document.getElementById("restore-mode-select"),
  restoreBtn: document.getElementById("restore-btn"),
  listSelectAll: document.getElementById("template-list-select-all"),
  listSelectedCount: document.getElementById("template-list-selected-count"),
  listDeleteSelectedBtn: document.getElementById("template-delete-selected-btn"),
  list: document.getElementById("template-list"),
  detailPanel: document.getElementById("template-detail-panel"),
  updateForm: document.getElementById("template-update-form"),
  deleteBtn: document.getElementById("template-delete-btn"),
  stageCreateForm: document.getElementById("template-stage-create-form"),
  stageNameInput: document.getElementById("template-stage-name-input"),
  stageList: document.getElementById("template-stage-list"),
  stageContainer: document.getElementById("template-stage-container"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
};

const { createApiClient, escapeHtml, parseApiError } = window.PMCommon;
const api = createApiClient();

let templates = [];
let selectedTemplateId = null;
let selectedTemplateStages = [];
let selectedTemplateItems = [];
let selectedForBulkDelete = new Set();
let isDirty = false;

function markDirty() {
  isDirty = true;
}

function clearDirty() {
  isDirty = false;
}

function normalizeStageKey(name) {
  const key = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "stage";
}

function nextUniqueStageKey(stageName) {
  const base = normalizeStageKey(stageName);
  const existing = new Set(selectedTemplateStages.map((x) => String(x.stage_key)));
  if (!existing.has(base)) return base;
  let idx = 2;
  while (existing.has(`${base}_${idx}`)) idx += 1;
  return `${base}_${idx}`;
}

function sortAndNormalizeStagePositions() {
  selectedTemplateStages = selectedTemplateStages
    .slice()
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map((stage, idx) => ({
      ...stage,
      position: idx,
      stage_key: String(stage.stage_key || "").trim(),
      stage_name: String(stage.stage_name || "").trim(),
    }))
    .filter((stage) => stage.stage_key && stage.stage_name);
}

function normalizeItemPositionsByStage() {
  const stageKeys = selectedTemplateStages.map((x) => x.stage_key);
  selectedTemplateItems = selectedTemplateItems.filter((item) => stageKeys.includes(item.stage));
  for (const stageKey of stageKeys) {
    const rows = selectedTemplateItems
      .filter((x) => x.stage === stageKey)
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    rows.forEach((row, idx) => {
      row.position = idx;
    });
  }
}

function ensureMissingStagesFromItems() {
  const existingKeys = new Set(selectedTemplateStages.map((x) => x.stage_key));
  for (const item of selectedTemplateItems) {
    const stageKey = String(item.stage || "").trim();
    if (!stageKey || existingKeys.has(stageKey)) continue;
    selectedTemplateStages.push({
      id: null,
      template_id: selectedTemplateId,
      stage_key: stageKey,
      stage_name: stageKey,
      position: selectedTemplateStages.length,
    });
    existingKeys.add(stageKey);
  }
}

function normalizeTemplateEditorState() {
  if (!selectedTemplateStages.length) {
    selectedTemplateStages = DEFAULT_STAGES.map((stage, idx) => ({
      id: null,
      template_id: selectedTemplateId,
      stage_key: stage.key,
      stage_name: stage.name,
      position: idx,
    }));
  }
  ensureMissingStagesFromItems();
  sortAndNormalizeStagePositions();
  normalizeItemPositionsByStage();
}

function stageLabel(stageKey) {
  const stage = selectedTemplateStages.find((x) => x.stage_key === stageKey);
  return stage ? stage.stage_name : stageKey;
}

function updateExportSelectedState() {
  if (!els.exportSelectedBtn) return;
  els.exportSelectedBtn.disabled = false;
}

function updateRestoreFileState() {
  const file = els.restoreFileInput?.files?.[0] || null;
  if (els.restoreBtn) els.restoreBtn.disabled = !file;
  if (els.restoreFileName) {
    els.restoreFileName.textContent = file ? `선택 파일: ${file.name}` : "선택된 파일 없음";
  }
}

function updateBulkDeleteState() {
  const total = templates.length;
  const selectedCount = selectedForBulkDelete.size;

  if (els.listSelectedCount) {
    els.listSelectedCount.textContent = `${selectedCount}개 선택`;
  }
  if (els.listDeleteSelectedBtn) {
    els.listDeleteSelectedBtn.disabled = selectedCount === 0;
  }
  if (els.listSelectAll) {
    els.listSelectAll.checked = total > 0 && selectedCount === total;
    els.listSelectAll.indeterminate = selectedCount > 0 && selectedCount < total;
  }
}

function normalizeTemplateItems(items, stages) {
  const stageOrder = new Map(
    (Array.isArray(stages) ? stages : []).map((x) => [String(x.key || x.stage_key), Number(x.position || 0)])
  );
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const stage = String(item.stage || "").trim();
    const content = String(item.content || "").trim();
    if (!stage || !content) continue;
    if (!grouped.has(stage)) grouped.set(stage, []);
    grouped.get(stage).push({
      stage,
      content,
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
    });
  }

  const orderedStageKeys = Array.from(grouped.keys()).sort((a, b) => {
    const ao = stageOrder.has(a) ? stageOrder.get(a) : 999999;
    const bo = stageOrder.has(b) ? stageOrder.get(b) : 999999;
    return ao - bo || String(a).localeCompare(String(b));
  });

  const out = [];
  for (const stageKey of orderedStageKeys) {
    const rows = grouped.get(stageKey).sort((a, b) => a.position - b.position);
    rows.forEach((row, idx) => {
      out.push({
        stage: row.stage,
        content: row.content,
        position: idx,
      });
    });
  }
  return out;
}

function normalizeTemplateStages(stages, items) {
  const out = [];
  const keySet = new Set();
  const sortedStages = (Array.isArray(stages) ? stages : [])
    .slice()
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));

  for (const stage of sortedStages) {
    const key = String(stage.key || stage.stage_key || "").trim();
    const name = String(stage.name || stage.stage_name || "").trim();
    if (!key || !name || keySet.has(key)) continue;
    keySet.add(key);
    out.push({ key, name, position: out.length });
  }

  for (const item of Array.isArray(items) ? items : []) {
    const key = String(item.stage || "").trim();
    if (!key || keySet.has(key)) continue;
    keySet.add(key);
    out.push({ key, name: key, position: out.length });
  }

  if (!out.length) {
    return DEFAULT_STAGES.map((stage, idx) => ({ key: stage.key, name: stage.name, position: idx }));
  }
  return out;
}

function shouldFallbackExportApi(error) {
  const message = String(parseApiError(error) || "").toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("method not allowed") ||
    message.includes("404") ||
    message.includes("405")
  );
}

function shouldFallbackRestoreApi(error) {
  const message = String(parseApiError(error) || "").toLowerCase();
  return (
    message.includes("not found") ||
    message.includes("method not allowed") ||
    message.includes("404") ||
    message.includes("405")
  );
}

async function buildAllTemplatesExportByClient() {
  const allTemplates = await api.get("/api/templates");
  const templatePayloads = await Promise.all(
    allTemplates.map(async (tpl) => {
      const [stages, items] = await Promise.all([
        api.get(`/api/templates/${tpl.id}/stages`),
        api.get(`/api/templates/${tpl.id}/items`),
      ]);
      const normalizedStages = normalizeTemplateStages(stages, items);
      return {
        id: Number(tpl.id),
        name: tpl.name,
        description: tpl.description || "",
        creator_name: tpl.creator_name || "",
        stages: normalizedStages,
        items: normalizeTemplateItems(items, normalizedStages),
      };
    })
  );
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    templates: templatePayloads,
  };
}

async function restoreTemplatesByClient(parsed, mode) {
  const existingTemplates = await api.get("/api/templates");
  const byName = new Map(existingTemplates.map((x) => [String(x.name || "").trim(), x]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const failed = [];

  for (const incoming of parsed.templates) {
    const name = String(incoming.name || "").trim();
    const description = String(incoming.description || "").trim();
    const stages = normalizeTemplateStages(incoming.stages || [], incoming.items || []);
    const items = normalizeTemplateItems(incoming.items || [], stages);
    const existing = byName.get(name);

    if (existing) {
      if (mode === "skip") {
        skipped += 1;
        continue;
      }

      try {
        await api.patch(`/api/templates/${existing.id}`, { name, description });
        await api.put(`/api/templates/${existing.id}/stages`, { stages });
        await api.put(`/api/templates/${existing.id}/items`, { items });
        updated += 1;
      } catch (err) {
        failed.push({ name, reason: parseApiError(err) });
      }
      continue;
    }

    try {
      const createdTemplate = await api.post("/api/templates", { name, description });
      await api.put(`/api/templates/${createdTemplate.id}/stages`, { stages });
      await api.put(`/api/templates/${createdTemplate.id}/items`, { items });
      byName.set(name, createdTemplate);
      created += 1;
    } catch (err) {
      failed.push({ name, reason: parseApiError(err) });
    }
  }

  return { ok: true, created, updated, skipped, failed };
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function exportAllTemplates() {
  let payload;
  try {
    payload = await api.get("/api/template-export");
  } catch (err) {
    if (!shouldFallbackExportApi(err)) throw err;
    try {
      payload = await api.get("/api/templates/export");
    } catch (legacyErr) {
      if (!shouldFallbackExportApi(legacyErr)) throw legacyErr;
      payload = await buildAllTemplatesExportByClient();
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadJson(payload, `templates_export_${stamp}.json`);
}

async function readRestoreFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("유효한 JSON 객체가 아닙니다.");
  }

  let templatesData = [];
  if (Array.isArray(parsed.templates)) {
    templatesData = parsed.templates;
  } else if (Array.isArray(parsed)) {
    templatesData = parsed;
  }

  if (!templatesData.length) {
    throw new Error("복원할 템플릿 데이터가 없습니다.");
  }

  return {
    templates: templatesData.map((tpl) => {
      const stages = normalizeTemplateStages(tpl.stages || [], tpl.items || []);
      return {
        name: String(tpl.name || "").trim(),
        description: String(tpl.description || "").trim(),
        stages,
        items: normalizeTemplateItems(tpl.items || [], stages),
      };
    }),
  };
}

async function handleRestoreTemplates() {
  const file = els.restoreFileInput?.files?.[0];
  if (!file) {
    alert("복원할 JSON 파일을 선택해 주세요.");
    return;
  }

  try {
    if (els.restoreBtn) {
      els.restoreBtn.disabled = true;
      els.restoreBtn.textContent = "복원 중...";
    }
    const parsed = await readRestoreFile(file);
    const mode = String(els.restoreModeSelect?.value || "overwrite");
    let result;
    try {
      result = await api.post("/api/templates/restore", {
        mode,
        templates: parsed.templates,
      });
    } catch (restoreErr) {
      if (!shouldFallbackRestoreApi(restoreErr)) throw restoreErr;
      result = await restoreTemplatesByClient(parsed, mode);
    }

    const failedRows = Array.isArray(result.failed) ? result.failed : [];
    const failedMessage = failedRows.length
      ? `\n실패: ${failedRows.map((x) => `${x.name}(${x.reason})`).join(", ")}`
      : "";
    alert(
      `Restore 완료\n생성: ${result.created || 0}, 업데이트: ${result.updated || 0}, 건너뜀: ${
        result.skipped || 0
      }${failedMessage}`
    );

    if (els.restoreFileInput) els.restoreFileInput.value = "";
    updateRestoreFileState();
    await loadTemplates();
    if (selectedTemplateId) {
      const exists = templates.find((x) => Number(x.id) === Number(selectedTemplateId));
      if (exists) await selectTemplate(selectedTemplateId);
    }
  } catch (err) {
    alert(`Restore 실패: ${parseApiError(err)}`);
  } finally {
    if (els.restoreBtn) {
      els.restoreBtn.textContent = "복원 실행";
    }
    updateRestoreFileState();
  }
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function loadTemplates() {
  templates = await api.get("/api/templates");
  const validIdSet = new Set(templates.map((t) => Number(t.id)));
  selectedForBulkDelete = new Set(Array.from(selectedForBulkDelete).filter((id) => validIdSet.has(Number(id))));
  renderTemplateList();

  if (selectedTemplateId !== null && !templates.find((t) => Number(t.id) === Number(selectedTemplateId))) {
    selectedTemplateId = null;
    selectedTemplateStages = [];
    selectedTemplateItems = [];
    els.detailPanel.classList.add("hidden");
  }
  updateExportSelectedState();
  updateBulkDeleteState();
}

function renderTemplateList() {
  if (templates.length === 0) {
    els.list.innerHTML = "<div class='item'>사용 가능한 템플릿이 없습니다.</div>";
    return;
  }

  els.list.innerHTML = templates
    .map(
      (tpl) => `
      <article class="item ${Number(tpl.id) === Number(selectedTemplateId) ? "is-selected" : ""}" data-template-item="${tpl.id}">
        <div class="item__head">
          <div class="actions">
            <input
              type="checkbox"
              data-template-bulk-select="${tpl.id}"
              ${selectedForBulkDelete.has(Number(tpl.id)) ? "checked" : ""}
            />
            <strong>${escapeHtml(tpl.name)}</strong>
          </div>
          <span class="badge">${escapeHtml(tpl.creator_name || "")}</span>
        </div>
        <div class="item__meta">${escapeHtml(tpl.description || "-")}</div>
        <div class="actions">
          <button data-select-template="${tpl.id}">${
            Number(tpl.id) === Number(selectedTemplateId) ? "선택됨" : "선택"
          }</button>
        </div>
      </article>
    `
    )
    .join("");
  updateBulkDeleteState();
}

function renderStageManager() {
  if (!els.stageList) return;
  if (!selectedTemplateStages.length) {
    els.stageList.innerHTML = "<div class='item stage-manager-item'>등록된 대항목이 없습니다.</div>";
    return;
  }
  els.stageList.innerHTML = selectedTemplateStages
    .map(
      (stage, idx) => `
      <div class="item stage-manager-item">
        <div class="item__head">
          <div class="stage-manager-title">
            <span class="stage-manager-index">${idx + 1}</span>
            <strong>${escapeHtml(stage.stage_name)}</strong>
          </div>
          <span class="badge stage-key-badge">${escapeHtml(stage.stage_key)}</span>
        </div>
        <div class="actions stage-manager-actions">
          <button type="button" data-edit-stage="${escapeHtml(stage.stage_key)}">이름 변경</button>
          <button type="button" class="danger" data-delete-stage="${escapeHtml(stage.stage_key)}">삭제</button>
        </div>
      </div>
    `
    )
    .join("");
}

function renderSelectedTemplateDetail() {
  if (!els.stageContainer) return;
  if (!selectedTemplateStages.length) {
    els.stageContainer.innerHTML = "<div class='item'>대항목을 먼저 추가해 주세요.</div>";
    return;
  }
  els.stageContainer.innerHTML = selectedTemplateStages.map((stage) => renderStage(stage)).join("");
}

function renderStage(stage) {
  const items = selectedTemplateItems
    .filter((x) => x.stage === stage.stage_key)
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));

  const listHtml =
    items.length === 0
      ? "<div class='item__meta'>작업 항목이 없습니다.</div>"
      : items
          .map(
            (item) => `
          <div class="check-item read-only">
            <span>${escapeHtml(item.content)}</span>
            <div class="actions">
              <button type="button" data-edit-item="${stage.stage_key}::${item.position}">이름 변경</button>
              <button type="button" class="danger check-del" data-del-item="${item.position}" data-del-stage="${
                stage.stage_key
              }">삭제</button>
            </div>
          </div>
        `
          )
          .join("");

  return `
    <article class="stage work-stage">
      <div class="work-stage__head">
        <h3>${escapeHtml(stage.stage_name)}</h3>
        <span class="badge">${items.length}개</span>
      </div>
      <div class="check-list">${listHtml}</div>
      <form class="check-form work-check-form" data-stage-form="${stage.stage_key}">
        <input name="content" placeholder="작업 항목 입력" required minlength="1" maxlength="200" />
        <button type="submit">추가</button>
      </form>
    </article>
  `;
}

function refreshTemplateEditorView() {
  normalizeTemplateEditorState();
  renderStageManager();
  renderSelectedTemplateDetail();
}

async function deleteSelectedTemplates() {
  const ids = Array.from(selectedForBulkDelete).map((x) => Number(x));
  if (!ids.length) return;
  if (!confirm(`선택한 템플릿 ${ids.length}개를 삭제할까요?`)) return;

  let success = 0;
  let failed = 0;
  const failures = [];
  for (const id of ids) {
    try {
      await api.del(`/api/templates/${id}`);
      success += 1;
    } catch (err) {
      failed += 1;
      failures.push(`#${id}: ${parseApiError(err)}`);
    }
  }

  const removedSelectedTemplate = ids.includes(Number(selectedTemplateId));
  selectedForBulkDelete.clear();
  if (removedSelectedTemplate) {
    selectedTemplateId = null;
    selectedTemplateStages = [];
    selectedTemplateItems = [];
    els.detailPanel.classList.add("hidden");
  }
  await loadTemplates();

  if (failed === 0) {
    alert(`선택 템플릿 ${success}개를 삭제했습니다.`);
  } else {
    alert(
      `삭제 완료: 성공 ${success}개 / 실패 ${failed}개\n${failures.slice(0, 5).join("\n")}${
        failures.length > 5 ? "\n..." : ""
      }`
    );
  }
}

async function selectTemplate(templateId) {
  if (isDirty) {
    const ok = confirm("저장되지 않은 변경사항이 있습니다. 버리고 이동할까요?");
    if (!ok) return;
  }

  selectedTemplateId = Number(templateId);
  const selected = templates.find((t) => Number(t.id) === Number(selectedTemplateId));
  if (!selected) return;

  els.updateForm.elements.name.value = selected.name || "";
  els.updateForm.elements.description.value = selected.description || "";

  const [stages, items] = await Promise.all([
    api.get(`/api/templates/${selectedTemplateId}/stages`),
    api.get(`/api/templates/${selectedTemplateId}/items`),
  ]);
  selectedTemplateStages = (Array.isArray(stages) ? stages : []).map((x) => ({
    id: x.id ?? null,
    template_id: x.template_id ?? selectedTemplateId,
    stage_key: String(x.stage_key || "").trim(),
    stage_name: String(x.stage_name || "").trim(),
    position: Number(x.position || 0),
  }));
  selectedTemplateItems = (Array.isArray(items) ? items : []).map((x) => ({
    id: x.id ?? null,
    stage: String(x.stage || "").trim(),
    content: String(x.content || "").trim(),
    position: Number(x.position || 0),
  }));

  clearDirty();
  renderTemplateList();
  refreshTemplateEditorView();
  els.detailPanel.classList.remove("hidden");
  els.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  updateExportSelectedState();
}

function buildStageReplacePayload() {
  const stages = selectedTemplateStages
    .slice()
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map((stage, idx) => ({
      key: String(stage.stage_key || "").trim(),
      name: String(stage.stage_name || "").trim(),
      position: idx,
    }))
    .filter((stage) => stage.key && stage.name);

  if (!stages.length) {
    throw new Error("대항목은 최소 1개 이상 필요합니다.");
  }
  return { stages };
}

function buildItemReplacePayload() {
  normalizeItemPositionsByStage();
  const items = selectedTemplateItems
    .slice()
    .sort((a, b) => {
      const ao = selectedTemplateStages.findIndex((x) => x.stage_key === a.stage);
      const bo = selectedTemplateStages.findIndex((x) => x.stage_key === b.stage);
      return ao - bo || Number(a.position || 0) - Number(b.position || 0);
    })
    .map((item) => ({
      stage: item.stage,
      content: String(item.content || "").trim(),
      position: Number(item.position || 0),
    }))
    .filter((item) => item.stage && item.content);

  return { items };
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.exportAllBtn?.addEventListener("click", async () => {
  try {
    await exportAllTemplates();
  } catch (err) {
    alert(`Export 실패: ${parseApiError(err)}`);
  }
});

els.exportSelectedBtn?.addEventListener("click", async () => {
  window.location.href = "/static/template_export.html";
});

els.restoreBtn?.addEventListener("click", async () => {
  await handleRestoreTemplates();
});
els.restoreFileInput?.addEventListener("change", () => {
  updateRestoreFileState();
});

els.createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.createForm).entries());
    const created = await api.post("/api/templates", payload);
    els.createForm.reset();
    await loadTemplates();
    await selectTemplate(created.id);
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.list.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-select-template]");
  if (!btn) return;
  try {
    btn.disabled = true;
    btn.textContent = "불러오는 중...";
    await selectTemplate(btn.getAttribute("data-select-template"));
  } catch (err) {
    alert(`템플릿 선택 실패: ${parseApiError(err)}`);
  } finally {
    btn.disabled = false;
    if (Number(btn.getAttribute("data-select-template")) === Number(selectedTemplateId)) {
      btn.textContent = "선택됨";
    } else {
      btn.textContent = "선택";
    }
  }
});

els.list?.addEventListener("change", (e) => {
  const checkbox = e.target.closest("[data-template-bulk-select]");
  if (!checkbox) return;
  const id = Number(checkbox.getAttribute("data-template-bulk-select"));
  if (checkbox.checked) {
    selectedForBulkDelete.add(id);
  } else {
    selectedForBulkDelete.delete(id);
  }
  updateBulkDeleteState();
});

els.listSelectAll?.addEventListener("change", () => {
  if (els.listSelectAll.checked) {
    selectedForBulkDelete = new Set(templates.map((t) => Number(t.id)));
  } else {
    selectedForBulkDelete.clear();
  }
  renderTemplateList();
});

els.listDeleteSelectedBtn?.addEventListener("click", async () => {
  const originalText = els.listDeleteSelectedBtn.textContent;
  try {
    els.listDeleteSelectedBtn.disabled = true;
    els.listDeleteSelectedBtn.textContent = "삭제 중...";
    await deleteSelectedTemplates();
  } catch (err) {
    alert(`삭제 실패: ${parseApiError(err)}`);
  } finally {
    els.listDeleteSelectedBtn.textContent = originalText || "선택 템플릿 삭제";
    updateBulkDeleteState();
  }
});

els.updateForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedTemplateId) return;
  try {
    const payload = Object.fromEntries(new FormData(els.updateForm).entries());
    await api.patch(`/api/templates/${selectedTemplateId}`, payload);
    await api.put(`/api/templates/${selectedTemplateId}/stages`, buildStageReplacePayload());
    await api.put(`/api/templates/${selectedTemplateId}/items`, buildItemReplacePayload());

    clearDirty();
    await loadTemplates();
    await selectTemplate(selectedTemplateId);
    alert("템플릿 정보를 저장했습니다.");
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.updateForm.addEventListener("input", () => {
  if (selectedTemplateId) markDirty();
});

els.deleteBtn.addEventListener("click", async () => {
  if (!selectedTemplateId) return;
  if (!confirm("선택한 템플릿을 삭제할까요?")) return;

  try {
    await api.del(`/api/templates/${selectedTemplateId}`);
    selectedTemplateId = null;
    selectedTemplateStages = [];
    selectedTemplateItems = [];
    clearDirty();
    els.detailPanel.classList.add("hidden");
    await loadTemplates();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.stageCreateForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!selectedTemplateId) return;
  const stageName = String(els.stageNameInput?.value || "").trim();
  if (!stageName) {
    alert("대항목 이름을 입력해 주세요.");
    els.stageNameInput?.focus();
    return;
  }
  const duplicateName = selectedTemplateStages.some(
    (x) => String(x.stage_name || "").toLowerCase() === stageName.toLowerCase()
  );
  if (duplicateName) {
    alert("동일한 대항목 이름이 이미 있습니다.");
    els.stageNameInput?.focus();
    return;
  }

  selectedTemplateStages.push({
    id: null,
    template_id: selectedTemplateId,
    stage_key: nextUniqueStageKey(stageName),
    stage_name: stageName,
    position: selectedTemplateStages.length,
  });
  els.stageCreateForm.reset();
  markDirty();
  refreshTemplateEditorView();
});

els.stageList?.addEventListener("click", (e) => {
  const editBtn = e.target.closest("[data-edit-stage]");
  if (editBtn) {
    const stageKey = String(editBtn.getAttribute("data-edit-stage") || "");
    const target = selectedTemplateStages.find((x) => x.stage_key === stageKey);
    if (!target) return;

    const nextName = prompt("변경할 대항목 이름을 입력하세요.", target.stage_name || "");
    if (nextName === null) return;
    const trimmed = String(nextName || "").trim();
    if (!trimmed) {
      alert("대항목 이름을 입력해 주세요.");
      return;
    }
    const duplicate = selectedTemplateStages.some(
      (x) => x.stage_key !== stageKey && String(x.stage_name || "").toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      alert("동일한 대항목 이름이 이미 있습니다.");
      return;
    }
    target.stage_name = trimmed;
    markDirty();
    refreshTemplateEditorView();
    return;
  }

  const deleteBtn = e.target.closest("[data-delete-stage]");
  if (!deleteBtn) return;
  const stageKey = String(deleteBtn.getAttribute("data-delete-stage") || "");
  const target = selectedTemplateStages.find((x) => x.stage_key === stageKey);
  if (!target) return;
  if (selectedTemplateStages.length <= 1) {
    alert("대항목은 최소 1개 이상 필요합니다.");
    return;
  }
  if (!confirm(`대항목 '${target.stage_name}'를 삭제할까요?`)) return;

  selectedTemplateStages = selectedTemplateStages.filter((x) => x.stage_key !== stageKey);
  selectedTemplateItems = selectedTemplateItems.filter((x) => x.stage !== stageKey);
  markDirty();
  refreshTemplateEditorView();
});

els.stageContainer?.addEventListener("submit", (e) => {
  const form = e.target.closest("[data-stage-form]");
  if (!form || !selectedTemplateId) return;
  e.preventDefault();
  const stage = form.getAttribute("data-stage-form");
  const payload = Object.fromEntries(new FormData(form).entries());
  const content = String(payload.content || "").trim();
  if (!content) return;

  const nextPos =
    selectedTemplateItems
      .filter((x) => x.stage === stage)
      .reduce((max, x) => Math.max(max, Number(x.position || 0)), -1) + 1;

  selectedTemplateItems.push({
    id: null,
    stage,
    content,
    position: nextPos,
  });
  form.reset();
  markDirty();
  refreshTemplateEditorView();
});

els.stageContainer?.addEventListener("click", (e) => {
  const editBtn = e.target.closest("[data-edit-item]");
  if (editBtn) {
    const raw = String(editBtn.getAttribute("data-edit-item") || "");
    const [stageKey, posRaw] = raw.split("::");
    const pos = Number(posRaw);
    const target = selectedTemplateItems.find((x) => x.stage === stageKey && Number(x.position) === pos);
    if (!target) return;
    const nextContent = prompt("변경할 작업 항목 내용을 입력하세요.", target.content || "");
    if (nextContent === null) return;
    const trimmed = String(nextContent || "").trim();
    if (!trimmed) {
      alert("작업 항목 내용을 입력해 주세요.");
      return;
    }
    target.content = trimmed;
    markDirty();
    refreshTemplateEditorView();
    return;
  }

  const deleteBtn = e.target.closest("[data-del-item]");
  if (!deleteBtn) return;
  const stage = String(deleteBtn.getAttribute("data-del-stage") || "");
  const position = Number(deleteBtn.getAttribute("data-del-item"));
  selectedTemplateItems = selectedTemplateItems.filter((x) => !(x.stage === stage && Number(x.position) === position));
  normalizeItemPositionsByStage();
  markDirty();
  refreshTemplateEditorView();
});

Promise.resolve()
  .then(loadSession)
  .then(loadTemplates)
  .then(() => {
    updateRestoreFileState();
  })
  .catch((err) => {
    console.error(err);
    if (!String(err.message || "").includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
