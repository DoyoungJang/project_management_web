const STAGES = [
  { key: "data_acquisition", title: "1. 데이터 획득" },
  { key: "labeling", title: "2. 라벨링" },
  { key: "development", title: "3. 개발" },
];
const STAGE_ORDER = { data_acquisition: 1, labeling: 2, development: 3 };

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
  stageContainer: document.getElementById("template-stage-container"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
};

const { createApiClient, escapeHtml, parseApiError } = window.PMCommon;
const api = createApiClient();

let templates = [];
let selectedTemplateId = null;
let selectedTemplateItems = [];
let selectedForBulkDelete = new Set();
let isDirty = false;

function markDirty() {
  isDirty = true;
}

function clearDirty() {
  isDirty = false;
}

function updateExportSelectedState() {
  if (!els.exportSelectedBtn) return;
  els.exportSelectedBtn.disabled = false;
  els.exportSelectedBtn.textContent = "선택 템플릿 백업 페이지";
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

function normalizeTemplateItems(items) {
  const grouped = {
    data_acquisition: [],
    labeling: [],
    development: [],
  };

  for (const item of Array.isArray(items) ? items : []) {
    const stage = String(item.stage || "");
    if (!grouped[stage]) continue;
    grouped[stage].push({
      stage,
      content: String(item.content || "").trim(),
      position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
    });
  }

  const ordered = [];
  for (const stage of ["data_acquisition", "labeling", "development"]) {
    grouped[stage]
      .sort((a, b) => a.position - b.position)
      .forEach((item, idx) => {
        ordered.push({
          stage,
          content: item.content,
          position: idx,
        });
      });
  }
  return ordered;
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
      const items = await api.get(`/api/templates/${tpl.id}/items`);
      return {
        id: Number(tpl.id),
        name: tpl.name,
        description: tpl.description || "",
        creator_name: tpl.creator_name || "",
        items: normalizeTemplateItems(items),
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
    const items = normalizeTemplateItems(incoming.items || []);
    const existing = byName.get(name);

    if (existing) {
      if (mode === "skip") {
        skipped += 1;
        continue;
      }

      try {
        await api.patch(`/api/templates/${existing.id}`, { name, description });
        await api.put(`/api/templates/${existing.id}/items`, { items });
        updated += 1;
      } catch (err) {
        failed.push({ name, reason: parseApiError(err) });
      }
      continue;
    }

    try {
      const createdTemplate = await api.post("/api/templates", { name, description });
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
    templates: templatesData.map((tpl) => ({
      name: String(tpl.name || "").trim(),
      description: String(tpl.description || "").trim(),
      items: normalizeTemplateItems(
        (Array.isArray(tpl.items) ? tpl.items : []).map((item) => ({
          stage: item.stage,
          content: String(item.content || "").trim(),
          position: Number.isFinite(Number(item.position)) ? Number(item.position) : 0,
        }))
      ),
    })),
  };
}

async function handleRestoreTemplates() {
  const file = els.restoreFileInput?.files?.[0];
  if (!file) {
    alert("복원할 JSON 파일을 선택하세요.");
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
      `Restore 완료\n생성: ${result.created || 0}, 업데이트: ${result.updated || 0}, 건너뜀: ${result.skipped || 0}${failedMessage}`
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
  selectedForBulkDelete = new Set(
    Array.from(selectedForBulkDelete).filter((id) => validIdSet.has(Number(id)))
  );
  renderTemplateList();

  if (selectedTemplateId !== null && !templates.find((t) => t.id === selectedTemplateId)) {
    selectedTemplateId = null;
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
    selectedTemplateItems = [];
    els.detailPanel.classList.add("hidden");
  }
  await loadTemplates();

  if (failed === 0) {
    alert(`선택 템플릿 ${success}개를 삭제했습니다.`);
  } else {
    alert(
      `삭제 완료: 성공 ${success}개, 실패 ${failed}개\n${failures.slice(0, 5).join("\n")}${
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
  const selected = templates.find((t) => t.id === selectedTemplateId);
  if (!selected) return;

  els.updateForm.elements.name.value = selected.name || "";
  els.updateForm.elements.description.value = selected.description || "";

  selectedTemplateItems = await api.get(`/api/templates/${selectedTemplateId}/items`);
  clearDirty();
  renderTemplateList();
  renderSelectedTemplateDetail();
  els.detailPanel.classList.remove("hidden");
  els.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  updateExportSelectedState();
}

function renderSelectedTemplateDetail() {
  els.stageContainer.innerHTML = STAGES.map((stage) => renderStage(stage)).join("");
}

function renderStage(stage) {
  const items = selectedTemplateItems.filter((x) => x.stage === stage.key);
  return `
    <article class="stage">
      <h3>${stage.title}</h3>
      <div class="check-list">
        ${
          items.length === 0
            ? "<div class='item__meta'>작업 항목이 없습니다.</div>"
            : items
                .map(
                  (item) => `
                    <div class="check-item read-only">
                      <span><span class="badge stage-tag">${escapeHtml(stage.title)}</span> ${escapeHtml(item.content)}</span>
                      <button type="button" class="danger check-del" data-del-item="${item.position}" data-del-stage="${item.stage}">삭제</button>
                    </div>
                  `
                )
                .join("")
        }
      </div>
      <form class="check-form" data-stage="${stage.key}">
        <input name="content" placeholder="작업 항목 입력" required minlength="1" maxlength="200" />
        <button type="submit">추가</button>
      </form>
    </article>
  `;
}

function normalizeStagePositions(stage) {
  const stageItems = selectedTemplateItems.filter((x) => x.stage === stage);
  stageItems
    .sort((a, b) => a.position - b.position)
    .forEach((item, idx) => {
      item.position = idx;
    });
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

    const replacePayload = {
      items: selectedTemplateItems
        .slice()
        .sort((a, b) => {
          const order = { data_acquisition: 1, labeling: 2, development: 3 };
          return order[a.stage] - order[b.stage] || a.position - b.position;
        })
        .map((x) => ({ stage: x.stage, content: x.content, position: x.position })),
    };
    await api.put(`/api/templates/${selectedTemplateId}/items`, replacePayload);

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
    selectedTemplateItems = [];
    clearDirty();
    els.detailPanel.classList.add("hidden");
    await loadTemplates();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.stageContainer.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-stage]");
  if (!form || !selectedTemplateId) return;
  e.preventDefault();

  const stage = form.getAttribute("data-stage");
  const payload = Object.fromEntries(new FormData(form).entries());

  const nextPos =
    selectedTemplateItems
      .filter((x) => x.stage === stage)
      .reduce((max, x) => Math.max(max, x.position), -1) + 1;

  selectedTemplateItems.push({
    id: `draft_${Date.now()}_${Math.random()}`,
    stage,
    content: String(payload.content).trim(),
    position: nextPos,
  });

  form.reset();
  markDirty();
  renderSelectedTemplateDetail();
});

els.stageContainer.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-item]");
  if (!btn) return;

  const stage = btn.getAttribute("data-del-stage");
  const position = Number(btn.getAttribute("data-del-item"));
  selectedTemplateItems = selectedTemplateItems.filter(
    (x) => !(x.stage === stage && x.position === position)
  );
  normalizeStagePositions(stage);
  markDirty();
  renderSelectedTemplateDetail();
});

Promise.resolve()
  .then(loadSession)
  .then(loadTemplates)
  .then(() => {
    updateRestoreFileState();
  })
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
