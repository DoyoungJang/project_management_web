const STAGES = [
  { key: "data_acquisition", title: "데이터 획득" },
  { key: "labeling", title: "라벨링" },
  { key: "development", title: "개발" },
];

const BOARD = [
  { key: "backlog", title: "Backlog" },
  { key: "upcoming", title: "Upcoming" },
  { key: "inprogress", title: "In Progress" },
  { key: "done", title: "Done" },
];

const params = new URLSearchParams(window.location.search);
const projectId = Number(params.get("project_id"));
const highlightChecklistId = Number(params.get("checklist_id") || "0");

if (!projectId) {
  alert("유효하지 않은 프로젝트입니다.");
  window.location.href = "/";
  throw new Error("Invalid project_id");
}

const { createApiClient, escapeHtml, parseApiError, applyUserTheme, showTaskDescriptionModal } = window.PMCommon;
const api = createApiClient();

const els = {
  title: document.getElementById("project-title"),
  board: document.getElementById("kanban-board"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  settingsLink: document.getElementById("project-settings-link"),
  ganttLink: document.getElementById("project-gantt-link"),
  calendarLink: document.getElementById("project-calendar-link"),
};

let checklistItems = [];
let projectStages = [];
let draggingChecklistId = null;
let projectTitle = "프로젝트";
let currentUser = null;
let canEditTasks = false;

function stageLabel(stage) {
  const foundDynamic = projectStages.find((x) => x.stage_key === stage);
  if (foundDynamic) return foundDynamic.stage_name;
  const foundFallback = STAGES.find((x) => x.key === stage);
  return foundFallback ? foundFallback.title : stage;
}

function getCurrentRelativeUrl() {
  return `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
}

function buildTaskManagerUrl(checklistId = null) {
  const next = new URL("/static/project_settings.html", window.location.origin);
  next.searchParams.set("project_id", String(projectId));
  next.searchParams.set("return_to", getCurrentRelativeUrl());
  next.searchParams.set("task_action", checklistId ? "edit" : "create");
  if (checklistId) {
    next.searchParams.set("edit_checklist_id", String(checklistId));
  }
  next.hash = "task-management";
  return `${next.pathname}${next.search}${next.hash}`;
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  currentUser = me;
  applyUserTheme(me);
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function loadProject() {
  const project = await api.get(`/api/projects/${projectId}`);
  projectTitle = project.name || "프로젝트";
  canEditTasks = Boolean(project.can_edit_tasks ?? (currentUser?.is_admin || project.owner === currentUser?.username));
  els.title.textContent = `${project.name || "프로젝트"} - 작업 보드`;
  if (els.settingsLink) {
    els.settingsLink.href = buildTaskManagerUrl();
    els.settingsLink.textContent = "작업 추가/관리 열기";
  }
  if (els.ganttLink) {
    els.ganttLink.href = `/static/project_gantt.html?project_id=${projectId}`;
  }
  if (els.calendarLink) {
    els.calendarLink.href = `/static/project_calendar.html?project_id=${projectId}`;
  }
}

async function loadStages() {
  projectStages = await api.get(`/api/projects/${projectId}/stages`);
}

function normalizeWorkflowStatus(item) {
  if (item.workflow_status) return item.workflow_status;
  return item.is_done ? "done" : "upcoming";
}

function renderBoard() {
  for (const col of BOARD) {
    const zone = els.board.querySelector(`[data-drop-zone="${col.key}"]`);
    const items = checklistItems
      .filter((x) => normalizeWorkflowStatus(x) === col.key)
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));

    if (!items.length) {
      zone.innerHTML = "<div class='item__meta'>작업이 없습니다.</div>";
      continue;
    }

    zone.innerHTML = items
      .map(
        (item) => `
        <article
          class="kanban-card ${highlightChecklistId === Number(item.id) ? "focus-target" : ""} ${
            canEditTasks ? "" : "kanban-card--readonly"
          }"
          ${canEditTasks ? 'draggable="true"' : ""}
          data-drag-item="${item.id}"
        >
          <div class="kanban-card__head">
            <span class="badge stage-tag">${escapeHtml(stageLabel(item.stage))}</span>
            <span class="item__meta">${escapeHtml(item.target_date || "-")}</span>
          </div>
          <button type="button" class="task-detail-trigger task-detail-trigger--card" data-open-task-description="${
            item.id
          }">
            ${escapeHtml(item.content)}
          </button>
        </article>
      `
      )
      .join("");
  }

  if (highlightChecklistId) {
    const target = els.board.querySelector(`[data-drag-item="${highlightChecklistId}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function bindBoardDragEvents() {
  if (!canEditTasks) return;
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
        .filter((x) => normalizeWorkflowStatus(x) === status)
        .reduce((m, x) => Math.max(m, Number(x.position || 0)), -1);

      try {
        await api.patch(`/api/checklists/${draggingChecklistId}`, {
          workflow_status: status,
          is_done: status === "done",
          position: maxPos + 1,
        });
        await loadChecklist();
      } catch (err) {
        alert(parseApiError(err));
      }
    });
  });
}

els.board?.addEventListener("click", (e) => {
  const detailBtn = e.target.closest("[data-open-task-description]");
  if (!detailBtn) return;
  const itemId = Number(detailBtn.getAttribute("data-open-task-description"));
  const item = checklistItems.find((x) => Number(x.id) === itemId);
  if (!item) return;

  showTaskDescriptionModal({
    title: item.content || "작업 설명",
    description: item.description || "",
    projectName: projectTitle,
    stageName: stageLabel(item.stage),
    startDate: item.start_date || "",
    targetDate: item.target_date || "",
    workflowStatus: normalizeWorkflowStatus(item),
    editable: canEditTasks,
    editLabel: "관리 페이지로 이동",
    editHref: canEditTasks ? buildTaskManagerUrl(itemId) : "",
  });
});

async function loadChecklist() {
  checklistItems = await api.get(`/api/projects/${projectId}/checklists`);
  renderBoard();
  bindBoardDragEvents();
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

Promise.resolve()
  .then(async () => {
    await loadSession();
    await loadProject();
    await loadStages();
    await loadChecklist();
  })
  .catch((err) => {
    console.error(err);
    if (!String(err.message || "").includes("Unauthorized")) {
      alert(parseApiError(err));
    }
  });
