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

const api = {
  async request(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 401) {
      window.location.href = "/static/login.html";
      throw new Error("Unauthorized");
    }
    if (!res.ok) throw new Error(await res.text());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  },
  get(url) {
    return this.request(url);
  },
  post(url, body) {
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  patch(url, body) {
    return this.request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  del(url) {
    return this.request(url, { method: "DELETE" });
  },
};

const els = {
  title: document.getElementById("project-title"),
  form: document.getElementById("project-update-form"),
  stages: document.getElementById("stage-container"),
  board: document.getElementById("kanban-board"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  templateSelect: document.getElementById("template-select"),
  applyTemplateBtn: document.getElementById("apply-template-btn"),
  ruleForm: document.getElementById("rule-form"),
  daysBeforeInput: document.getElementById("days-before-input"),
  ruleList: document.getElementById("rule-list"),
  notificationPreviewList: document.getElementById("notification-preview-list"),
  participantForm: document.getElementById("participant-form"),
  participantUsername: document.getElementById("participant-username"),
  participantList: document.getElementById("participant-list"),
};

let checklistItems = [];
let templates = [];
let notificationRules = [];
let participants = [];
let draggingChecklistId = null;
let currentUser = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stageLabel(stage) {
  const found = STAGES.find((x) => x.key === stage);
  return found ? found.title : stage;
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  currentUser = me;
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

function parseApiError(error) {
  try {
    const parsed = JSON.parse(String(error.message || ""));
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch (_) {
    //
  }
  return String(error.message || "요청 처리 중 오류가 발생했습니다.");
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

function renderNotificationRules() {
  if (notificationRules.length === 0) {
    els.ruleList.innerHTML = "<div class='item'>등록된 알림 규칙이 없습니다.</div>";
    return;
  }
  els.ruleList.innerHTML = notificationRules
    .map(
      (rule) => `
      <div class="item">
        <div class="item__head">
          <strong>D-${rule.days_before}</strong>
          <button class="danger" data-del-rule="${rule.id}">삭제</button>
        </div>
        <div class="item__meta">목표일 ${rule.days_before}일 전에 알림</div>
      </div>
    `
    )
    .join("");
}

function renderNotificationPreview(rows) {
  if (!rows.length) {
    els.notificationPreviewList.innerHTML = "<div class='item'>앞으로 30일 기준 알림 예정 항목이 없습니다.</div>";
    return;
  }
  els.notificationPreviewList.innerHTML = rows
    .map(
      (x) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(x.content)}</strong>
          <span class="badge">${escapeHtml(x.notify_date)}</span>
        </div>
        <div class="item__meta">단계: ${escapeHtml(x.stage)} | D-${x.days_before} 알림 | 목표일: ${escapeHtml(x.target_date)}</div>
      </div>
    `
    )
    .join("");
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
  els.stages.innerHTML = STAGES.map((stage) => renderStage(stage)).join("");
}

function renderStage(stage) {
  const items = checklistItems.filter((x) => x.stage === stage.key);
  const listHtml =
    items.length === 0
      ? "<div class='item__meta'>체크리스트 항목이 없습니다.</div>"
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
    <article class="stage">
      <h3>${stage.title}</h3>
      <div class="check-list">${listHtml}</div>
      <form class="check-form with-date" data-stage-form="${stage.key}">
        <input name="content" placeholder="체크리스트 항목 입력" required minlength="1" maxlength="200" />
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
      await loadRulesAndPreview();
    });
  });
}

async function loadProject() {
  const project = await api.get(`/api/projects/${projectId}`);
  setProjectForm(project);
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

async function loadRulesAndPreview() {
  notificationRules = await api.get(`/api/projects/${projectId}/notification-rules`);
  renderNotificationRules();
  const preview = await api.get(`/api/projects/${projectId}/notifications/preview?days=30`);
  renderNotificationPreview(preview);
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

els.applyTemplateBtn.addEventListener("click", async () => {
  const templateId = Number(els.templateSelect.value);
  if (!templateId) return;
  if (!confirm("현재 체크리스트를 지우고 선택한 템플릿으로 적용할까요?")) return;
  await api.post(`/api/projects/${projectId}/apply-template/${templateId}`, {});
  await loadChecklist();
  await loadRulesAndPreview();
  alert("템플릿이 적용되었습니다.");
});

els.ruleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const daysBefore = Number(els.daysBeforeInput.value);
  await api.post(`/api/projects/${projectId}/notification-rules`, { days_before: daysBefore });
  els.daysBeforeInput.value = "1";
  await loadRulesAndPreview();
});

els.ruleList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-rule]");
  if (!btn) return;
  const id = btn.getAttribute("data-del-rule");
  if (!confirm("알림 규칙을 삭제할까요?")) return;
  await api.del(`/api/notification-rules/${id}`);
  await loadRulesAndPreview();
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
  await loadRulesAndPreview();
});

els.stages?.addEventListener("change", async (e) => {
  const checkbox = e.target.closest("[data-toggle-item]");
  if (!checkbox) return;
  const itemId = checkbox.getAttribute("data-toggle-item");
  await api.patch(`/api/checklists/${itemId}`, { is_done: checkbox.checked });
  await loadChecklist();
  await loadRulesAndPreview();
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
      alert("체크리스트 항목 내용을 입력해 주세요.");
      input.focus();
      return;
    }
    await api.patch(`/api/checklists/${id}`, { content });
    await loadChecklist();
    await loadRulesAndPreview();
    return;
  }

  const saveDateBtn = e.target.closest("[data-save-date-list]");
  if (saveDateBtn) {
    const id = saveDateBtn.getAttribute("data-save-date-list");
    const input = els.stages.querySelector(`[data-date-list="${id}"]`);
    await api.patch(`/api/checklists/${id}`, { target_date: input.value || null });
    await loadChecklist();
    await loadRulesAndPreview();
    return;
  }

  const btn = e.target.closest("[data-del-item]");
  if (!btn) return;
  const itemId = btn.getAttribute("data-del-item");
  if (!confirm("체크리스트 항목을 삭제할까요?")) return;
  await api.del(`/api/checklists/${itemId}`);
  await loadChecklist();
  await loadRulesAndPreview();
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
      alert("체크리스트 항목 내용을 입력해 주세요.");
      input.focus();
      return;
    }
    await api.patch(`/api/checklists/${id}`, { content });
    await loadChecklist();
    await loadRulesAndPreview();
    return;
  }

  const saveDateBtn = e.target.closest("[data-save-date-board]");
  if (!saveDateBtn) return;
  const id = saveDateBtn.getAttribute("data-save-date-board");
  const input = els.board.querySelector(`[data-date-board="${id}"]`);
  await api.patch(`/api/checklists/${id}`, { target_date: input.value || null });
  await loadChecklist();
  await loadRulesAndPreview();
});

Promise.resolve()
  .then(async () => {
    await loadSession();
    // Always load core project data first so header/form are populated.
    await loadProject();
    await loadChecklist();
    const optionalLoads = await Promise.allSettled([
      loadTemplates(),
      loadRulesAndPreview(),
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



