const STAGES = [
  { key: "data_acquisition", title: "1. 데이터 획득" },
  { key: "labeling", title: "2. 라벨링" },
  { key: "development", title: "3. 개발" },
];

const BOARD = [
  { key: "backlog", title: "Backlog" },
  { key: "upcoming", title: "Upcoming" },
  { key: "inprogress", title: "In Progress" },
  { key: "done", title: "Done" },
];

const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project_id"));
if (!projectId) {
  alert("유효하지 않은 프로젝트입니다.");
  window.location.href = "/";
  throw new Error("Invalid project_id");
}

const { createApiClient, escapeHtml, parseApiError, applyUserTheme } = window.PMCommon;
const api = createApiClient();

const els = {
  title: document.getElementById("project-title"),
  form: document.getElementById("project-update-form"),
  stages: document.getElementById("stage-container"),
  taskSortSelect: document.getElementById("task-sort-select"),
  taskSortHint: document.getElementById("task-sort-hint"),
  stageCreateForm: document.getElementById("stage-create-form"),
  stageNameInput: document.getElementById("stage-name-input"),
  stageList: document.getElementById("stage-list"),
  board: document.getElementById("kanban-board"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  templateSelect: document.getElementById("template-select"),
  applyTemplateBtn: document.getElementById("apply-template-btn"),
  participantForm: document.getElementById("participant-form"),
  participantUsername: document.getElementById("participant-username"),
  participantList: document.getElementById("participant-list"),
};

let checklistItems = [];
let templates = [];
let participants = [];
let projectStages = [];
let draggingChecklistId = null;
let currentUser = null;
let editingChecklistId = null;
let draggingStageManagerId = null;
let draggingStageChecklistId = null;
let draggingStageChecklistStageKey = null;
let currentTaskSort = normalizeTaskSortKey(params.get("task_sort"));

function normalizeTaskSortKey(raw) {
  const key = String(raw || "manual").trim();
  return ["manual", "title", "start_date", "target_date"].includes(key) ? key : "manual";
}

function stageLabel(stage) {
  const foundDynamic = projectStages.find((x) => x.stage_key === stage);
  if (foundDynamic) return foundDynamic.stage_name;
  const foundFallback = STAGES.find((x) => x.key === stage);
  return foundFallback ? foundFallback.title : stage;
}

function workflowStatusLabel(status) {
  const map = {
    backlog: "Backlog",
    upcoming: "Upcoming",
    inprogress: "In Progress",
    done: "Done",
  };
  return map[status] || status || "Upcoming";
}

function descriptionPreview(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "설명 없음";
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}

function schedulePreview(item) {
  return `시작일: ${item.start_date || "-"} | 목표일: ${item.target_date || "-"} | 상태: ${workflowStatusLabel(
    item.workflow_status || "upcoming"
  )}`;
}

function compareDateText(a, b) {
  const aText = String(a || "").trim();
  const bText = String(b || "").trim();
  if (!aText && !bText) return 0;
  if (!aText) return 1;
  if (!bText) return -1;
  return aText.localeCompare(bText);
}

function compareChecklistItemsForSettings(a, b) {
  const manualGap = Number(a.position || 0) - Number(b.position || 0) || Number(a.id) - Number(b.id);
  const titleGap = String(a.content || "").localeCompare(String(b.content || ""), "ko", { sensitivity: "base" });

  switch (currentTaskSort) {
    case "title":
      return titleGap || compareDateText(a.start_date, b.start_date) || compareDateText(a.target_date, b.target_date) || manualGap;
    case "start_date":
      return compareDateText(a.start_date, b.start_date) || titleGap || compareDateText(a.target_date, b.target_date) || manualGap;
    case "target_date":
      return compareDateText(a.target_date, b.target_date) || titleGap || compareDateText(a.start_date, b.start_date) || manualGap;
    case "manual":
    default:
      return manualGap;
  }
}

function syncTaskSortToUrl() {
  const nextParams = new URLSearchParams(window.location.search);
  if (currentTaskSort === "manual") {
    nextParams.delete("task_sort");
  } else {
    nextParams.set("task_sort", currentTaskSort);
  }
  const nextQuery = nextParams.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`);
}

function renderTaskSortUi() {
  if (els.taskSortSelect) els.taskSortSelect.value = currentTaskSort;
  if (!els.taskSortHint) return;
  els.taskSortHint.textContent =
    currentTaskSort === "manual"
      ? "기존 정렬에서는 드래그로 순서를 직접 바꿀 수 있습니다."
      : "선택한 기준이 모든 대항목에 일괄 적용됩니다. 이 상태에서는 드래그 정렬이 잠시 비활성화됩니다.";
}

function moveIdBeforeOrAfter(list, draggedId, targetId, placeAfter = false) {
  const next = list.filter((id) => Number(id) !== Number(draggedId));
  const targetIndex = next.findIndex((id) => Number(id) === Number(targetId));
  if (targetIndex < 0) return list.slice();
  next.splice(targetIndex + (placeAfter ? 1 : 0), 0, Number(draggedId));
  return next;
}

function getDragPlacement(event, element) {
  const rect = element.getBoundingClientRect();
  return event.clientY >= rect.top + rect.height / 2 ? "after" : "before";
}

function clearDragIndicators(root) {
  root
    ?.querySelectorAll(".drag-target-before, .drag-target-after, .dragging")
    .forEach((node) => node.classList.remove("drag-target-before", "drag-target-after", "dragging"));
}

function applyDragIndicator(root, target, placement) {
  if (!root || !target) return;
  root.querySelectorAll(".drag-target-before, .drag-target-after").forEach((node) => {
    if (node !== target) node.classList.remove("drag-target-before", "drag-target-after");
  });
  target.classList.toggle("drag-target-before", placement === "before");
  target.classList.toggle("drag-target-after", placement === "after");
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  currentUser = me;
  applyUserTheme(me);
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function userExists(username) {
  const result = await api.get(`/api/users/exists?username=${encodeURIComponent(username)}`);
  return Boolean(result.exists);
}

function setProjectForm(project) {
  els.title.textContent = `${project.name || "프로젝트"} - 프로젝트 설정`;
  if (!els.form) return;
  const fields = ["name", "owner", "due_date", "status", "description"];
  for (const key of fields) {
    const el = els.form.elements[key];
    if (!el) continue;
    const value = project[key] ?? "";
    el.value = value;
  }
}

function renderTemplateSelect() {
  if (templates.length === 0) {
    els.templateSelect.innerHTML = "<option value=''>사용 가능한 템플릿이 없습니다.</option>";
    els.applyTemplateBtn.disabled = true;
    return;
  }
  els.templateSelect.innerHTML = templates
    .map((tpl) => `<option value="${tpl.id}">${escapeHtml(tpl.name)}</option>`)
    .join("");
  els.applyTemplateBtn.disabled = false;
}

function renderParticipants() {
  if (!els.participantList) return;
  const list = [...participants].sort((a, b) => {
    const aOwner = a.username === a.project_owner ? 1 : 0;
    const bOwner = b.username === b.project_owner ? 1 : 0;
    if (aOwner !== bOwner) return bOwner - aOwner;
    return String(a.username).localeCompare(String(b.username));
  });

  if (!list.length) {
    els.participantList.innerHTML = "<div class='item'>등록된 프로젝트 참가자가 없습니다.</div>";
    scheduleStageListHeightAdjustment();
    return;
  }
  els.participantList.innerHTML = `
    <div class="item">
      <div class="item__meta">참가자 수: ${list.length}명</div>
    </div>
  ` + list
    .map(
        (x) => `
      <div class="item">
        <div class="item__head">
          <div class="actions">
            <strong>${escapeHtml(x.username)}</strong>
            ${x.username === x.project_owner ? '<span class="badge badge--owner">Owner</span>' : ""}
          </div>
          ${
            x.username === x.project_owner
              ? ""
              : `<button type="button" class="danger" data-del-participant="${escapeHtml(x.username)}">삭제</button>`
          }
        </div>
        <div class="item__meta">${escapeHtml(x.display_name || "")}</div>
      </div>
    `
    )
    .join("");
  scheduleStageListHeightAdjustment();
}

function adjustStageListHeight() {
  if (!els.stageList) return;
  els.stageList.style.removeProperty("max-height");
}

function scheduleStageListHeightAdjustment() {
  window.requestAnimationFrame(() => {
    adjustStageListHeight();
  });
}

function renderStageManager() {
  if (!els.stageList) return;
  if (!projectStages.length) {
    els.stageList.innerHTML = "<div class='item stage-manager-item'>등록된 대항목이 없습니다.</div>";
    scheduleStageListHeightAdjustment();
    return;
  }

  els.stageList.innerHTML = projectStages
    .map(
      (stage, idx) => `
      <div class="item stage-manager-item" draggable="true" data-stage-drag-id="${stage.id}">
        <div class="item__head">
          <div class="stage-manager-title">
            <span class="stage-manager-index">${idx + 1}</span>
            <strong>${escapeHtml(stage.stage_name)}</strong>
          </div>
          <span class="badge stage-key-badge">${escapeHtml(stage.stage_key)}</span>
        </div>
        <div class="actions stage-manager-actions">
          <button type="button" data-edit-stage="${stage.id}">이름 변경</button>
          <button type="button" class="danger" data-delete-stage="${stage.id}">삭제</button>
        </div>
      </div>
    `
    )
    .join("");
  scheduleStageListHeightAdjustment();
}

function renderBoard() {
  if (!els.board) return;
  for (const col of BOARD) {
    const zone = els.board.querySelector(`[data-drop-zone="${col.key}"]`);
    const items = checklistItems
      .filter((x) => (x.workflow_status || "upcoming") === col.key)
      .sort((a, b) => (a.position || 0) - (b.position || 0));

    if (!items.length) {
      zone.innerHTML = "<div class='item__meta'>항목 없음</div>";
      continue;
    }

    zone.innerHTML = items
      .map(
        (item) => `
        <article class="kanban-card" draggable="true" data-drag-item="${item.id}">
          <div class="kanban-card__head">
            <span class="badge stage-tag">${escapeHtml(stageLabel(item.stage))}</span>
            <span class="item__meta">${item.target_date ? escapeHtml(item.target_date) : "-"}</span>
          </div>
          <div class="text-edit">
            <input type="text" data-content-board="${item.id}" value="${escapeHtml(item.content)}" maxlength="200" />
            <button type="button" data-save-content-board="${item.id}">내용 저장</button>
          </div>
          <div class="date-edit">
            <input type="date" data-date-board="${item.id}" value="${item.target_date || ""}" />
            <button type="button" data-save-date-board="${item.id}">일정 저장</button>
          </div>
        </article>
      `
      )
      .join("");
  }
}

function renderStages() {
  if (!els.stages) return;
  renderTaskSortUi();
  if (!projectStages.length) {
    els.stages.innerHTML = "<div class='item'>대항목을 먼저 추가해 주세요.</div>";
    return;
  }
  els.stages.innerHTML = projectStages.map((stage) => renderStage(stage)).join("");
}

function renderStage(stage) {
  const items = checklistItems
    .filter((x) => x.stage === stage.stage_key)
    .sort(compareChecklistItemsForSettings);
  const listHtml =
    items.length === 0
      ? "<div class='item__meta'>작업 항목이 없습니다.</div>"
      : items
          .map((item) => {
            if (editingChecklistId === Number(item.id)) {
              return `
            <form class="template-item-editor project-item-editor" data-edit-checklist-form="${item.id}">
              <input
                name="content"
                value="${escapeHtml(item.content)}"
                placeholder="작업 항목 입력"
                required
                minlength="1"
                maxlength="200"
              />
              <textarea
                name="description"
                placeholder="설명 팝업 내용 입력"
                maxlength="5000"
              >${escapeHtml(item.description || "")}</textarea>
              <div class="project-item-editor__grid">
                <label class="project-item-editor__field">
                  <span class="item__meta">시작일</span>
                  <input name="start_date" type="date" value="${item.start_date || ""}" />
                </label>
                <label class="project-item-editor__field">
                  <span class="item__meta">목표일</span>
                  <input name="target_date" type="date" value="${item.target_date || ""}" />
                </label>
                <label class="project-item-editor__field">
                  <span class="item__meta">상태</span>
                  <select name="workflow_status">
                    <option value="backlog" ${item.workflow_status === "backlog" ? "selected" : ""}>Backlog</option>
                    <option value="upcoming" ${item.workflow_status === "upcoming" ? "selected" : ""}>Upcoming</option>
                    <option value="inprogress" ${item.workflow_status === "inprogress" ? "selected" : ""}>In Progress</option>
                    <option value="done" ${item.workflow_status === "done" ? "selected" : ""}>Done</option>
                  </select>
                </label>
                <label class="inline-check project-item-editor__check">
                  <input type="checkbox" name="is_done" value="1" ${item.is_done ? "checked" : ""} />
                  완료
                </label>
              </div>
              <div class="actions">
                <button type="submit">저장</button>
                <button type="button" data-cancel-edit-checklist="${item.id}">취소</button>
              </div>
            </form>
          `;
            }

            return `
            <div
              class="template-item-card project-item-card ${item.is_done ? "project-item-card--done" : ""}"
              ${editingChecklistId === null && currentTaskSort === "manual" ? 'draggable="true"' : ""}
              data-stage-checklist-drag-id="${item.id}"
              data-stage-checklist-stage="${escapeHtml(stage.stage_key)}"
            >
              <label class="inline-check project-item-card__toggle">
                <input type="checkbox" data-toggle-item="${item.id}" ${item.is_done ? "checked" : ""} />
                완료
              </label>
              <div class="template-item-card__body">
                <strong class="${item.is_done ? "check-done" : ""}">${escapeHtml(item.content)}</strong>
                <div class="item__meta">${escapeHtml(descriptionPreview(item.description || ""))}</div>
                <div class="item__meta">${escapeHtml(schedulePreview(item))}</div>
              </div>
              <div class="actions">
                <button type="button" data-edit-checklist="${item.id}">수정</button>
                <button type="button" class="danger check-del" data-del-item="${item.id}">삭제</button>
              </div>
            </div>
          `;
          })
          .join("");

  return `
    <article class="stage work-stage">
      <div class="work-stage__head">
        <h3>${stage.stage_name}</h3>
        <span class="badge">${items.length}개</span>
      </div>
      <div class="check-list" data-stage-item-list="${escapeHtml(stage.stage_key)}">${listHtml}</div>
      <form class="check-form work-check-form project-item-create-form" data-stage-form="${stage.stage_key}">
        <input name="content" placeholder="작업 항목 입력" required minlength="1" maxlength="200" />
        <textarea name="description" placeholder="설명 팝업 내용 입력" maxlength="5000"></textarea>
        <div class="project-item-editor__grid">
          <label class="project-item-editor__field">
            <span class="item__meta">시작일</span>
            <input name="start_date" type="date" />
          </label>
          <label class="project-item-editor__field">
            <span class="item__meta">목표일</span>
            <input name="target_date" type="date" />
          </label>
          <label class="project-item-editor__field">
            <span class="item__meta">상태</span>
            <select name="workflow_status">
              <option value="upcoming">Upcoming</option>
              <option value="backlog">Backlog</option>
              <option value="inprogress">In Progress</option>
              <option value="done">Done</option>
            </select>
          </label>
        </div>
        <button type="submit">추가</button>
      </form>
    </article>
  `;
}

async function saveStageOrder(nextStageIds) {
  await api.post(`/api/projects/${projectId}/stage-reorder`, { stage_ids: nextStageIds });
  await loadStages();
  await loadChecklist();
}

async function saveStageChecklistOrder(stageKey, nextItemIds) {
  await api.post(`/api/projects/${projectId}/stage-checklists/${encodeURIComponent(stageKey)}/reorder`, {
    item_ids: nextItemIds,
  });
  await loadChecklist();
}

function bindBoardDragEvents() {
  if (!els.board) return;
  els.board.querySelectorAll("[data-drag-item]").forEach((card) => {
    card.addEventListener("dragstart", () => {
      draggingChecklistId = Number(card.getAttribute("data-drag-item"));
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      draggingChecklistId = null;
    });
  });

  els.board.querySelectorAll("[data-drop-zone]").forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => {
      zone.classList.remove("drag-over");
    });
    zone.addEventListener("drop", async (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
      if (!draggingChecklistId) return;
      const status = zone.getAttribute("data-drop-zone");
      const maxPos = checklistItems
        .filter((x) => (x.workflow_status || "upcoming") === status)
        .reduce((m, x) => Math.max(m, Number(x.position || 0)), -1);
      await api.patch(`/api/checklists/${draggingChecklistId}`, {
        workflow_status: status,
        position: maxPos + 1,
      });
      await loadChecklist();
    });
  });
}

async function loadProject() {
  const project = await api.get(`/api/projects/${projectId}`);
  setProjectForm(project);
}

async function loadStages() {
  projectStages = await api.get(`/api/projects/${projectId}/stages`);
  renderStageManager();
}

async function loadChecklist() {
  checklistItems = await api.get(`/api/projects/${projectId}/checklists`);
  if (els.board) renderBoard();
  if (els.stages) renderStages();
  if (els.board) bindBoardDragEvents();
}

async function loadTemplates() {
  templates = await api.get("/api/templates");
  renderTemplateSelect();
  scheduleStageListHeightAdjustment();
}

async function loadParticipants() {
  if (!els.participantList) return;
  participants = await api.get(`/api/projects/${projectId}/participants`);
  renderParticipants();
}

window.addEventListener("resize", () => {
  scheduleStageListHeightAdjustment();
});

els.taskSortSelect?.addEventListener("change", (e) => {
  currentTaskSort = normalizeTaskSortKey(e.target.value);
  syncTaskSortToUrl();
  renderStages();
});

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.form).entries());
    const owner = String(payload.owner || "").trim();
    if (!owner) {
      alert("Owner 아이디를 입력해 주세요.");
      els.form.elements.owner?.focus();
      return;
    }
    if (!payload.due_date) payload.due_date = null;
    await api.patch(`/api/projects/${projectId}`, payload);
    alert("프로젝트 정보를 저장했습니다.");
    await loadProject();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.participantForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const username = String(els.participantUsername?.value || "").trim();
    if (!username) {
      alert("참가자 아이디를 입력해 주세요.");
      els.participantUsername?.focus();
      return;
    }

    const exists = await userExists(username);
    if (!exists) {
      alert("존재하지 않는 아이디입니다.");
      els.participantUsername?.focus();
      return;
    }

    await api.post(`/api/projects/${projectId}/participants`, { username });
    els.participantForm.reset();
    await loadParticipants();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.participantList?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-participant]");
  if (!btn) return;
  const username = btn.getAttribute("data-del-participant");
  if (!confirm(`${username} 참가자를 제외할까요?`)) return;
  try {
    await api.del(`/api/projects/${projectId}/participants/${encodeURIComponent(username)}`);
    await loadParticipants();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.stageCreateForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = String(els.stageNameInput?.value || "").trim();
  if (!name) {
    alert("대항목 이름을 입력해 주세요.");
    els.stageNameInput?.focus();
    return;
  }
  try {
    await api.post(`/api/projects/${projectId}/stages`, { name });
    els.stageCreateForm.reset();
    await loadStages();
    await loadChecklist();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.stageList?.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-stage]");
  if (editBtn) {
    const stageId = Number(editBtn.getAttribute("data-edit-stage"));
    const target = projectStages.find((x) => Number(x.id) === stageId);
    if (!target) return;
    const nextName = prompt("변경할 대항목 이름을 입력하세요.", target.stage_name || "");
    if (nextName === null) return;
    const trimmed = String(nextName || "").trim();
    if (!trimmed) {
      alert("대항목 이름을 입력해 주세요.");
      return;
    }
    try {
      await api.patch(`/api/projects/${projectId}/stages/${stageId}`, { name: trimmed });
      await loadStages();
      await loadChecklist();
    } catch (err) {
      alert(parseApiError(err));
    }
    return;
  }

  const deleteBtn = e.target.closest("[data-delete-stage]");
  if (!deleteBtn) return;
  const stageId = Number(deleteBtn.getAttribute("data-delete-stage"));
  const target = projectStages.find((x) => Number(x.id) === stageId);
  if (!target) return;
  if (!confirm(`대항목 '${target.stage_name}'를 삭제할까요?`)) return;
  try {
    await api.del(`/api/projects/${projectId}/stages/${stageId}`);
    await loadStages();
    await loadChecklist();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.stageList?.addEventListener("dragstart", (e) => {
  const item = e.target.closest("[data-stage-drag-id]");
  if (!item) return;
  draggingStageManagerId = Number(item.getAttribute("data-stage-drag-id"));
  item.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(draggingStageManagerId));
  }
});

els.stageList?.addEventListener("dragend", () => {
  draggingStageManagerId = null;
  clearDragIndicators(els.stageList);
});

els.stageList?.addEventListener("dragover", (e) => {
  if (!draggingStageManagerId) return;
  const target = e.target.closest("[data-stage-drag-id]");
  if (!target) return;
  const targetId = Number(target.getAttribute("data-stage-drag-id"));
  if (!Number.isFinite(targetId) || targetId === draggingStageManagerId) return;
  e.preventDefault();
  applyDragIndicator(els.stageList, target, getDragPlacement(e, target));
});

els.stageList?.addEventListener("dragleave", (e) => {
  const relatedTarget = e.relatedTarget;
  if (relatedTarget && els.stageList.contains(relatedTarget)) return;
  els.stageList.querySelectorAll(".drag-target-before, .drag-target-after").forEach((node) => {
    node.classList.remove("drag-target-before", "drag-target-after");
  });
});

els.stageList?.addEventListener("drop", async (e) => {
  const target = e.target.closest("[data-stage-drag-id]");
  if (!draggingStageManagerId || !target) return;
  const targetId = Number(target.getAttribute("data-stage-drag-id"));
  if (!Number.isFinite(targetId) || targetId === draggingStageManagerId) return;
  e.preventDefault();

  const placement = getDragPlacement(e, target);
  const currentOrder = projectStages.map((stage) => Number(stage.id));
  const nextOrder = moveIdBeforeOrAfter(currentOrder, draggingStageManagerId, targetId, placement === "after");
  clearDragIndicators(els.stageList);
  draggingStageManagerId = null;

  if (JSON.stringify(currentOrder) === JSON.stringify(nextOrder)) return;

  try {
    await saveStageOrder(nextOrder);
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.applyTemplateBtn.addEventListener("click", async () => {
  const templateId = Number(els.templateSelect.value);
  if (!templateId) return;
  if (!confirm("현재 작업 항목을 지우고 선택한 템플릿으로 적용할까요?")) return;
  await api.post(`/api/projects/${projectId}/apply-template/${templateId}`, {});
  await loadStages();
  await loadChecklist();
  alert("템플릿이 적용되었습니다.");
});

els.stages?.addEventListener("submit", async (e) => {
  const editForm = e.target.closest("[data-edit-checklist-form]");
  if (editForm) {
    e.preventDefault();
    const itemId = Number(editForm.getAttribute("data-edit-checklist-form"));
    const payload = Object.fromEntries(new FormData(editForm).entries());
    const content = String(payload.content || "").trim();
    if (!content) {
      alert("작업 항목 내용을 입력해 주세요.");
      editForm.querySelector("[name='content']")?.focus();
      return;
    }

    await api.patch(`/api/checklists/${itemId}`, {
      content,
      description: String(payload.description || "").trim(),
      start_date: payload.start_date || null,
      target_date: payload.target_date || null,
      workflow_status: payload.workflow_status || "upcoming",
      is_done: Boolean(payload.is_done),
    });
    editingChecklistId = null;
    await loadChecklist();
    return;
  }

  const form = e.target.closest("[data-stage-form]");
  if (!form) return;
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  const stage = form.getAttribute("data-stage-form");
  const body = {
    stage,
    content: String(payload.content || "").trim(),
    description: String(payload.description || "").trim(),
    start_date: payload.start_date || null,
    target_date: payload.target_date || null,
    workflow_status: payload.workflow_status || "upcoming",
  };
  if (!body.content) {
    alert("작업 항목 내용을 입력해 주세요.");
    form.querySelector("[name='content']")?.focus();
    return;
  }
  await api.post(`/api/projects/${projectId}/checklists`, body);
  editingChecklistId = null;
  form.reset();
  await loadChecklist();
});

els.stages?.addEventListener("change", async (e) => {
  const checkbox = e.target.closest("[data-toggle-item]");
  if (!checkbox) return;
  const itemId = checkbox.getAttribute("data-toggle-item");
  await api.patch(`/api/checklists/${itemId}`, { is_done: checkbox.checked });
  await loadChecklist();
});

els.stages?.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-checklist]");
  if (editBtn) {
    editingChecklistId = Number(editBtn.getAttribute("data-edit-checklist"));
    await loadChecklist();
    return;
  }

  const cancelBtn = e.target.closest("[data-cancel-edit-checklist]");
  if (cancelBtn) {
    editingChecklistId = null;
    await loadChecklist();
    return;
  }

  const btn = e.target.closest("[data-del-item]");
  if (!btn) return;
  const itemId = btn.getAttribute("data-del-item");
  if (!confirm("작업 항목을 삭제할까요?")) return;
  editingChecklistId = null;
  await api.del(`/api/checklists/${itemId}`);
  await loadChecklist();
});

els.stages?.addEventListener("dragstart", (e) => {
  const item = e.target.closest("[data-stage-checklist-drag-id]");
  if (!item || editingChecklistId !== null) return;
  draggingStageChecklistId = Number(item.getAttribute("data-stage-checklist-drag-id"));
  draggingStageChecklistStageKey = String(item.getAttribute("data-stage-checklist-stage") || "");
  item.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(draggingStageChecklistId));
  }
});

els.stages?.addEventListener("dragend", () => {
  draggingStageChecklistId = null;
  draggingStageChecklistStageKey = null;
  clearDragIndicators(els.stages);
});

els.stages?.addEventListener("dragover", (e) => {
  if (!draggingStageChecklistId || !draggingStageChecklistStageKey) return;
  const target = e.target.closest("[data-stage-checklist-drag-id]");
  if (!target) return;
  const targetId = Number(target.getAttribute("data-stage-checklist-drag-id"));
  const targetStageKey = String(target.getAttribute("data-stage-checklist-stage") || "");
  if (!Number.isFinite(targetId) || targetId === draggingStageChecklistId) return;
  if (targetStageKey !== draggingStageChecklistStageKey) return;
  e.preventDefault();
  applyDragIndicator(els.stages, target, getDragPlacement(e, target));
});

els.stages?.addEventListener("dragleave", (e) => {
  const relatedTarget = e.relatedTarget;
  if (relatedTarget && els.stages.contains(relatedTarget)) return;
  els.stages.querySelectorAll(".drag-target-before, .drag-target-after").forEach((node) => {
    node.classList.remove("drag-target-before", "drag-target-after");
  });
});

els.stages?.addEventListener("drop", async (e) => {
  const target = e.target.closest("[data-stage-checklist-drag-id]");
  if (!draggingStageChecklistId || !draggingStageChecklistStageKey || !target) return;

  const targetId = Number(target.getAttribute("data-stage-checklist-drag-id"));
  const targetStageKey = String(target.getAttribute("data-stage-checklist-stage") || "");
  if (!Number.isFinite(targetId) || targetId === draggingStageChecklistId) return;
  if (targetStageKey !== draggingStageChecklistStageKey) return;
  e.preventDefault();

  const placement = getDragPlacement(e, target);
  const currentOrder = checklistItems
    .filter((item) => item.stage === draggingStageChecklistStageKey)
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map((item) => Number(item.id));
  const nextOrder = moveIdBeforeOrAfter(currentOrder, draggingStageChecklistId, targetId, placement === "after");

  clearDragIndicators(els.stages);
  const stageKey = draggingStageChecklistStageKey;
  draggingStageChecklistId = null;
  draggingStageChecklistStageKey = null;

  if (JSON.stringify(currentOrder) === JSON.stringify(nextOrder)) return;

  try {
    await saveStageChecklistOrder(stageKey, nextOrder);
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.board?.addEventListener("click", async (e) => {
  const editContentBtn = e.target.closest("[data-edit-content-board]");
  if (editContentBtn) {
    const id = editContentBtn.getAttribute("data-edit-content-board");
    const wrap = els.board.querySelector(`[data-content-board="${id}"]`)?.closest(".text-edit");
    if (wrap) wrap.classList.remove("hidden");
    return;
  }

  const cancelContentBtn = e.target.closest("[data-cancel-content-board]");
  if (cancelContentBtn) {
    const id = cancelContentBtn.getAttribute("data-cancel-content-board");
    const wrap = els.board.querySelector(`[data-content-board="${id}"]`)?.closest(".text-edit");
    const text = els.board.querySelector(`[data-content-text-board="${id}"]`);
    const input = els.board.querySelector(`[data-content-board="${id}"]`);
    if (input && text) input.value = (text.textContent || "").trim();
    if (wrap) wrap.classList.add("hidden");
    return;
  }

  const saveContentBtn = e.target.closest("[data-save-content-board]");
  if (saveContentBtn) {
    const id = saveContentBtn.getAttribute("data-save-content-board");
    const input = els.board.querySelector(`[data-content-board="${id}"]`);
    const content = (input.value || "").trim();
    if (!content) {
      alert("작업 항목 내용을 입력해 주세요.");
      input.focus();
      return;
    }
    await api.patch(`/api/checklists/${id}`, { content });
    await loadChecklist();
    return;
  }

  const saveDateBtn = e.target.closest("[data-save-date-board]");
  if (!saveDateBtn) return;
  const id = saveDateBtn.getAttribute("data-save-date-board");
  const input = els.board.querySelector(`[data-date-board="${id}"]`);
  await api.patch(`/api/checklists/${id}`, { target_date: input.value || null });
  await loadChecklist();
});

Promise.resolve()
  .then(async () => {
    await loadSession();
    // Always load core project data first so header/form are populated.
    await loadProject();
    await loadStages();
    await loadChecklist();
    const optionalLoads = await Promise.allSettled([
      loadTemplates(),
      loadParticipants(),
    ]);
    scheduleStageListHeightAdjustment();
    optionalLoads.forEach((x) => {
      if (x.status === "rejected") console.warn(x.reason);
    });
  })
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(parseApiError(err));
    }
  });



