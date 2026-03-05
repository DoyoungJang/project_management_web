const STAGES = [
  { key: "data_acquisition", title: "1. 데이터 획득" },
  { key: "labeling", title: "2. 라벨링" },
  { key: "development", title: "3. 개발" },
];

const BOARD = [
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

function stageLabel(stage) {
  const foundDynamic = projectStages.find((x) => x.stage_key === stage);
  if (foundDynamic) return foundDynamic.stage_name;
  const foundFallback = STAGES.find((x) => x.key === stage);
  return foundFallback ? foundFallback.title : stage;
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
}

function renderStageManager() {
  if (!els.stageList) return;
  if (!projectStages.length) {
    els.stageList.innerHTML = "<div class='item stage-manager-item'>등록된 대항목이 없습니다.</div>";
    return;
  }

  els.stageList.innerHTML = projectStages
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
          <button type="button" data-edit-stage="${stage.id}">이름 변경</button>
          <button type="button" class="danger" data-delete-stage="${stage.id}">삭제</button>
        </div>
      </div>
    `
    )
    .join("");
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
  if (!projectStages.length) {
    els.stages.innerHTML = "<div class='item'>대항목을 먼저 추가해 주세요.</div>";
    return;
  }
  els.stages.innerHTML = projectStages.map((stage) => renderStage(stage)).join("");
}

function renderStage(stage) {
  const items = checklistItems.filter((x) => x.stage === stage.stage_key);
  const listHtml =
    items.length === 0
      ? "<div class='item__meta'>작업 항목이 없습니다.</div>"
      : items
          .map(
            (item) => `
            <div class="check-item">
              <input type="checkbox" data-toggle-item="${item.id}" ${item.is_done ? "checked" : ""} />
              <span class="${item.is_done ? "check-done" : ""}">
                <small class="item__meta">${item.target_date ? `목표일: ${escapeHtml(item.target_date)}` : ""}</small>
              </span>
              <button type="button" class="danger check-del" data-del-item="${item.id}">삭제</button>
            </div>
            <div class="text-edit">
              <input type="text" data-content-list="${item.id}" value="${escapeHtml(item.content)}" maxlength="200" />
              <button type="button" data-save-content-list="${item.id}">내용 저장</button>
            </div>
            <div class="date-edit">
              <input type="date" data-date-list="${item.id}" value="${item.target_date || ""}" />
              <button type="button" data-save-date-list="${item.id}">일정 저장</button>
            </div>
          `
          )
          .join("");

  return `
    <article class="stage work-stage">
      <div class="work-stage__head">
        <h3>${stage.stage_name}</h3>
        <span class="badge">${items.length}개</span>
      </div>
      <div class="check-list">${listHtml}</div>
      <form class="check-form with-date work-check-form" data-stage-form="${stage.stage_key}">
        <input name="content" placeholder="작업 항목 입력" required minlength="1" maxlength="200" />
        <input name="target_date" type="date" />
        <select name="workflow_status">
          <option value="upcoming">Upcoming</option>
          <option value="inprogress">In Progress</option>
          <option value="done">Done</option>
        </select>
        <button type="submit">추가</button>
      </form>
    </article>
  `;
}

function mountChecklistContentEditors() {
  if (els.board) {
    els.board.querySelectorAll("[data-content-board]").forEach((input) => {
      const id = input.getAttribute("data-content-board");
      const editWrap = input.closest(".text-edit");
      if (!editWrap) return;
      editWrap.classList.add("hidden");

      const textView = document.createElement("div");
      textView.setAttribute("data-content-text-board", id);
      textView.textContent = input.value || "";

      const editBtnWrap = document.createElement("div");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.setAttribute("data-edit-content-board", id);
      editBtnWrap.appendChild(editBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.setAttribute("data-cancel-content-board", id);
      editWrap.appendChild(cancelBtn);

      editWrap.parentNode.insertBefore(textView, editWrap);
      editWrap.parentNode.insertBefore(editBtnWrap, editWrap);
    });
  }

  if (els.stages) {
    els.stages.querySelectorAll("[data-content-list]").forEach((input) => {
      const id = input.getAttribute("data-content-list");
      const editWrap = input.closest(".text-edit");
      if (!editWrap) return;
      editWrap.classList.add("hidden");

      const textView = document.createElement("div");
      textView.setAttribute("data-content-text-list", id);
      textView.textContent = input.value || "";

      const toggle = els.stages.querySelector(`[data-toggle-item="${id}"]`);
      if (toggle && toggle.checked) textView.classList.add("check-done");

      const editBtnWrap = document.createElement("div");
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.textContent = "Edit";
      editBtn.setAttribute("data-edit-content-list", id);
      editBtnWrap.appendChild(editBtn);

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.textContent = "Cancel";
      cancelBtn.setAttribute("data-cancel-content-list", id);
      editWrap.appendChild(cancelBtn);

      editWrap.parentNode.insertBefore(textView, editWrap);
      editWrap.parentNode.insertBefore(editBtnWrap, editWrap);
    });
  }
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
  mountChecklistContentEditors();
  if (els.board) bindBoardDragEvents();
}

async function loadTemplates() {
  templates = await api.get("/api/templates");
  renderTemplateSelect();
}

async function loadParticipants() {
  if (!els.participantList) return;
  participants = await api.get(`/api/projects/${projectId}/participants`);
  renderParticipants();
}

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
  const form = e.target.closest("[data-stage-form]");
  if (!form) return;
  e.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  const stage = form.getAttribute("data-stage-form");
  const body = {
    stage,
    content: payload.content,
    target_date: payload.target_date || null,
    workflow_status: payload.workflow_status || "upcoming",
  };
  await api.post(`/api/projects/${projectId}/checklists`, body);
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
  const editContentBtn = e.target.closest("[data-edit-content-list]");
  if (editContentBtn) {
    const id = editContentBtn.getAttribute("data-edit-content-list");
    const wrap = els.stages.querySelector(`[data-content-list="${id}"]`)?.closest(".text-edit");
    if (wrap) wrap.classList.remove("hidden");
    return;
  }

  const cancelContentBtn = e.target.closest("[data-cancel-content-list]");
  if (cancelContentBtn) {
    const id = cancelContentBtn.getAttribute("data-cancel-content-list");
    const wrap = els.stages.querySelector(`[data-content-list="${id}"]`)?.closest(".text-edit");
    const text = els.stages.querySelector(`[data-content-text-list="${id}"]`);
    const input = els.stages.querySelector(`[data-content-list="${id}"]`);
    if (input && text) input.value = (text.textContent || "").trim();
    if (wrap) wrap.classList.add("hidden");
    return;
  }

  const saveContentBtn = e.target.closest("[data-save-content-list]");
  if (saveContentBtn) {
    const id = saveContentBtn.getAttribute("data-save-content-list");
    const input = els.stages.querySelector(`[data-content-list="${id}"]`);
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

  const saveDateBtn = e.target.closest("[data-save-date-list]");
  if (saveDateBtn) {
    const id = saveDateBtn.getAttribute("data-save-date-list");
    const input = els.stages.querySelector(`[data-date-list="${id}"]`);
    await api.patch(`/api/checklists/${id}`, { target_date: input.value || null });
    await loadChecklist();
    return;
  }

  const btn = e.target.closest("[data-del-item]");
  if (!btn) return;
  const itemId = btn.getAttribute("data-del-item");
  if (!confirm("작업 항목을 삭제할까요?")) return;
  await api.del(`/api/checklists/${itemId}`);
  await loadChecklist();
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



