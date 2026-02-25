const STAGES = [
  { key: "data_acquisition", title: "데이터 획득" },
  { key: "labeling", title: "라벨링" },
  { key: "development", title: "개발" },
];

const BOARD = [
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
  patch(url, body) {
    return this.request(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
  post(url, body) {
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },
};

const els = {
  title: document.getElementById("project-title"),
  board: document.getElementById("kanban-board"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  settingsLink: document.getElementById("project-settings-link"),
};

let checklistItems = [];
let draggingChecklistId = null;

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

function parseApiError(error) {
  try {
    const parsed = JSON.parse(String(error.message || ""));
    if (parsed && typeof parsed.detail === "string") return parsed.detail;
  } catch (_) {
    // no-op
  }
  return String(error.message || "요청 처리 중 오류가 발생했습니다.");
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  if (me.is_admin) els.adminLink.classList.remove("hidden");
}

async function loadProject() {
  const project = await api.get(`/api/projects/${projectId}`);
  els.title.textContent = `${project.name || "프로젝트"} - 체크리스트 보드`;
  if (els.settingsLink) {
    els.settingsLink.href = `/static/project_settings.html?project_id=${projectId}`;
  }
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
      zone.innerHTML = "<div class='item__meta'>항목이 없습니다.</div>";
      continue;
    }

    zone.innerHTML = items
      .map(
        (item) => `
        <article
          class="kanban-card ${highlightChecklistId === Number(item.id) ? "focus-target" : ""}"
          draggable="true"
          data-drag-item="${item.id}"
        >
          <div class="kanban-card__head">
            <span class="badge stage-tag">${escapeHtml(stageLabel(item.stage))}</span>
            <span class="item__meta">${escapeHtml(item.target_date || "-")}</span>
          </div>
          <div>${escapeHtml(item.content)}</div>
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
    await loadChecklist();
  })
  .catch((err) => {
    console.error(err);
    if (!String(err.message || "").includes("Unauthorized")) {
      alert(parseApiError(err));
    }
  });
