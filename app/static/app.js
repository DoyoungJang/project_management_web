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
  del(url) {
    return this.request(url, { method: "DELETE" });
  },
};

const els = {
  userInfo: document.getElementById("user-info"),
  adminLink: document.getElementById("admin-link"),
  logoutBtn: document.getElementById("logout-btn"),
  todayNotifications: document.getElementById("today-notifications"),
  dashboard: {
    projects: document.getElementById("stat-projects"),
    active: document.getElementById("stat-active"),
    tasks: document.getElementById("stat-tasks"),
    rate: document.getElementById("stat-rate"),
  },
  projectForm: document.getElementById("project-form"),
  taskForm: document.getElementById("task-form"),
  projectList: document.getElementById("project-list"),
  taskList: document.getElementById("task-list"),
  taskProjectSelect: document.getElementById("task-project-select"),
  taskFilterStatus: document.getElementById("task-filter-status"),
};

let projects = [];
let tasks = [];
let currentUser = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusLabel(raw) {
  const map = {
    planned: "Planned",
    active: "Active",
    done: "Done",
    todo: "Todo",
    in_progress: "In Progress",
  };
  return map[raw] || raw;
}

function stageLabel(raw) {
  const map = {
    data_acquisition: "데이터 획득",
    labeling: "라벨링",
    development: "개발",
  };
  return map[raw] || raw;
}

function priorityLabel(raw) {
  return raw.charAt(0).toUpperCase() + raw.slice(1);
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

function renderTodayNotifications(items) {
  if (!items.length) {
    els.todayNotifications.innerHTML = "<div class='item'>마감 임박 체크리스트가 없습니다.</div>";
    return;
  }

  els.todayNotifications.innerHTML = items
    .map(
      (x) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(x.project_name)}</strong>
          <span class="badge">D-${x.days_left}</span>
        </div>
        <div>${escapeHtml(x.content)}</div>
        <div class="item__meta">단계: ${escapeHtml(stageLabel(x.stage))} | 목표일: ${escapeHtml(x.target_date || "-")}</div>
        <div class="actions">
          <button
            type="button"
            data-open-upcoming-project="${x.project_id}"
            data-open-upcoming-checklist="${x.checklist_id}"
          >
            프로젝트 보기
          </button>
        </div>
      </div>
    `
    )
    .join("");
}

async function loadSession() {
  const me = await api.get("/api/auth/me");
  currentUser = me;
  els.userInfo.textContent = `${me.display_name} (${me.username})`;
  if (me.is_admin) els.adminLink.classList.remove("hidden");

  if (els.projectForm?.elements?.owner) {
    els.projectForm.elements.owner.value = me.username;
  }
  if (els.taskForm?.elements?.assignee) {
    els.taskForm.elements.assignee.value = me.username;
  }
}

async function loadDashboard() {
  const data = await api.get("/api/dashboard");
  els.dashboard.projects.textContent = data.projects;
  els.dashboard.active.textContent = data.active_projects;
  els.dashboard.tasks.textContent = data.tasks;
  els.dashboard.rate.textContent = `${data.completion_rate}%`;
}

async function loadTodayNotifications() {
  const items = await api.get("/api/my/checklists/upcoming?days=30");
  renderTodayNotifications(items);
}

async function loadProjects() {
  projects = await api.get("/api/projects");
  renderProjects();
  renderProjectSelect();
}

async function loadTasks() {
  const status = els.taskFilterStatus.value;
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  tasks = await api.get(`/api/tasks${query}`);
  renderTasks();
}

function renderProjectSelect() {
  if (projects.length === 0) {
    els.taskProjectSelect.innerHTML = "<option value=''>프로젝트를 먼저 생성하세요</option>";
    return;
  }

  els.taskProjectSelect.innerHTML = projects
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
}

function renderProjects() {
  if (projects.length === 0) {
    els.projectList.innerHTML = "<div class='item'>등록된 프로젝트가 없습니다.</div>";
    return;
  }

  els.projectList.innerHTML = projects
    .map(
      (p) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(p.name)}</strong>
          <span class="badge">${statusLabel(p.status)}</span>
        </div>
        <div>${escapeHtml(p.description || "-")}</div>
        <div class="item__meta">담당: ${escapeHtml(p.owner)} | 마감: ${escapeHtml(p.due_date || "-")}</div>
        <div class="actions">
          <button data-open-project="${p.id}">보드</button>
          <button class="btn-settings" data-open-project-settings="${p.id}">프로젝트 설정</button>
          <button class="danger" data-del-project="${p.id}">삭제</button>
        </div>
      </div>
    `
    )
    .join("");
}

function renderTasks() {
  if (tasks.length === 0) {
    els.taskList.innerHTML = "<div class='item'>등록된 작업이 없습니다.</div>";
    return;
  }

  els.taskList.innerHTML = tasks
    .map(
      (t) => `
      <div class="item">
        <div class="item__head">
          <strong>${escapeHtml(t.title)}</strong>
          <span class="badge">${statusLabel(t.status)}</span>
        </div>
        <div>${escapeHtml(t.description || "-")}</div>
        <div class="item__meta">
          프로젝트: ${escapeHtml(t.project_name)} | 담당: ${escapeHtml(t.assignee)} | 우선순위: ${priorityLabel(t.priority)} | 마감: ${escapeHtml(t.due_date || "-")}
        </div>
        <div class="actions">
          <button class="danger" data-del-task="${t.id}">삭제</button>
        </div>
      </div>
    `
    )
    .join("");
}

els.logoutBtn.addEventListener("click", async () => {
  await api.post("/api/auth/logout", {});
  window.location.href = "/static/login.html";
});

els.projectForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const payload = Object.fromEntries(new FormData(els.projectForm).entries());
    const owner = String(payload.owner || "").trim();
    if (!owner) {
      alert("Owner 아이디를 입력해 주세요.");
      els.projectForm.elements.owner?.focus();
      return;
    }

    if (!payload.due_date) payload.due_date = null;
    await api.post("/api/projects", payload);

    els.projectForm.reset();
    if (currentUser && els.projectForm?.elements?.owner) {
      els.projectForm.elements.owner.value = currentUser.username;
    }
    await refreshAll();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (projects.length === 0) {
      alert("프로젝트를 먼저 생성하세요.");
      return;
    }

    const payload = Object.fromEntries(new FormData(els.taskForm).entries());
    payload.project_id = Number(payload.project_id);
    if (!payload.due_date) payload.due_date = null;

    await api.post("/api/tasks", payload);

    els.taskForm.reset();
    if (currentUser && els.taskForm?.elements?.assignee) {
      els.taskForm.elements.assignee.value = currentUser.username;
    }
    await refreshAll();
  } catch (err) {
    alert(parseApiError(err));
  }
});

els.projectList.addEventListener("click", async (e) => {
  const openBtn = e.target.closest("[data-open-project]");
  if (openBtn) {
    const id = openBtn.getAttribute("data-open-project");
    window.location.href = `/static/project.html?project_id=${id}`;
    return;
  }

  const settingsBtn = e.target.closest("[data-open-project-settings]");
  if (settingsBtn) {
    const id = settingsBtn.getAttribute("data-open-project-settings");
    window.location.href = `/static/project_settings.html?project_id=${id}`;
    return;
  }

  const delBtn = e.target.closest("[data-del-project]");
  if (!delBtn) return;

  const id = delBtn.getAttribute("data-del-project");
  if (!confirm("프로젝트를 삭제하면 관련 작업도 함께 삭제됩니다. 계속할까요?")) return;

  await api.del(`/api/projects/${id}`);
  await refreshAll();
});

els.taskList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del-task]");
  if (!btn) return;

  const id = btn.getAttribute("data-del-task");
  if (!confirm("작업을 삭제할까요?")) return;

  await api.del(`/api/tasks/${id}`);
  await refreshAll();
});

els.todayNotifications.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-open-upcoming-project]");
  if (!btn) return;

  const projectId = btn.getAttribute("data-open-upcoming-project");
  const checklistId = btn.getAttribute("data-open-upcoming-checklist");
  window.location.href = `/static/project.html?project_id=${projectId}&checklist_id=${checklistId}`;
});

els.taskFilterStatus.addEventListener("change", loadTasks);

async function refreshAll() {
  await Promise.all([loadDashboard(), loadProjects(), loadTasks(), loadTodayNotifications()]);
}

Promise.resolve()
  .then(loadSession)
  .then(refreshAll)
  .catch((err) => {
    console.error(err);
    if (!String(err.message).includes("Unauthorized")) {
      alert(`오류가 발생했습니다: ${parseApiError(err)}`);
    }
  });
